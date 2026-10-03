const assert = require('node:assert/strict');
const test = require('node:test');
const { deferred, loadBrowserClass, makeBrowser, makeElectron, settle } = require('./helpers/browser-harness');

function nativeResult(domain = 'lisa.agent', extras = {}) {
    return { domain, address: '134.209.111.52', source: 'hns-doh', ...extras };
}

function loadingEvents(events) {
    return events.filter(event => event.channel === 'loading-changed');
}

test('a superseded slow resolution cannot navigate, mutate metadata, or enter history', async () => {
    const { browser, tab, webContents, history } = makeBrowser();
    const slow = deferred();
    let oldSignal;
    browser.resolveUrl = (input, options) => {
        if (input === 'slow.agent') {
            oldSignal = options.signal;
            return slow.promise;
        }
        return Promise.resolve({ url: 'https://example.shop/new', displayUrl: 'https://example.shop/new' });
    };
    const previous = browser.loadUrlInTab(tab.id, 'slow.agent');
    await browser.loadUrlInTab(tab.id, 'https://example.shop/new');
    assert.equal(oldSignal.aborted, true);
    slow.resolve({ url: 'http://slow.agent/', hnsProfile: { domain: 'slow.agent', entries: [{}] } });
    await previous;
    assert.deepEqual(webContents.calls.loadURL.map(call => call.url), ['https://example.shop/new']);
    assert.equal(tab.url, 'https://example.shop/new');
    assert.equal(tab.hnsProfile, null);
    assert.equal(history.length, 1);
    assert.equal(history[0][0], 'https://example.shop/new');
});

test('superseded loadURL completion cannot clear the newer pending navigation', async () => {
    const { browser, tab, webContents, history } = makeBrowser();
    const firstLoad = deferred();
    const secondLoad = deferred();
    const firstStarted = deferred();
    const secondStarted = deferred();
    browser.resolveUrl = async input => ({ url: input });
    webContents.loadURL = async (url, options) => {
        webContents.calls.loadURL.push({ url, options });
        (url.includes('old') ? firstStarted : secondStarted).resolve();
        await (url.includes('old') ? firstLoad : secondLoad).promise;
    };
    const old = browser.loadUrlInTab(tab.id, 'https://example.com/old');
    await firstStarted.promise;
    const next = browser.loadUrlInTab(tab.id, 'https://example.com/new');
    await secondStarted.promise;
    firstLoad.resolve();
    await old;
    assert.equal(tab.pendingLoadUrl, 'https://example.com/new');
    assert.equal(history.length, 0);
    secondLoad.resolve();
    await next;
    assert.equal(tab.url, 'https://example.com/new');
    assert.equal(history.length, 1);
});

test('Stop aborts DNS resolution immediately and prevents a late website load', async () => {
    const { browser, tab, webContents, events, history } = makeBrowser();
    const resolution = deferred();
    let signal;
    browser.resolveUrl = (_input, options) => { signal = options.signal; return resolution.promise; };
    const navigating = browser.loadUrlInTab(tab.id, 'lisa.agent');
    browser.stopTabLoading(tab.id);
    assert.equal(signal.aborted, true);
    assert.equal(tab.loading, false);
    assert.equal(tab.resolving, false);
    assert.equal(loadingEvents(events).at(-1).data.loading, false);
    resolution.resolve({ url: 'http://lisa.agent/' });
    await navigating;
    assert.equal(webContents.calls.loadURL.length, 0);
    assert.equal(history.length, 0);
});

test('closing a tab aborts its pending resolution and prevents late mutations', async () => {
    const { browser, tab, webContents, history } = makeBrowser();
    const resolution = deferred();
    let signal;
    browser.resolveUrl = (_input, options) => { signal = options.signal; return resolution.promise; };
    browser.tabs.set(2, { id: 2, view: { webContents: {} } });
    browser.switchToTab = () => {};
    const navigating = browser.loadUrlInTab(tab.id, 'lisa.agent');
    browser.closeTab(tab.id);
    assert.equal(signal.aborted, true);
    assert.equal(webContents.destroyed, true);
    resolution.resolve({ url: 'http://lisa.agent/' });
    await navigating;
    assert.equal(browser.tabs.has(tab.id), false);
    assert.equal(webContents.calls.loadURL.length, 0);
    assert.equal(history.length, 0);
});

test('a redirected HNS load retains the committed ICANN address and metadata at completion', async () => {
    const { browser, tab, webContents, history } = makeBrowser();
    browser.resolveHNS = async domain => nativeResult(domain);
    webContents.loadURL = async (url, options) => {
        webContents.calls.loadURL.push({ url, options });
        webContents.currentUrl = 'https://example.shop/landing';
        await browser.updateTabUrlFromNavigation(tab.id, webContents.currentUrl);
    };
    await browser.loadUrlInTab(tab.id, 'lisa.agent');
    assert.equal(webContents.calls.loadURL[0].url, 'http://lisa.agent/');
    assert.equal(tab.url, 'https://example.shop/landing');
    assert.equal(tab.displayUrl, 'https://example.shop/landing');
    assert.equal(tab.securityInfo, null);
    assert.equal(tab.hnsProfile, null);
    assert.equal(history[0][0], 'https://example.shop/landing');
});

test('a previous HNS commit awaiting metadata cannot overwrite a later ICANN commit', async () => {
    const { browser, tab } = makeBrowser({ tabOverrides: { url: 'lisa.agent/' } });
    const resolution = deferred();
    browser.resolveHNS = () => resolution.promise;
    const oldCommit = browser.updateTabUrlFromNavigation(tab.id, 'http://lisa.agent/');
    await browser.updateTabUrlFromNavigation(tab.id, 'https://example.com/new');
    resolution.resolve(nativeResult('lisa.agent', { hnsProfile: { domain: 'lisa.agent', entries: [{}] } }));
    await oldCommit;
    assert.equal(tab.url, 'https://example.com/new');
    assert.equal(tab.displayUrl, 'https://example.com/new');
    assert.equal(tab.securityInfo, null);
    assert.equal(tab.hnsProfile, null);
});

test('a pending address-bar resolution cannot displace a later committed browser-originated ICANN page', async () => {
    const { browser, tab, webContents, history } = makeBrowser();
    const resolution = deferred();
    browser.resolveUrl = () => resolution.promise;
    const pending = browser.loadUrlInTab(tab.id, 'slow.agent');
    webContents.currentUrl = 'https://example.shop/clicked';
    await browser.updateTabUrlFromNavigation(tab.id, webContents.currentUrl);
    resolution.resolve({ url: 'http://slow.agent/', displayUrl: 'slow.agent/' });
    await pending;
    assert.equal(tab.url, 'https://example.shop/clicked');
    assert.equal(webContents.calls.loadURL.length, 0);
    assert.equal(history.length, 0);
});

test('deferred old HNS profile cannot attach to a newer ICANN page under the same navigation token', async () => {
    const { browser, tab } = makeBrowser({ tabOverrides: { url: 'lisa.agent/' } });
    const profile = deferred();
    browser.attachDeferredProfile(tab, profile.promise, tab.navigationToken, 'lisa.agent');
    await browser.updateTabUrlFromNavigation(tab.id, 'https://example.online/new');
    profile.resolve({ domain: 'lisa.agent', entries: [{}] });
    await settle();
    assert.equal(tab.url, 'https://example.online/new');
    assert.equal(tab.hnsProfile, null);
});

test('a current native HNS profile attaches without changing its hostname or route', async () => {
    const { browser, tab, webContents } = makeBrowser();
    const profile = deferred();
    browser.resolveHNS = async domain => nativeResult(domain, { profilePromise: profile.promise });
    await browser.loadUrlInTab(tab.id, 'lisa.agent/services?view=all');
    profile.resolve({ domain: 'lisa.agent', entries: [{ label: 'Actions', value: 'published' }] });
    await settle();
    assert.equal(tab.hnsProfile.domain, 'lisa.agent');
    assert.equal(tab.url, 'lisa.agent/services?view=all');
    assert.equal(webContents.calls.loadURL[0].url, 'http://lisa.agent/services?view=all');
    assert.equal(browser.hnsHostHeaders.get('1:134.209.111.52'), 'lisa.agent');
});

test('native HNS navigation preserves normal shared-page cache reuse and original Host', async () => {
    const { browser, tab, webContents } = makeBrowser();
    browser.resolveHNS = async domain => nativeResult(domain);
    await browser.loadUrlInTab(tab.id, 'lisa.agent/path');
    await browser.loadUrlInTab(tab.id, 'lisa.agent/other');
    assert.equal(webContents.calls.clearCache, 0);
    for (const call of webContents.calls.loadURL) {
        assert.equal(new URL(call.url).hostname, 'lisa.agent');
        assert.doesNotMatch(call.options.extraHeaders || '', /no-cache/i);
    }
    assert.equal(browser.hnsProxyHosts.get('lisa.agent'), '134.209.111.52');
    assert.equal(browser.hnsHostHeaders.get('1:134.209.111.52'), 'lisa.agent');
});

test('the explicit clear-cache action still clears page and resolver caches before reloading', async () => {
    const { browser, tab, webContents } = makeBrowser({
        tabOverrides: { url: 'lisa.agent/', displayUrl: 'lisa.agent/' }
    });
    let resolverClears = 0;
    browser.hnsResolver.clearCache = () => { resolverClears += 1; };
    browser.resolveHNS = async domain => nativeResult(domain);
    browser.hnsProxyHosts.set('obsolete.agent', '192.0.2.1');
    await browser.clearCacheAndReload();
    assert.equal(resolverClears, 1);
    assert.equal(webContents.calls.clearCache, 1);
    assert.equal(browser.hnsProxyHosts.has('obsolete.agent'), false);
    assert.equal(webContents.calls.loadURL[0].url, 'http://lisa.agent/');
    assert.equal(tab.url, 'lisa.agent/');
});

test('uppercase protocols and HNS host:port inputs follow the intended native/ICANN paths', async () => {
    const { browser } = makeBrowser();
    const resolvedHosts = [];
    browser.resolveHNS = async domain => { resolvedHosts.push(domain); return nativeResult(domain); };
    const icann = await browser.resolveUrl('HTTPS://EXAMPLE.SHOP/path');
    assert.equal(icann.url, 'https://example.shop/path');
    assert.equal(resolvedHosts.length, 0);
    const hns = await browser.resolveUrl('lisa.agent:8080/path?query=1');
    assert.equal(hns.url, 'http://lisa.agent:8080/path?query=1');
    assert.equal(hns.proxyHost, 'lisa.agent');
    assert.equal(hns.hnsHostHeader, 'lisa.agent');
    const explicit = await browser.resolveUrl('HTTP://LISA.AGENT:8080/path');
    assert.equal(explicit.url, 'http://lisa.agent:8080/path');
    assert.deepEqual(resolvedHosts, ['lisa.agent', 'lisa.agent']);
});

test('direct manifest URLs and ordinary ICANN pages never invoke the HNS resolver', async () => {
    const { browser } = makeBrowser();
    browser.resolveHNS = async () => { assert.fail('ordinary URL invoked HNS resolver'); };
    for (const url of [
        'https://headlessdomains.com/manifests/lisa.agent.json',
        'https://example.shop/', 'https://example.online/', 'https://google.com/'
    ]) assert.equal((await browser.resolveUrl(url)).url, url);
});

test('normal reload keeps Chromium reload semantics while cancelling prior work', () => {
    const { browser, tab, webContents } = makeBrowser();
    const previous = tab.navigationAbortController;
    const previousToken = tab.navigationToken;
    browser.reloadTab(tab.id);
    assert.equal(previous.signal.aborted, true);
    assert.notEqual(tab.navigationToken, previousToken);
    assert.equal(tab.navigationAbortController.signal.aborted, false);
    assert.equal(webContents.calls.reload, 1);
    assert.equal(webContents.calls.loadURL.length, 0, 'reload must not turn POST pages into fresh GET loads');
});

test('reload on an internal outage page retries the native website rather than reloading status HTML', async () => {
    const { browser, tab, webContents } = makeBrowser({
        tabOverrides: { url: 'lisa.agent/', displayUrl: 'lisa.agent/' },
        webContentsOverrides: { currentUrl: 'data:text/html,temporary-status' }
    });
    browser.resolveHNS = async domain => nativeResult(domain);
    await browser.reloadTab(tab.id);
    assert.equal(webContents.calls.reload, 0);
    assert.equal(webContents.calls.loadURL[0].url, 'http://lisa.agent/');
    assert.equal(tab.url, 'lisa.agent/');
});

test('reload while resolving retries the requested URL rather than the previous committed page', async () => {
    const { browser, tab, webContents } = makeBrowser();
    const previous = deferred();
    let calls = 0;
    browser.resolveUrl = async input => {
        calls += 1;
        return calls === 1 ? previous.promise : { url: 'http://lisa.agent/', displayUrl: input };
    };
    const old = browser.loadUrlInTab(tab.id, 'lisa.agent');
    await browser.reloadTab(tab.id);
    previous.resolve({ url: 'https://example.com/old' });
    await old;
    assert.equal(tab.url, 'lisa.agent');
    assert.deepEqual(webContents.calls.loadURL.map(call => call.url), ['http://lisa.agent/']);
});

test('Back and Forward cancel pending navigation and rotate metadata identity', async () => {
    for (const direction of ['back', 'forward']) {
        const { browser, tab, webContents } = makeBrowser();
        webContents.backAvailable = true;
        webContents.forwardAvailable = true;
        const resolution = deferred();
        browser.resolveUrl = () => resolution.promise;
        const pending = browser.loadUrlInTab(tab.id, 'slow.agent');
        const previousController = tab.navigationAbortController;
        const previousToken = tab.navigationToken;
        browser.traverseTabHistory(tab.id, direction);
        assert.equal(previousController.signal.aborted, true);
        assert.notEqual(tab.navigationToken, previousToken);
        assert.equal(tab.navigationAbortController.signal.aborted, false);
        assert.equal(webContents.calls[direction === 'back' ? 'goBack' : 'goForward'], 1);
        resolution.resolve({ url: 'http://slow.agent/' });
        await pending;
        assert.equal(webContents.calls.loadURL.length, 0);
    }
});

test('a committed page stays loading until Chromium reports loading has finished', async () => {
    const { browser, tab, webContents, events } = makeBrowser();
    webContents.loading = true;
    browser.syncTabLoading(tab.id);
    await browser.updateTabUrlFromNavigation(tab.id, 'https://example.shop/');
    assert.equal(tab.loading, true);
    assert.equal(loadingEvents(events).at(-1).data.loading, true);
    webContents.loading = false;
    browser.syncTabLoading(tab.id);
    assert.equal(tab.loading, false);
    assert.equal(loadingEvents(events).at(-1).data.loading, false);
});

test('a failed load sends the finished-loading state before its error notice', async () => {
    const { browser, tab, webContents, events } = makeBrowser();
    webContents.loadURL = async () => { throw new Error('ERR_CONNECTION_REFUSED'); };
    await browser.loadUrlInTab(tab.id, 'https://example.com/');
    assert.equal(tab.loading, false);
    assert.equal(tab.resolving, false);
    assert.equal(loadingEvents(events).at(-1).data.loading, false);
    const errorIndex = events.findIndex(event => event.channel === 'loading-error');
    assert.ok(errorIndex > 0);
    assert.equal(events[errorIndex - 1].channel, 'loading-changed');
    assert.equal(events[errorIndex - 1].data.loading, false);
});

test('an expected Chromium navigation abort clears loading without displaying a failure notice', async () => {
    const { browser, tab, webContents, events } = makeBrowser();
    webContents.loadURL = async () => { throw new Error('ERR_ABORTED'); };
    await browser.loadUrlInTab(tab.id, 'https://example.com/');
    assert.equal(tab.loading, false);
    assert.equal(tab.resolving, false);
    assert.equal(loadingEvents(events).at(-1).data.loading, false);
    assert.equal(events.some(event => event.channel === 'loading-error'), false);
});

test('a late previous-site DANE availability check cannot display HTTPS actions on a newer page', async () => {
    const probe = deferred();
    const probeStarted = deferred();
    const { browser, tab, statuses } = makeBrowser({
        tabOverrides: { url: 'lisa.agent/', displayUrl: 'lisa.agent/' },
        dependencies: { './hns-tls.js': {
            inspectHnsHttpsCertificate: async () => { probeStarted.resolve(); return probe.promise; }
        } }
    });
    browser.hnsResolver.resolveTLSARecords = async () => [{ usage: 3 }];
    browser.hnsResolver.verifyDANE = async () => ({ state: 'verified' });
    browser.rememberDaneVerifiedCertificate = () => {};
    const checking = browser.checkHnsHttpsAvailability(tab.id, {
        domain: 'lisa.agent', address: '134.209.111.52', upgradeUrl: 'https://lisa.agent/'
    });
    await probeStarted.promise;
    await browser.updateTabUrlFromNavigation(tab.id, 'https://example.com/');
    probe.resolve({ ok: true, certificate: {} });
    await checking;
    assert.equal(statuses.length, 0);
    assert.equal(tab.url, 'https://example.com/');
});

test('new tabs restore Chromium background throttling and honor the JavaScript setting', async () => {
    const { browser, electron, events } = makeBrowser({ settings: { enableJavaScript: false } });
    const tabId = await browser.createNewTab('skyinclude://home');
    await settle();
    const preferences = electron.views.at(-1).options.webPreferences;
    assert.equal(preferences.backgroundThrottling, true);
    assert.equal(preferences.javascript, false);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    const contents = electron.views.at(-1).webContents;
    contents.loading = true;
    contents.emit('did-start-loading');
    assert.equal(loadingEvents(events).at(-1).data.tabId, tabId);
    assert.equal(loadingEvents(events).at(-1).data.loading, true);
    contents.loading = false;
    contents.emit('did-stop-loading');
    assert.equal(loadingEvents(events).at(-1).data.loading, false);
});

test('startup no longer disables Chromium background timer, occlusion, or renderer throttling', () => {
    const electron = makeElectron();
    const Browser = loadBrowserClass({
        electron,
        dependencies: { './async-log.js': { AsyncLogWriter: class { append() {} } } }
    });
    new Browser();
    const switches = electron.switches.map(([name]) => name.replace(/^--/, ''));
    for (const flag of [
        'disable-background-timer-throttling',
        'disable-backgrounding-occluded-windows',
        'disable-renderer-backgrounding'
    ]) assert.equal(switches.includes(flag), false, flag);
});
