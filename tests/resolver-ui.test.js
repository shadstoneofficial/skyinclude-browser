const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { HNSResolver } = require('../resolver');
const { makeBrowser, deferred } = require('./helpers/browser-harness');

const websiteProvider = { id: 'hnsdoh', name: 'HNS DoH', transport: 'doh-wire', url: 'https://hnsdoh.com/dns-query' };
const tlsProvider = { id: 'web3dns', name: 'Web3DNS', transport: 'doh-wire', url: 'https://doh.web3dns.net/' };
const metadata = (resolver, extras = {}) => ({ resolver, cacheHit: false, authenticated: true,
    resolverResolutionState: 'resolved', resolverAttempts: [{ resolver, status: 'NOERROR' }], ...extras });
const resolution = extras => ({ domain: 'handshake.mercenary', address: '127.0.0.1', ...metadata(websiteProvider), ...extras });

function browserWithTlsMetadata() {
    const fixture = makeBrowser({ dependencies: { './hns-tls.js': {
        inspectHnsHttpsCertificate: async () => ({ ok: true, certificate: {
            fingerprint256: 'ab'.repeat(32), valid_to: new Date(Date.now() + 86400000).toISOString()
        } })
    } } });
    fixture.browser.hnsResolver = new HNSResolver();
    fixture.browser.hnsResolver.resolveTLSARecords = async (_domain, options) => {
        assert.equal(options.includeMetadata, true);
        return { records: [{ usage: 3 }], ...metadata(tlsProvider) };
    };
    fixture.browser.hnsResolver.verifyDANE = async () => ({ state: 'verified' });
    return fixture;
}

test('native HTTP badge data names the actual successful fallback, not the configured first resolver', async () => {
    const { browser } = makeBrowser({ settings: { hnsResolvers: [websiteProvider, tlsProvider] } });
    const result = await browser.buildHNSNavigation('http://handshake.mercenary/', resolution({
        ...metadata(tlsProvider), resolverFallbackCount: 1,
        resolverAttempts: [{ resolver: websiteProvider, status: 'ETIMEDOUT' }, { resolver: tlsProvider, status: 'NOERROR' }]
    }));
    assert.equal(result.url, 'http://handshake.mercenary/');
    assert.equal(result.resolverInfo.website.resolver.name, 'Web3DNS');
    assert.equal(result.resolverInfo.tlsa, null);
    const detail = JSON.stringify(browser.buildResolverDetails(result.resolverInfo));
    assert.match(detail, /HNS DoH: ETIMEDOUT/);
    assert.match(detail, /Web3DNS: NOERROR/);
    assert.match(detail, /No TLSA lookup details recorded for this navigation/);
});

test('website DNS and TLSA providers remain separate through cold preflight and cached admission reuse', async () => {
    const { browser } = browserWithTlsMetadata();
    const first = await browser.buildHNSNavigation('https://handshake.mercenary:8443/page', resolution());
    const second = await browser.buildHNSNavigation('https://handshake.mercenary:8443/page', resolution({ cacheHit: true }));
    assert.equal(first.resolverInfo.website.resolver.name, 'HNS DoH');
    assert.equal(first.resolverInfo.tlsa.resolver.name, 'Web3DNS');
    assert.equal(first.resolverInfo.tlsa.cacheHit, false);
    assert.equal(second.resolverInfo.website.cacheHit, true);
    assert.equal(second.resolverInfo.tlsa.admissionCacheHit, true);
    assert.equal(first.resolverInfo.tlsa.cacheHit, false, 'cache reuse must not mutate the prior navigation snapshot');
    const details = JSON.stringify(browser.buildResolverDetails(second.resolverInfo));
    assert.match(details, /Cached DNS result/);
    assert.match(details, /Reused HTTPS check/);
    assert.match(details, /AD=true/);
});

test('AD=false TLSA failure shows unvalidated records without attributing a successful identity provider', async () => {
    const { browser } = browserWithTlsMetadata();
    browser.hnsResolver.resolveTLSARecords = async () => { throw Object.assign(new Error('private query ?token=secret'), {
        code: 'RESOLVER_FAILURE', resolverAttempts: [{ resolver: tlsProvider, status: 'DNSSEC_UNAUTHENTICATED' }], authenticated: false
    }); };
    const result = await browser.buildHNSNavigation('https://handshake.mercenary/', resolution());
    assert.equal(result.resolverInfo.website.resolver.name, 'HNS DoH');
    assert.equal(result.resolverInfo.tlsa.resolver, null);
    assert.equal(result.resolverInfo.tlsa.authenticated, false);
    const html = decodeURIComponent(result.url);
    assert.match(html, /without validated DNSSEC/);
    assert.doesNotMatch(html, /token=secret/);
    assert.match(JSON.stringify(browser.buildResolverDetails(result.resolverInfo)), /records returned, DNSSEC not validated/);
});

test('temporary outage, authoritative absence and no configured resolver have distinct explanations', () => {
    const { browser } = makeBrowser();
    const unavailable = browser.buildTemporaryHNSNavigation('http://handshake.mercenary/', {
        domain: 'handshake.mercenary', resolutionState: 'temporary-failure',
        error: { code: 'RESOLVER_COOLDOWN', attempts: [{ resolver: websiteProvider, status: 'COOLDOWN' }] }
    });
    assert.match(unavailable.securityInfo.summary, /does not mean the domain has no website/);
    assert.equal(unavailable.resolverInfo.website.resolver, null);
    const absent = browser.sanitizeResolverLookup(metadata(websiteProvider, { resolverResolutionState: 'authoritative-absence' }));
    assert.match(absent.reason, /confirmed.*absent/);
    const unconfigured = browser.buildTemporaryHNSNavigation('http://handshake.mercenary/', {
        domain: 'handshake.mercenary', resolutionState: 'temporary-failure', error: { code: 'NO_HNS_RESOLVERS' }
    });
    assert.equal(unconfigured.resolverInfo.website.notConfigured, true);
    assert.match(decodeURIComponent(unconfigured.url), /Choose an HNS resolver/);
    assert.match(unconfigured.securityInfo.summary, /Preferences/);
    assert.doesNotMatch(decodeURIComponent(unconfigured.url), /every configured.*failed/);
});

test('lookup source distinguishes cooldown, unsuccessful and unknown provenance from a fresh successful fallback', () => {
    const { browser } = makeBrowser();
    const source = value => browser.buildResolverDetails({ domain: 'handshake.mercenary',
        website: browser.sanitizeResolverLookup(value) }).find(([label]) => label === 'Website DNS: source')[1];
    assert.equal(source({ resolverResolutionState: 'temporary-failure',
        attempts: [{ resolver: websiteProvider, status: 'COOLDOWN' }, { resolver: tlsProvider, status: 'COOLDOWN' }] }),
    'No query sent; resolvers cooling down');
    assert.equal(source({ resolverResolutionState: 'temporary-failure',
        attempts: [{ resolver: websiteProvider, status: 'ETIMEDOUT' }] }), 'Lookup unsuccessful');
    assert.equal(source({}), 'Lookup source not recorded');
    assert.equal(source({ resolverResolutionState: 'resolved' }), 'Lookup source not recorded');
    assert.equal(source(metadata(tlsProvider, { resolverAttempts: [
        { resolver: websiteProvider, status: 'COOLDOWN' }, { resolver: tlsProvider, status: 'NOERROR' }
    ] })), 'Fresh lookup');
});

test('provider names are escaped and resolver query credentials never enter the popover', () => {
    const { browser } = makeBrowser();
    const lookup = browser.sanitizeResolverLookup(metadata({ name: '<img src=x onerror=alert(1)>', transport: 'dns-json',
        url: 'https://user:password@resolver.example/dns-query?token=top-secret#hidden' }));
    const info = browser.sanitizeSecurityInfo({ title: 'DNS details', details: browser.buildResolverDetails({ domain: 'handshake.mercenary', website: lookup }) });
    const html = decodeURIComponent(browser.buildSecurityPopoverDataUrl(info));
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<img|password|top-secret|token=|#hidden/);
    assert.match(html, /https:\/\/resolver.example\/dns-query/);
});

test('redirect CONNECT metadata attaches only to the captured current tab/navigation', () => {
    const { browser, tab } = makeBrowser();
    const url = 'https://handshake.mercenary:8443/thread';
    tab.mainFrameNavigationUrl = url;
    tab.mainFrameNavigationPending = true;
    tab.resolverInfo = { domain: 'handshake.mercenary', website: browser.sanitizeResolverLookup(resolution()), tlsa: null };
    const consumer = { tab, token: tab.navigationToken, url };
    const admission = { state: 'verified', resolverMetadata: browser.sanitizeResolverLookup(metadata(tlsProvider)) };
    browser.attachHnsConnectResolverMetadata([consumer], 'handshake.mercenary', 8443, admission);
    assert.equal(tab.resolverInfo.website.resolver.name, 'HNS DoH');
    assert.equal(tab.resolverInfo.tlsa.resolver.name, 'Web3DNS');
    tab.navigationToken = Symbol('new-navigation');
    tab.mainFrameNavigationUrl = 'https://example.com/';
    tab.resolverInfo = null;
    browser.attachHnsConnectResolverMetadata([consumer], 'handshake.mercenary', 8443, admission);
    assert.equal(tab.resolverInfo, null);
});

test('a failed CONNECT for a pending tab cannot repaint a loaded same-host tab or an explicit preflight snapshot', () => {
    const { browser, tab } = makeBrowser();
    const domain = 'handshake.mercenary';
    const url = `https://${domain}/`;
    const verified = browser.sanitizeResolverLookup(metadata(websiteProvider));
    tab.mainFrameNavigationUrl = url;
    tab.mainFrameNavigationPending = false;
    tab.resolverInfo = { domain, website: verified, tlsa: verified, tlsaPort: 443 };
    const original = tab.resolverInfo;
    const pending = { ...tab, id: 2, navigationToken: Symbol('second-tab-navigation'),
        navigationAbortController: new AbortController(), mainFrameNavigationPending: true,
        resolverInfo: { domain, website: verified, tlsa: null } };
    browser.tabs.set(pending.id, pending);
    const failed = { state: 'resolver_failure', resolverMetadata: browser.sanitizeResolverLookup({
        resolverResolutionState: 'temporary-failure', authenticated: false,
        resolverAttempts: [{ resolver: tlsProvider, status: 'ETIMEDOUT' }]
    }) };
    const consumers = browser.captureHnsConnectResolverConsumers(domain, 443);
    assert.equal(consumers.length, 1);
    assert.equal(consumers[0].tab, pending);
    browser.attachHnsConnectResolverMetadata(consumers, domain, 443, failed);
    assert.equal(tab.resolverInfo, original);
    assert.equal(tab.resolverInfo.tlsa.authenticated, true);
    assert.equal(pending.resolverInfo.tlsa.state, 'temporary-failure');

    pending.resolverInfo = { domain, website: verified, tlsa: verified, tlsaPort: 443, tlsaPurpose: 'identity-check' };
    browser.attachHnsConnectResolverMetadata(consumers, domain, 443, failed);
    assert.equal(pending.resolverInfo.tlsa, verified, 'an explicit preflight snapshot is not replaced by an unrelated CONNECT');
    pending.mainFrameNavigationPending = false;
    pending.resolverInfo = { domain, website: verified, tlsa: null };
    browser.attachHnsConnectResolverMetadata(consumers, domain, 443, failed);
    assert.equal(pending.resolverInfo.tlsa, null, 'a completed navigation cannot be attributed a late CONNECT result');
});

test('ambiguous concurrent same-endpoint navigations receive no inferred CONNECT provenance', () => {
    const { browser, tab } = makeBrowser();
    tab.mainFrameNavigationUrl = 'https://handshake.mercenary/';
    tab.mainFrameNavigationPending = true;
    const consumers = browser.captureHnsConnectResolverConsumers('handshake.mercenary', 443);
    const second = { ...tab, id: 2, navigationToken: Symbol('other-navigation') };
    browser.tabs.set(second.id, second);
    assert.equal(browser.captureHnsConnectResolverConsumers('handshake.mercenary', 443).length, 0);
    browser.attachHnsConnectResolverMetadata(consumers, 'handshake.mercenary', 443,
        { state: 'verified', resolverMetadata: browser.sanitizeResolverLookup(metadata(tlsProvider)) });
    assert.equal(tab.resolverInfo, undefined);
    assert.equal(second.resolverInfo, undefined);
});

test('post-commit metadata enrichment labels admission provenance as reused rather than fresh', async () => {
    const { browser, tab } = browserWithTlsMetadata();
    await browser.ensureHnsHttpsAdmission('handshake.mercenary', '127.0.0.1', 443);
    browser.resolveHNS = async () => resolution({ cacheHit: true });
    await browser.updateHNSMetadataForNavigation(tab, new URL('https://handshake.mercenary/'));
    assert.equal(tab.resolverInfo.tlsa.admissionCacheHit, true);
    assert.equal(tab.resolverInfo.tlsa.cacheHit, true);
    assert.match(JSON.stringify(browser.buildResolverDetails(tab.resolverInfo)), /Reused HTTPS check/);
});

test('a late HNS metadata lookup cannot repaint a newer ICANN page with an old resolver', async () => {
    const { browser, tab } = makeBrowser();
    const pending = deferred();
    browser.resolveHNS = () => pending.promise;
    const old = browser.updateTabUrlFromNavigation(tab.id, 'http://handshake.mercenary/');
    await browser.updateTabUrlFromNavigation(tab.id, 'https://example.com/');
    pending.resolve(resolution());
    await old;
    assert.equal(tab.resolverInfo, null);
    assert.equal(tab.url, 'https://example.com/');
});

test('same-host fresh resolution replaces old provider/address metadata while cache enrichment preserves original provenance', async () => {
    const { browser, tab } = makeBrowser();
    tab.resolverInfo = { domain: 'handshake.mercenary', websiteAddress: '127.0.0.1',
        website: browser.sanitizeResolverLookup(metadata(websiteProvider)),
        tlsa: browser.sanitizeResolverLookup(metadata(websiteProvider)), tlsaPort: 443 };
    browser.resolveHNS = async () => resolution({ cacheHit: true });
    await browser.updateHNSMetadataForNavigation(tab, new URL('https://handshake.mercenary/'));
    assert.equal(tab.resolverInfo.website.cacheHit, false, 'post-commit enrichment must not relabel fresh navigation as cached');
    browser.resolveHNS = async () => resolution({ address: '127.0.0.2', ...metadata(tlsProvider), cacheHit: false });
    await browser.updateHNSMetadataForNavigation(tab, new URL('https://handshake.mercenary/'));
    assert.equal(tab.resolverInfo.website.resolver.name, 'Web3DNS');
    assert.equal(tab.resolverInfo.websiteAddress, '127.0.0.2');
    assert.equal(tab.resolverInfo.tlsa, null, 'a different endpoint must not inherit old TLSA provenance');
});

test('HTTPS failure never borrows another hostname or port TLSA provider', async () => {
    for (const [domain, port] of [['other.agent', 8443], ['handshake.mercenary', 443]]) {
        const { browser, tab } = makeBrowser();
        tab.mainFrameNavigationUrl = 'https://handshake.mercenary:8443/failed';
        tab.resolverInfo = { domain, website: browser.sanitizeResolverLookup(metadata(websiteProvider)),
            tlsa: browser.sanitizeResolverLookup(metadata(tlsProvider)), tlsaPort: port };
        await browser.showHnsHttpsLoadFailure(tab.id, tab.mainFrameNavigationUrl, 'TLS failed');
        assert.equal(tab.resolverInfo.domain, 'handshake.mercenary');
        assert.equal(tab.resolverInfo.tlsa, null);
        if (domain !== 'handshake.mercenary') assert.equal(tab.resolverInfo.website, null);
    }
});

function rendererFixture() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8').split('// Initialize the renderer when DOM is loaded')[0];
    const Renderer = vm.runInNewContext(`${source}\nSkyIncludeRenderer;`, { console });
    const renderer = Object.create(Renderer.prototype);
    const classes = new Set(['hidden']);
    renderer.resolverBadge = { textContent: '', title: '', classList: { add: name => classes.add(name), remove: name => classes.delete(name) }, setAttribute() {} };
    Object.defineProperty(renderer.resolverBadge, 'innerHTML', { set() { throw new Error('Untrusted provider text must never use innerHTML'); } });
    renderer.tabs = new Map([[1, { url: 'handshake.mercenary/' }], [2, { url: 'other.agent/' }]]);
    renderer.activeTabId = 1;
    renderer.tabsContainer = { querySelector: () => null };
    for (const method of ['updateAddressBar', 'updateNavigationButtons', 'showLoading', 'updateSecurityIndicator', 'updateHostingIndicator', 'updateHnsProfileIndicator', 'focusAddressBar', 'updateTabLoadingUI']) renderer[method] = () => {};
    return { renderer, classes };
}

test('resolver badge is persistent per active tab, inert to provider HTML, and cleared for loading/home/ICANN', () => {
    const { browser } = makeBrowser();
    const { renderer, classes } = rendererFixture();
    const info = { domain: 'handshake.mercenary', website: browser.sanitizeResolverLookup(metadata(tlsProvider)) };
    renderer.updateUI({ tabId: 1, url: 'handshake.mercenary/', resolverInfo: info });
    assert.equal(renderer.resolverBadge.textContent, 'DNS: Web3DNS');
    renderer.updateTabState({ tabId: 2, resolverInfo: { domain: 'other.agent', website: { resolver: { name: '<img onerror=1>' } } } });
    assert.equal(renderer.resolverBadge.textContent, 'DNS: Web3DNS');
    renderer.updateUI({ tabId: 2, url: 'other.agent/', resolverInfo: renderer.tabs.get(2).resolverInfo });
    assert.equal(renderer.resolverBadge.textContent, 'DNS: <img onerror=1>');
    renderer.updateLoadingState({ tabId: 2, loading: true, resolverInfo: null });
    assert.equal(classes.has('hidden'), true);
    for (const url of ['skyinclude://home', 'https://example.com/']) {
        renderer.updateUI({ tabId: 1, url, resolverInfo: null });
        assert.equal(classes.has('hidden'), true);
    }
});

test('Preferences preserve disabled resolver entries and empty lists, and display migration notices as text', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'settings-ui.html'), 'utf8');
    const functions = source.slice(source.indexOf('function populateSettings('), source.indexOf('// Save settings'));
    const elements = new Map();
    const document = { getElementById: id => {
        if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: false });
        return elements.get(id);
    } };
    const api = vm.runInNewContext(`${functions}\n({ formatResolverSetting, parseResolverSetting, populateSettings });`, { document });
    const line = api.formatResolverSetting({ transport: 'doh-wire', url: 'https://custom.example/dns-query', enabled: false });
    assert.equal(line, 'disabled doh-wire https://custom.example/dns-query');
    assert.equal(api.parseResolverSetting(line).enabled, false);
    api.populateSettings({ hnsResolvers: [], hnsResolverRetirementNotice: {
        title: 'Shakestation retired', message: '<script>not executable</script>', requiresResolverSelection: true
    } });
    assert.equal(elements.get('hnsResolvers').value, '');
    assert.equal(elements.get('resolver-retirement-notice').hidden, false);
    assert.match(elements.get('resolver-retirement-message').textContent, /Choose and save an active resolver/);
    assert.match(source, /built-in providers are HNS DoH and Web3DNS/);
});
