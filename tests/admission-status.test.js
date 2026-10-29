const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const { makeBrowser, settle } = require('./helpers/browser-harness');
const { HNSResolver } = require('../resolver');

function socket() {
    const client = new EventEmitter();
    client.output = [];
    client.end = value => { if (value) client.output.push(value); client.writableEnded = true; };
    client.destroy = () => { client.destroyed = true; };
    return client;
}

test('CONNECT deadline retains TLSA stage/provenance and differs from client disconnect', async () => {
    for (const disconnect of [false, true]) {
        const { browser, tab, logs } = makeBrowser();
        browser.proxyConnectionTimeoutMs = 25;
        browser.hnsProxyHosts.set('handshake.mercenary', '127.0.0.1');
        tab.mainFrameNavigationPending = true;
        tab.mainFrameNavigationUrl = 'https://handshake.mercenary/ucp.php?sid=private';
        browser.inspectHnsHttpsAdmission = (_host, _address, _port, signal, _generation, _force, _revision, progress) => {
            progress({ stage: 'tlsa', resolverMetadata: { state: 'pending', attempts: [{ status: 'HTTP_403' }, { status: 'PENDING' }] } });
            return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        };
        const client = socket();
        const request = browser.handleHnsProxyConnect({ url: 'handshake.mercenary:443' }, client, Buffer.alloc(0));
        if (disconnect) client.emit('end');
        await request;
        const logged = logs.find(item => item.event === 'hns-proxy-connect-request-error').data;
        assert.equal(logged.code, disconnect ? 'CLIENT_DISCONNECTED' : 'CONNECT_TIMEOUT');
        assert.equal(logged.stage, 'tlsa');
        assert.ok(logged.elapsedMs >= 0);
        assert.doesNotMatch(JSON.stringify(logs), /sid|private/);
        assert.equal(browser.daneVerifiedCertificates.size, 0);
        if (disconnect) {
            assert.equal(browser.hnsHttpsFailures?.size || 0, 0, 'leaving a page must not poison the next navigation');
        } else {
            assert.match(client.output[0], /504/);
            assert.equal(browser.hnsHttpsFailures.get('handshake.mercenary:443').state, 'admission_timeout');
            assert.equal(tab.resolverInfo.tlsa.attempts[0].status, 'HTTP_403');
            await browser.showHnsHttpsLoadFailure(tab.id, tab.mainFrameNavigationUrl, 'ERR_TUNNEL_CONNECTION_FAILED');
            const html = decodeURIComponent(tab.view.webContents.calls.loadURL.at(-1).url);
            assert.match(html, /Native HTTPS verification timed out/);
            assert.doesNotMatch(html, /could not inspect/);
        }
    }
});

test('configured total timeout does not expand DNS/probe stages; slow primary can reach authenticated fallback', async () => {
    const { browser } = makeBrowser({ settings: { hnsTimeout: 15000 }, dependencies: {
        './hns-tls.js': { inspectHnsHttpsCertificate: async () => ({ ok: false, state: 'cert_expired' }) }
    } });
    assert.equal(browser.getDaneLookupTimeout(), 2500);
    assert.equal(browser.getDaneProbeTimeout(), 4000);
    const resolver = browser.hnsResolver = new HNSResolver();
    const calls = [];
    resolver.queryResolver = async (provider, name, type, timeout) => {
        calls.push({ provider: provider.id, timeout });
        await settle();
        if (calls.length === 1) throw Object.assign(new Error('Timed out'), { code: 'ETIMEDOUT' });
        return { rcode: 0, authenticated: true, records: [{ usage: 3, selector: 1, matchingType: 1, certificateAssociationData: 'aa'.repeat(32) }] };
    };
    const progress = [];
    const result = await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443, { onProgress: value => progress.push(value) });
    assert.equal(result.state, 'cert_expired', 'fallback DNS success never bypasses certificate verification');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.timeout === 2500));
    assert.ok(progress.some(value => value.resolverMetadata?.attempts.some(attempt => attempt.status === 'ETIMEDOUT')));
    assert.equal(progress.at(-1).stage, 'certificate-probe');
    assert.equal(browser.daneVerifiedCertificates.size, 0);
});

function rendererFixture() {
    const timers = [];
    const source = fs.readFileSync(require.resolve('../renderer.js'), 'utf8');
    const Renderer = vm.runInNewContext(`${source.split('// Initialize the renderer when DOM is loaded')[0]}\nSkyIncludeRenderer;`, {
        setTimeout: callback => timers.push(callback), document: { activeElement: null }
    });
    const renderer = Object.create(Renderer.prototype);
    const element = () => ({ classList: { add() {}, remove() {} }, value: '' });
    Object.assign(renderer, { activeTabId: 1, currentUrl: 'http://mercenary/', statusText: {},
        statusBar: element(), statusActionBtn: element(), addressBar: element(), tabs: new Map(),
        setStatusBarVisible() {}, showLoading() {}, updateTabLoadingUI() {}, navigated: [],
        navigateToUrl(url) { this.navigated.push(url); } });
    return { renderer, timers };
}

test('HTTPS action is cleared on cross-host success/failure, loading and tab switch; stale targets cannot execute', () => {
    for (const transition of ['https://skyinclude/', 'https://handshake.mercenary/', 'loading', 'tab']) {
        const { renderer } = rendererFixture();
        renderer.showStatus('Available for mercenary', 'success', { url: 'https://mercenary/' });
        if (transition === 'loading') renderer.updateLoadingState({ tabId: 1, loading: true });
        else {
            if (transition === 'tab') renderer.activeTabId = 2;
            renderer.updateAddressBar(transition === 'tab' ? renderer.currentUrl : transition);
        }
        assert.equal(renderer.currentStatusAction, null);
        renderer.handleStatusAction();
        assert.equal(renderer.navigated.length, 0);
    }
    const { renderer, timers } = rendererFixture();
    renderer.showStatus('Old notice');
    renderer.showStatus('Available', 'success', { url: 'https://mercenary/' });
    timers[0]();
    assert.ok(renderer.currentStatusAction, 'old auto-dismiss cannot dismiss a newer action');
    renderer.activeTabId = 2;
    renderer.handleStatusAction();
    assert.equal(renderer.navigated.length, 0);
    renderer.showStatus('Late action', 'success', { url: 'https://mercenary/', sourceUrl: 'http://mercenary/', tabId: 1 });
    assert.equal(renderer.currentStatusAction, null);
    renderer.activeTabId = 1;
    renderer.showStatus('Available', 'success', { url: 'https://mercenary/', statusNavigationId: 1 });
    renderer.updateTabState({ tabId: 1, statusNavigationId: 2 });
    assert.equal(renderer.currentStatusAction, null, 'same-host navigation invalidates an earlier action');
    renderer.tabs.set(1, { statusNavigationId: 2 });
    renderer.showStatus('Late same-host action', 'success', { url: 'https://mercenary/', sourceUrl: 'http://mercenary/', tabId: 1, statusNavigationId: 1 });
    assert.equal(renderer.currentStatusAction, null);
});
