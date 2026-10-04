const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { deferred } = require('./helpers/browser-harness');

function fixture() {
    const elements = new Map();
    const timers = [];
    const navigations = [];
    const document = {
        activeElement: null,
        listeners: new Map(),
        addEventListener(type, listener) { this.listeners.set(type, listener); },
        querySelectorAll: () => [],
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, {
                value: '', selections: 0, listeners: new Map(),
                addEventListener(type, listener) { this.listeners.set(type, listener); },
                focus() {
                    if (document.activeElement === this) return;
                    document.activeElement = this;
                    this.listeners.get('focus')?.({});
                },
                blur() { document.activeElement = null; this.listeners.get('blur')?.({}); },
                select() { this.selections += 1; },
                querySelector: () => null
            });
            return elements.get(id);
        }
    };
    const api = { navigateTo: async payload => { navigations.push(payload); } };
    const source = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    const Renderer = vm.runInNewContext(`${source.split('// Initialize the renderer when DOM is loaded')[0]}\nSkyIncludeRenderer;`, {
        document, window: { electronAPI: api }, console, setTimeout: callback => timers.push(callback)
    });
    // Exercise the real constructor, address listeners and update methods without Electron or a profile.
    Renderer.prototype.setupIpcListeners = function () {};
    const loadInitialState = Renderer.prototype.loadInitialState;
    Renderer.prototype.loadInitialState = function () {};
    const renderer = new Renderer();
    renderer.loadInitialState = loadInitialState;
    for (const method of ['updateNavigationButtons', 'showLoading', 'updateSecurityIndicator',
        'updateResolverBadge', 'updateHostingIndicator', 'updateHnsProfileIndicator', 'updateTabLoadingUI']) {
        renderer[method] = () => {};
    }
    renderer.renderTabs = tabs => { renderer.tabs = new Map(tabs.map(tab => [tab.id, tab])); };
    renderer.activeTabId = 1;
    renderer.tabs.set(1, { id: 1, url: 'skyinclude://home', active: true });
    renderer.updateAddressBar('skyinclude://home');
    renderer.addressBar.focus();
    const draft = value => {
        renderer.addressBar.value = value;
        renderer.addressBar.listeners.get('input')?.({ target: renderer.addressBar });
    };
    const flushTimers = () => { while (timers.length) timers.shift()(); };
    return { renderer, document, api, navigations, draft, flushTimers };
}

test('startup Home loading/tab/switch updates preserve the focused draft and Enter submits it', async () => {
    const { renderer, navigations, draft, flushTimers } = fixture();
    const target = 'https://handshake.mercenary:8443/thread?q=one#latest';
    draft(target);
    renderer.updateLoadingState({ tabId: 1, loading: false, url: 'skyinclude://home' });
    renderer.updateTabState({ tabId: 1, active: true, url: 'skyinclude://home' });
    renderer.updateUI({ tabId: 1, url: 'skyinclude://home' });
    flushTimers();
    assert.equal(renderer.addressBar.value, target);
    assert.equal(renderer.currentUrl, 'skyinclude://home', 'page state is independent of an unsubmitted draft');
    renderer.addressBar.listeners.get('keypress')({ key: 'Enter' });
    assert.equal(navigations.length, 1);
    assert.equal(navigations[0].tabId, 1);
    assert.equal(navigations[0].url, target);
    renderer.updateTabState({ tabId: 1, url: target });
    renderer.updateLoadingState({ tabId: 1, loading: false, url: `${target}-redirect` });
    assert.equal(renderer.addressBar.value, `${target}-redirect`, 'submission releases draft protection');
});

test('the direct-value rapid-startup diagnostic is protected without requiring an input event', () => {
    const { renderer } = fixture();
    renderer.addressBar.value = 'https://startup.acceptance/';
    renderer.updateLoadingState({ tabId: 1, loading: false, url: 'skyinclude://home' });
    assert.equal(renderer.addressBar.value, 'https://startup.acceptance/');
});

test('late initial-state loading preserves a draft before the first active tab is known', async () => {
    const { renderer, api, draft, flushTimers } = fixture();
    renderer.activeTabId = null;
    renderer.addressBarTabId = null;
    const pending = deferred();
    renderer.loadAppInfo = () => pending.promise;
    api.getTabs = async () => [{ id: 1, url: 'skyinclude://home', active: true }];
    const initial = renderer.loadInitialState();
    draft('lisa.agent');
    pending.resolve();
    await initial;
    flushTimers();
    assert.equal(renderer.activeTabId, 1);
    assert.equal(renderer.addressBar.value, 'lisa.agent');
});

test('an empty edit on a loaded page survives updates; empty Enter does not navigate', () => {
    const { renderer, draft, navigations } = fixture();
    renderer.updateAddressBar('http://handshake.mercenary/');
    draft('');
    renderer.updateTabState({ tabId: 1, url: 'http://handshake.mercenary/new' });
    assert.equal(renderer.addressBar.value, '');
    renderer.addressBar.listeners.get('keypress')({ key: 'Enter' });
    assert.equal(navigations.length, 0);
    renderer.updateLoadingState({ tabId: 1, loading: false, url: 'http://handshake.mercenary/new' });
    assert.equal(renderer.addressBar.value, '');
});

test('Escape cancels the edit to the latest page address without stopping the page load', () => {
    const { renderer, draft, document } = fixture();
    const page = 'https://example.com/redirected';
    draft('an unfinished search');
    renderer.updateTabState({ tabId: 1, url: page });
    let prevented = false;
    let stopped = false;
    let loadsStopped = 0;
    renderer.isLoading = true;
    renderer.stopLoading = () => { loadsStopped += 1; };
    const event = { key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
    renderer.addressBar.listeners.get('keydown')?.(event);
    if (!stopped) document.listeners.get('keydown')(event);
    assert.equal(renderer.addressBar.value, page);
    assert.equal(prevented, true);
    assert.equal(loadsStopped, 0);
    assert.equal(document.activeElement, renderer.addressBar);
});

test('blur restores the latest page address and subsequent redirects keep updating it', () => {
    const { renderer, draft } = fixture();
    draft('unfinished.agent');
    renderer.updateLoadingState({ tabId: 1, loading: false, url: 'https://example.com/one' });
    renderer.addressBar.blur();
    assert.equal(renderer.addressBar.value, 'https://example.com/one');
    renderer.updateTabState({ tabId: 1, url: 'https://example.com/two' });
    assert.equal(renderer.addressBar.value, 'https://example.com/two');
});

test('tab changes replace the old draft even when switchTab has already set the active ID', async () => {
    const { renderer, api, draft, flushTimers } = fixture();
    renderer.tabs.set(2, { id: 2, url: 'https://example.com/', active: false });
    draft('unsubmitted.agent');
    api.switchTab = async () => {};
    await renderer.switchTab(2);
    renderer.updateUI({ tabId: 2, url: 'https://example.com/' });
    assert.equal(renderer.addressBar.value, 'https://example.com/');
    draft('second draft');
    renderer.updateTabState({ tabId: 1, url: 'skyinclude://home', active: false });
    assert.equal(renderer.addressBar.value, 'second draft', 'background tabs cannot repaint the active draft');
    renderer.updateTabState({ tabId: 1, url: 'skyinclude://home', active: true });
    flushTimers();
    assert.equal(renderer.addressBar.value, '', 'activating Home does not inherit another tab draft');
});

test('Home focus callbacks never reselect an active draft or steal focus after navigation/tab change', () => {
    const { renderer, document, draft, flushTimers } = fixture();
    renderer.focusAddressBar();
    const selections = renderer.addressBar.selections;
    draft('partially typed');
    flushTimers();
    assert.equal(renderer.addressBar.selections, selections);
    renderer.focusAddressBar();
    renderer.activeTabId = 2;
    const content = {};
    document.activeElement = content;
    flushTimers();
    assert.equal(document.activeElement, content);
    renderer.activeTabId = 1;
    renderer.focusAddressBar();
    renderer.navigateToUrl('https://example.com/');
    flushTimers();
    assert.equal(document.activeElement, content);
});

test('a new edit during a pending navigation stays protected when that navigation finishes', async () => {
    const { renderer, api, draft } = fixture();
    const pending = deferred();
    api.navigateTo = () => pending.promise;
    draft('first.agent');
    const first = renderer.navigateToUrl(renderer.addressBar.value);
    draft('second.agent');
    renderer.updateTabState({ tabId: 1, url: 'https://first.agent/' });
    pending.resolve();
    await first;
    assert.equal(renderer.addressBar.value, 'second.agent');
    assert.equal(renderer.currentUrl, 'https://first.agent/');
});

test('focused unedited addresses still follow HNS/ICANN navigation and explicit manifest URLs', () => {
    const { renderer } = fixture();
    for (const url of ['http://lisa.agent/', 'https://handshake.mercenary/', 'https://example.com/',
        'https://headlessdomains.com/manifests/lisa.agent.json', 'skyinclude://home']) {
        renderer.updateTabState({ tabId: 1, url });
        assert.equal(renderer.addressBar.value, url === 'skyinclude://home' ? '' : url);
    }
});
