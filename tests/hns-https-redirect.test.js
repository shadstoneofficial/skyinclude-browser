const assert = require('node:assert/strict');
const test = require('node:test');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { once } = require('node:events');
const { HNSResolver } = require('../resolver');
const { makeBrowser, deferred, settle } = require('./helpers/browser-harness');

function fakeAdmissionBrowser() {
    let probes = 0;
    const certificate = { fingerprint256: 'aa'.repeat(32), valid_to: new Date(Date.now() + 86400000).toISOString() };
    const state = makeBrowser({ dependencies: { './hns-tls.js': {
        inspectHnsHttpsCertificate: async () => { probes += 1; return { ok: true, certificate }; }
    } } });
    state.browser.hnsResolver = new HNSResolver();
    state.browser.hnsResolver.resolveTLSARecords = async () => [{ usage: 3 }];
    state.browser.hnsResolver.verifyDANE = async () => ({ state: 'verified' });
    return { ...state, certificate, probes: () => probes };
}

test('cold HTTPS admission uses the exact endpoint, deduplicates callers and only caches successful trust', async () => {
    const { browser, probes } = fakeAdmissionBrowser();
    let queries = 0;
    const records = deferred();
    browser.hnsResolver.resolveTLSARecords = async (domain, options) => {
        queries += 1;
        assert.equal(domain, 'handshake.mercenary');
        assert.equal(options.port, 8443);
        assert.equal(options.signal.aborted, false);
        return records.promise;
    };
    const first = browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 8443);
    const second = browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 8443);
    records.resolve([{ usage: 3 }]);
    assert.equal((await first).state, 'verified');
    assert.equal((await second).state, 'verified');
    assert.equal(queries, 1);
    assert.equal(probes(), 1);
    await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 8443);
    assert.equal(queries, 1);
    assert.equal(browser.getActiveDaneTrust('handshake.mercenary', { port: 443 }), null);
    assert.equal(browser.getActiveDaneTrust('handshake.mercenary', { port: 8443, address: '127.0.0.2' }), null);
    browser.hnsResolver.clearCache();
    assert.equal(browser.getActiveDaneTrust('handshake.mercenary', { port: 8443 }), null);
});

test('temporary DNS failure is not admission or negative cache; the next attempt recovers', async () => {
    const { browser, probes } = fakeAdmissionBrowser();
    let queries = 0;
    browser.hnsResolver.resolveTLSARecords = async () => {
        if (++queries === 1) throw new Error('resolver timeout');
        return [{ usage: 3 }];
    };
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1')).state, 'resolver_failure');
    assert.equal(browser.daneVerifiedCertificates.size, 0);
    assert.equal(probes(), 0);
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1')).state, 'verified');
    assert.equal(queries, 2);
});

test('absent, unsupported, expired and mismatching TLSA never grant certificate trust', async () => {
    for (const state of ['no_tlsa', 'unsupported_record', 'cert_expired', 'tlsa_mismatch']) {
        const { browser, certificate } = fakeAdmissionBrowser();
        browser.hnsResolver.resolveTLSARecords = async () => state === 'no_tlsa' ? [] : [{ usage: 3 }];
        browser.hnsResolver.verifyDANE = async () => ({ state });
        assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1')).state, state);
        assert.equal(browser.isDaneVerifiedCertificateAllowed('handshake.mercenary', certificate), false);
    }
});

test('cancelling one admission consumer preserves another; cancelling all stops TLSA work', async () => {
    const { browser } = fakeAdmissionBrowser();
    const recordResult = deferred();
    let sharedSignal;
    browser.hnsResolver.resolveTLSARecords = (_domain, { signal }) => {
        sharedSignal = signal;
        return recordResult.promise;
    };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443, { signal: firstController.signal });
    const second = browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443, { signal: secondController.signal });
    firstController.abort();
    await assert.rejects(first, { name: 'AbortError' });
    assert.equal(sharedSignal.aborted, false);
    secondController.abort();
    await assert.rejects(second, { name: 'AbortError' });
    assert.equal(sharedSignal.aborted, true);
    recordResult.resolve([{ usage: 3 }]);
    await settle();
    assert.equal(browser.daneVerifiedCertificates.size, 0);
});

test('certificate callback accepts only the exact HNS fingerprint and preserves ICANN validation', () => {
    const { browser, certificate } = fakeAdmissionBrowser();
    browser.certificateVerifierConfiguredSessions = new WeakSet();
    browser.rememberDaneVerifiedCertificate('handshake.mercenary', certificate, { port: 8443, address: '127.0.0.1' });
    let verify;
    browser.configureDaneCertificateVerifierForSession({ setCertificateVerifyProc: callback => { verify = callback; } });
    const result = (hostname, cert, errorCode = -202) => {
        let answer;
        verify({ hostname, certificate: cert, errorCode }, value => { answer = value; });
        return answer;
    };
    assert.equal(result('handshake.mercenary', certificate), 0);
    assert.equal(result('handshake.mercenary', { fingerprint256: 'bb'.repeat(32) }), -2);
    assert.equal(result('handshake.mercenary', { fingerprint256: 'bb'.repeat(32) }, 0), -2);
    assert.equal(result('other.mercenary', certificate), -2);
    assert.equal(result('example.com', certificate), -2);
    assert.equal(result('example.com', {}, 0), 0);
});

test('changing resolver settings during a preflight cannot admit an old TLSA answer', async () => {
    const { browser } = fakeAdmissionBrowser();
    const records = deferred();
    browser.hnsResolver.resolveTLSARecords = async () => records.promise;
    const admission = browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1');
    browser.hnsResolver.clearCache();
    records.resolve([{ usage: 3 }]);
    assert.equal((await admission).state, 'resolver_failure');
    assert.equal(browser.daneVerifiedCertificates.size, 0);
});

test('one immutable SHA256 hostname pin prevents cross-port verifier-cache certificate substitution', async () => {
    const { browser, certificate } = fakeAdmissionBrowser();
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443)).state, 'verified');
    certificate.fingerprint256 = 'bb'.repeat(32);
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 8443)).state, 'certificate_changed');
    assert.equal(browser.getActiveDaneTrust('handshake.mercenary', { port: 8443 }), null);
    assert.equal(browser.isDaneVerifiedCertificateAllowed('handshake.mercenary', certificate), false);
    assert.equal(browser.daneCertificatePins.get('handshake.mercenary'), 'aa'.repeat(32));
    browser.hnsResolver.clearCache();
    browser.daneVerifiedCertificates.clear();
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443)).state, 'certificate_changed');
    certificate.fingerprint256 = 'aa'.repeat(32);
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 8443)).state, 'verified');
});

test('explicit Retry re-probes even an active admission and detects a rotated certificate', async () => {
    const { browser, certificate, probes } = fakeAdmissionBrowser();
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1')).state, 'verified');
    certificate.fingerprint256 = 'bb'.repeat(32);
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443, { forceTLSA: true })).state, 'certificate_changed');
    assert.equal(probes(), 2);
    assert.equal(browser.daneCertificatePins.get('handshake.mercenary'), 'aa'.repeat(32));
});

test('a failed forced verification removes old endpoint trust but retains the process certificate pin', async () => {
    for (const state of ['no_tlsa', 'tlsa_mismatch']) {
        const { browser } = fakeAdmissionBrowser();
        assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1')).state, 'verified');
        browser.hnsResolver.resolveTLSARecords = async () => state === 'no_tlsa' ? [] : [{ usage: 3 }];
        browser.hnsResolver.verifyDANE = async () => ({ state });
        assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443, { forceTLSA: true })).state, state);
        assert.equal(browser.getActiveDaneTrust('handshake.mercenary'), null);
        assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1')).state, state);
        assert.equal(browser.daneCertificatePins.get('handshake.mercenary'), 'aa'.repeat(32));
    }
});

test('an old preflight cannot restore invalidated trust and normal consumers join the forced refresh', async () => {
    const { browser } = fakeAdmissionBrowser();
    const oldAnswer = deferred();
    const freshAnswer = deferred();
    let queries = 0;
    browser.hnsResolver.resolveTLSARecords = async (_domain, { force }) => {
        queries += 1;
        return force ? freshAnswer.promise : oldAnswer.promise;
    };
    const old = browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1');
    const refreshed = browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443, { forceTLSA: true });
    const normal = browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1');
    oldAnswer.resolve([{ usage: 3 }]);
    assert.equal((await old).state, 'resolver_failure');
    assert.equal(browser.daneVerifiedCertificates.size, 0);
    freshAnswer.resolve([]);
    assert.equal((await refreshed).state, 'no_tlsa');
    assert.equal((await normal).state, 'no_tlsa');
    assert.equal(queries, 2);
    assert.equal(browser.daneVerifiedCertificates.size, 0);
});

test('forced TLSA service refresh invalidates every address for that port but preserves other services', async () => {
    const { browser } = fakeAdmissionBrowser();
    await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443);
    await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.2', 443);
    await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 8443);
    browser.hnsResolver.resolveTLSARecords = async (_domain, { port }) => port === 443 ? [] : [{ usage: 3 }];
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443, { forceTLSA: true })).state, 'no_tlsa');
    assert.equal(browser.getActiveDaneTrust('handshake.mercenary', { port: 443, address: '127.0.0.2' }), null);
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.2', 443)).state, 'no_tlsa');
    assert.ok(browser.getActiveDaneTrust('handshake.mercenary', { port: 8443, address: '127.0.0.1' }));
});

test('recreating the browser instance cannot reset a certificate pin while defaultSession survives', async () => {
    const { browser, certificate } = fakeAdmissionBrowser();
    assert.equal((await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1')).state, 'verified');
    const recreated = Object.assign(Object.create(Object.getPrototypeOf(browser)), browser, {
        daneVerifiedCertificates: new Map(), pendingDaneAdmissions: new Map()
    });
    delete recreated.daneCertificatePins;
    certificate.fingerprint256 = 'bb'.repeat(32);
    assert.equal((await recreated.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1')).state, 'certificate_changed');
    assert.equal(recreated.isDaneVerifiedCertificateAllowed('handshake.mercenary', certificate), false);
    assert.equal(recreated.daneVerifiedCertificates.size, 0);
    assert.equal(browser.daneCertificatePins.get('handshake.mercenary'), 'aa'.repeat(32));
});

test('SHA1-only certificate metadata cannot enter the immutable hostname pin', () => {
    const { browser } = fakeAdmissionBrowser();
    const certificate = { fingerprint: 'ab'.repeat(20), valid_to: new Date(Date.now() + 86400000).toISOString() };
    assert.equal(browser.rememberDaneVerifiedCertificate('handshake.mercenary', certificate), null);
    assert.equal(browser.isDaneVerifiedCertificateAllowed('handshake.mercenary', certificate), false);
});

test('explicit status-page Retry asks the TLSA resolver to bypass its temporary cooldown', async () => {
    const { browser, tab, webContents } = fakeAdmissionBrowser();
    const url = 'https://handshake.mercenary:8443/path?q=1';
    browser.hnsResolver = new HNSResolver({ getSetting: key => key === 'hnsResolvers'
        ? [{ id: 'fixture', transport: 'doh-wire', url: 'https://resolver.invalid/dns-query' }] : null });
    browser.resolveHNS = async () => ({ domain: 'handshake.mercenary', address: '127.0.0.1' });
    let queries = 0;
    browser.hnsResolver.queryResolver = async () => {
        if (++queries === 1) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        return { records: [{ usage: 3, selector: 1, matchingType: 1, certificateAssociationData: 'aa'.repeat(32) }],
            authenticated: true, rcode: 0, rcodeName: 'NOERROR' };
    };
    browser.hnsResolver.verifyDANE = async () => ({ state: 'verified' });
    await browser.loadUrlInTab(tab.id, url);
    assert.equal(tab.hnsHttpsStatusUrl, url);
    assert.match(webContents.getURL(), /^data:/);
    await assert.rejects(browser.hnsResolver.resolveTLSARecords('handshake.mercenary', { port: 8443 }), { code: 'RESOLVER_COOLDOWN' });
    assert.equal(queries, 1);
    await browser.reloadTab(tab.id);
    assert.equal(queries, 2);
    assert.equal(webContents.calls.loadURL.at(-1).url, url);
});

test('an arbitrary data page cannot request forced TLSA refresh', async () => {
    const { browser, tab, webContents } = fakeAdmissionBrowser();
    tab.url = 'https://handshake.mercenary/';
    webContents.currentUrl = 'data:text/html,untrusted';
    let force;
    browser.resolveUrl = async (_url, options) => { force = options.forceTLSA; return { url: 'https://example.com/' }; };
    await browser.loadUrlInTab(tab.id, tab.url);
    assert.equal(force, false);
});

test('first explicit website-outage Retry or Reload recovers during resolver cooldown with the original URL intact', async () => {
    for (const [action, url] of [['retry', 'http://handshake.mercenary:8080/thread?q=1#reply'],
        ['reload', 'https://handshake.mercenary:8443/thread?q=1#reply']]) {
        const { browser, tab, webContents } = fakeAdmissionBrowser();
        browser.hnsResolver = new HNSResolver({ getSetting: key => key === 'hnsResolvers'
            ? [{ id: 'fixture', transport: 'doh-wire', url: 'https://resolver.invalid/dns-query' }] : null });
        browser.ensureHnsHttpsAdmission = async () => ({ state: 'verified' });
        let down = true;
        let addressQueries = 0;
        browser.hnsResolver.queryResolver = async (_resolver, _domain, type) => {
            if (type === 'A') addressQueries += 1;
            if (down) throw Object.assign(new Error('resolver timeout'), { code: 'ETIMEDOUT' });
            return { records: type === 'A' ? ['127.0.0.1'] : [], rcode: 0, rcodeName: 'NOERROR' };
        };
        await browser.loadUrlInTab(tab.id, url);
        assert.equal(tab.hnsTemporaryStatus.url, url);
        assert.equal(tab.hnsTemporaryStatus.documentUrl, webContents.getURL());
        assert.match(decodeURIComponent(webContents.getURL()), /Native website temporarily unavailable/);
        assert.equal(addressQueries, 1);
        down = false;
        assert.equal((await browser.hnsResolver.resolveHNSDomain('handshake.mercenary')).resolutionState, 'temporary-failure');
        assert.equal(addressQueries, 1, 'ordinary navigation still honors cooldown');
        if (action === 'reload') await browser.reloadTab(tab.id);
        else await browser.loadUrlInTab(tab.id, tab.hnsTemporaryStatus.url);
        assert.equal(addressQueries, 2, 'the first explicit retry must query the recovered resolver immediately');
        assert.equal(webContents.getURL(), url, 'scheme, port, path, query and fragment survive Retry/Reload');
        assert.equal(tab.hnsTemporaryStatus, null);
    }
});

test('other links and unrelated data documents cannot bypass website resolver cooldown', async () => {
    for (const mode of ['other-link', 'other-document']) {
        const { browser, tab, webContents } = fakeAdmissionBrowser();
        const status = browser.buildTemporaryHNSNavigation('http://handshake.mercenary:8080/page', {
            domain: 'handshake.mercenary', resolutionState: 'temporary-failure'
        });
        tab.url = status.displayUrl;
        tab.hnsTemporaryStatus = status.hnsTemporaryStatus;
        webContents.currentUrl = mode === 'other-document' ? 'data:text/html,untrusted' : status.url;
        let bypass;
        browser.resolveUrl = async (_url, options) => { bypass = options.ignoreCooldown; return { url: 'https://example.com/' }; };
        await browser.loadUrlInTab(tab.id, mode === 'other-link' ? 'http://other.agent/' : tab.url);
        assert.equal(bypass, false);
    }
});

test('same-native-site form navigations stay in Chromium while first/cross-host/status/gateway navigation retains resolution', async () => {
    const { browser, electron } = fakeAdmissionBrowser();
    const loads = [];
    browser.loadUrlInTab = async (_id, url) => { loads.push(url); };
    const tabId = await browser.createNewTab('skyinclude://home');
    const contents = electron.views.at(-1).webContents;
    loads.length = 0;
    browser.hnsProxyHosts.set('handshake.mercenary', '127.0.0.1');
    contents.currentUrl = 'http://handshake.mercenary/form';
    let prevented = 0;
    const event = { preventDefault: () => { prevented += 1; } };
    for (const target of ['http://handshake.mercenary/redirect/307', 'https://handshake.mercenary:8443/redirect/308']) {
        contents.emit('will-navigate', event, target);
    }
    assert.equal(prevented, 0);
    assert.deepEqual(loads, [], 'loadURL must not reconstruct same-site POST as GET');
    const redirect = 'https://handshake.mercenary:8443/submitted?kept=1';
    contents.emit('will-redirect', event, redirect, false, true);
    assert.equal(browser.tabs.get(tabId).mainFrameNavigationUrl, redirect);
    assert.equal(prevented, 0, '307/308 redirects are tracked, not cancelled');
    for (const target of ['https://other.agent/', 'http://handshake.mercenary.hns.to/']) {
        contents.emit('will-navigate', event, target);
    }
    contents.currentUrl = 'data:text/html,internal-status';
    contents.emit('will-navigate', event, 'https://handshake.mercenary/');
    contents.currentUrl = 'http://handshake.mercenary/form';
    browser.hnsProxyHosts.clear();
    contents.emit('will-navigate', event, 'https://handshake.mercenary/first');
    assert.equal(prevented, 4);
    assert.deepEqual(loads, ['https://other.agent/', 'http://handshake.mercenary.hns.to/',
        'https://handshake.mercenary/', 'https://handshake.mercenary/first']);
});

test('late homepage abort attached to current loadURL promise cannot replace a verified HTTPS document', async () => {
    const { browser, tab, webContents, events } = fakeAdmissionBrowser();
    const target = 'https://handshake.mercenary/native?q=1';
    browser.resolveUrl = async () => ({ url: target, displayUrl: target,
        securityInfo: browser.buildSecurityInfo('hns-dane', { domain: 'handshake.mercenary', state: 'verified' }) });
    webContents.loadURL = async url => {
        webContents.calls.loadURL.push({ url });
        webContents.currentUrl = url;
        throw Object.assign(new Error(" (-3) loading 'file:///fixture/announcement.html'"), { code: '', errno: -3 });
    };
    await browser.loadUrlInTab(tab.id, target);
    assert.equal(webContents.calls.loadURL.length, 1);
    assert.equal(webContents.getURL(), target);
    assert.equal(tab.url, target);
    assert.equal(tab.securityInfo.level, 'hns-dane');
    assert.equal(events.some(event => event.channel === 'loading-error'), false);
});

test('numeric Chromium aborted navigation errors never produce an HTTPS failure page', async () => {
    const { browser, tab, webContents, events } = fakeAdmissionBrowser();
    const target = 'https://handshake.mercenary/';
    browser.resolveUrl = async () => ({ url: target });
    webContents.loadURL = async url => {
        webContents.calls.loadURL.push({ url });
        throw Object.assign(new Error(` (-3) loading '${url}'`), { code: '', errno: -3 });
    };
    await browser.loadUrlInTab(tab.id, target);
    assert.equal(webContents.calls.loadURL.length, 1);
    assert.equal(tab.loading, false);
    assert.equal(events.some(event => event.channel === 'loading-error'), false);
});

test('CONNECT never forwards early TLS bytes after failed admission and a later attempt can recover', { timeout: 5000 }, async t => {
    const { browser } = fakeAdmissionBrowser();
    const received = [];
    const upstreamPort = await listen(t, net.createServer(socket => {
        socket.on('data', bytes => { received.push(bytes.toString()); socket.end('echo'); });
    }));
    browser.hnsProxyHosts.set('handshake.mercenary', '127.0.0.1');
    browser.proxyConnectionTimeoutMs = 1000;
    browser.hnsResolver.resolveTLSARecords = async () => { throw new Error('resolver outage'); };
    const proxyServer = http.createServer();
    proxyServer.on('connect', (req, socket, head) => browser.handleHnsProxyConnect(req, socket, head));
    const proxyPort = await listen(t, proxyServer);
    const blocked = net.connect(proxyPort, '127.0.0.1');
    t.after(() => blocked.destroy());
    await once(blocked, 'connect');
    blocked.write(`CONNECT handshake.mercenary:${upstreamPort} HTTP/1.1\r\nHost: handshake.mercenary\r\n\r\nearly-tls`);
    const [response] = await once(blocked, 'data');
    assert.match(response.toString(), /^HTTP\/1.1 502/);
    assert.deepEqual(received, []);
    assert.equal(browser.daneVerifiedCertificates.size, 0);
    browser.hnsResolver.resolveTLSARecords = async () => [{ usage: 3 }];
    const recovered = await tunnel(proxyPort, `handshake.mercenary:${upstreamPort}`);
    t.after(() => recovered.destroy());
    recovered.write('admitted-tls');
    await once(recovered, 'data');
    assert.deepEqual(received, ['admitted-tls']);
    assert.equal(browser.hnsHttpsFailures.size, 0);
});

test('failed main-frame HTTPS redirect gets a retryable native status page; stale failures cannot replace a new page', async () => {
    const { browser, tab, webContents } = fakeAdmissionBrowser();
    const failedUrl = 'https://handshake.mercenary:8443/viewtopic.php?t=280';
    tab.mainFrameNavigationUrl = failedUrl;
    browser.hnsHttpsFailures = new Map([['handshake.mercenary:8443', {
        state: 'resolver_failure', error: 'temporary <resolver> error', timestamp: Date.now()
    }]]);
    assert.equal(await browser.showHnsHttpsLoadFailure(tab.id, failedUrl, 'ERR_TUNNEL_CONNECTION_FAILED'), true);
    const html = decodeURIComponent(webContents.calls.loadURL.at(-1).url.split(',')[1]);
    assert.match(html, /Native HTTPS temporarily unavailable/);
    assert.match(html, /Retry HTTPS/);
    assert.match(html, /temporary &lt;resolver&gt; error/);
    assert.equal(tab.url, failedUrl);
    assert.match(JSON.stringify(tab.securityInfo), /_8443\._tcp\.handshake\.mercenary/);
    tab.mainFrameNavigationUrl = 'https://example.com/';
    assert.equal(await browser.showHnsHttpsLoadFailure(tab.id, failedUrl, 'late failure'), false);
    assert.equal(webContents.calls.loadURL.length, 1);
});

// Generate a short-lived self-signed fixture in memory. No OpenSSL command,
// checked-in private key or certificate-expiry dependency is needed on CI.
function tlsFixture(domain) {
    const der = (tag, ...parts) => {
        const bytes = Buffer.concat(parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(part)));
        let length = Buffer.from([bytes.length]);
        if (bytes.length >= 128) {
            const hex = bytes.length.toString(16).padStart(Math.ceil(bytes.length.toString(16).length / 2) * 2, '0');
            const encoded = Buffer.from(hex, 'hex');
            length = Buffer.concat([Buffer.from([128 + encoded.length]), encoded]);
        }
        return Buffer.concat([Buffer.from([tag]), length, bytes]);
    };
    const seq = (...parts) => der(0x30, ...parts);
    const algorithm = seq(der(6, Buffer.from('2a864886f70d01010b', 'hex')), der(5, Buffer.alloc(0)));
    const name = seq(der(0x31, seq(der(6, Buffer.from('550403', 'hex')), der(0x0c, domain))));
    const date = offset => new Date(Date.now() + offset).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '').slice(2);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const tbs = seq(der(2, Buffer.from([1])), algorithm, name,
        seq(der(0x17, date(-86400000)), der(0x17, date(86400000))), name,
        publicKey.export({ format: 'der', type: 'spki' }));
    const raw = seq(tbs, algorithm, der(3, Buffer.from([0]), crypto.sign('sha256', tbs, privateKey)));
    return {
        key: privateKey.export({ format: 'pem', type: 'pkcs8' }),
        cert: `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`,
        hash: crypto.createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex')
    };
}

async function listen(t, server) {
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
    return server.address().port;
}

async function tunnel(port, target) {
    const client = net.connect(port, '127.0.0.1');
    await once(client, 'connect');
    client.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    const [response] = await once(client, 'data');
    assert.match(response.toString(), /^HTTP\/1.1 200/);
    return client;
}

test('real native HTTPS tunnel admits cold 301/307/308 redirects and preserves SNI, Host, method, body, path and query', { timeout: 10000 }, async t => {
    const fixture = tlsFixture('handshake.mercenary');
    const received = [];
    const securePort = await listen(t, https.createServer(fixture, (req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            received.push({ sni: req.socket.servername, host: req.headers.host, method: req.method, url: req.url, body });
            res.end('upgraded native website');
        });
    }));
    let status = 301;
    const httpPort = await listen(t, http.createServer((_req, res) => {
        res.writeHead(status, { Location: `https://handshake.mercenary:${securePort}/viewtopic.php?t=280` });
        res.end();
    }));
    const { browser } = makeBrowser();
    browser.hnsResolver = new HNSResolver();
    browser.hnsResolver.resolveTLSARecords = async (_domain, options) => {
        assert.equal(options.port, securePort);
        return [{ usage: 3, selector: 1, matchingType: 1, certificateAssociationData: fixture.hash }];
    };
    browser.hnsProxyHosts.set('handshake.mercenary', '127.0.0.1');
    browser.proxyConnectionTimeoutMs = 5000;
    browser.proxyIdleTimeoutMs = 5000;
    const proxyServer = http.createServer((req, res) => browser.handleHnsProxyRequest(req, res));
    proxyServer.on('connect', (req, socket, head) => browser.handleHnsProxyConnect(req, socket, head));
    const proxyPort = await listen(t, proxyServer);
    for (status of [301, 307, 308]) {
        browser.daneVerifiedCertificates.clear();
        const method = status === 301 ? 'GET' : 'POST';
        const body = method === 'POST' ? `inert-body-${status}` : '';
        const redirect = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: proxyPort,
                path: `http://handshake.mercenary:${httpPort}/start`, method }, res => { res.resume(); res.once('end', () => resolve(res)); });
            req.on('error', reject);
            req.end(body);
        });
        assert.equal(redirect.statusCode, status);
        const target = new URL(redirect.headers.location);
        const socket = await tunnel(proxyPort, target.host);
        const secure = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false });
        await once(secure, 'secureConnect');
        assert.equal(browser.isDaneVerifiedCertificateAllowed(target.hostname, secure.getPeerCertificate()), true);
        secure.write(`${method} ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        let response = '';
        secure.on('data', chunk => { response += chunk; });
        await once(secure, 'end');
        assert.match(response, /upgraded native website/);
        assert.deepEqual(received.at(-1), { sni: 'handshake.mercenary', host: target.host, method,
            url: '/viewtopic.php?t=280', body });
    }
    assert.equal(received.length, 3, 'certificate probes must never replay an HTTP request');
    // Simulate the five-minute admission expiring before a same-host link or
    // form opens a fresh CONNECT. Neither path may reconstruct/replay a body.
    for (const method of ['GET', 'POST']) {
        for (const trust of browser.daneVerifiedCertificates.values()) trust.expiresAt = Date.now() - 1;
        assert.equal(browser.getActiveDaneTrust('handshake.mercenary', { address: '127.0.0.1', port: securePort }), null);
        const socket = await tunnel(proxyPort, `handshake.mercenary:${securePort}`);
        const secure = tls.connect({ socket, servername: 'handshake.mercenary', rejectUnauthorized: false });
        await once(secure, 'secureConnect');
        assert.equal(browser.isDaneVerifiedCertificateAllowed('handshake.mercenary', secure.getPeerCertificate()), true);
        const body = method === 'POST' ? 'inert=expiry-regression' : '';
        secure.write(`${method} /ucp.php?mode=login HTTP/1.1\r\nHost: handshake.mercenary:${securePort}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        secure.resume();
        await once(secure, 'end');
        assert.deepEqual(received.at(-1), { sni: 'handshake.mercenary', host: `handshake.mercenary:${securePort}`,
            method, url: '/ucp.php?mode=login', body });
    }
    assert.equal(received.length, 5, 'exactly one request per expired-trust link/form navigation');
});
