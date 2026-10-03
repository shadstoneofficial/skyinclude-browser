const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');

const projectRoot = path.resolve(__dirname, '..', '..');
const projectRequire = createRequire(path.join(projectRoot, 'main.js'));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function settle() {
    return new Promise(resolve => setImmediate(resolve));
}

function makeWebContents(overrides = {}) {
    const contents = new EventEmitter();
    contents.id = 1;
    contents.currentUrl = 'https://example.com/';
    contents.loading = false;
    contents.destroyed = false;
    contents.backAvailable = false;
    contents.forwardAvailable = false;
    contents.calls = { loadURL: [], stop: 0, reload: 0, goBack: 0, goForward: 0, destroy: 0, clearCache: 0 };
    contents.session = {
        clearCache: async () => { contents.calls.clearCache += 1; },
        setPermissionRequestHandler: () => {},
        webRequest: { onBeforeSendHeaders: () => {} }
    };
    contents.loadURL = async (url, options = {}) => {
        contents.calls.loadURL.push({ url, options });
        contents.currentUrl = url;
        contents.loading = false;
    };
    contents.stop = () => { contents.calls.stop += 1; contents.loading = false; };
    contents.reload = () => { contents.calls.reload += 1; };
    contents.goBack = () => { contents.calls.goBack += 1; };
    contents.goForward = () => { contents.calls.goForward += 1; };
    contents.destroy = () => { contents.calls.destroy += 1; contents.destroyed = true; };
    contents.isDestroyed = () => contents.destroyed;
    contents.isLoading = () => contents.loading;
    contents.canGoBack = () => contents.backAvailable;
    contents.canGoForward = () => contents.forwardAvailable;
    contents.getURL = () => contents.currentUrl;
    contents.getTitle = () => 'Test page';
    contents.setWindowOpenHandler = handler => { contents.windowOpenHandler = handler; };
    Object.assign(contents, overrides);
    return contents;
}

function makeElectron() {
    const views = [];
    const handlers = new Map();
    const switches = [];
    const electron = {
        views,
        handlers,
        switches,
        app: {
            getVersion: () => '0.1.23',
            getPath: () => '/tmp/skyinclude-browser-test-not-persisted',
            setAppUserModelId: () => {},
            commandLine: { appendSwitch: (...args) => switches.push(args) }
        },
        BrowserView: class {
            constructor(options) {
                this.options = options;
                this.webContents = makeWebContents({ id: views.length + 1 });
                views.push(this);
            }
            setBounds() {}
            setAutoResize() {}
        },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        session: { defaultSession: { clearCache: async () => {} } },
        Menu: { buildFromTemplate: items => ({ items, popup() {} }), setApplicationMenu() {} },
        shell: { openExternal: async () => {}, openPath: async () => '' },
        clipboard: { writeText() {} },
        dialog: {}
    };
    return electron;
}

function loadBrowserClass({ dependencies = {}, electron = makeElectron() } = {}) {
    const source = fs.readFileSync(path.join(projectRoot, 'main.js'), 'utf8');
    const marker = '// App event handlers';
    if (!source.includes(marker)) throw new Error('Browser harness cannot locate startup boundary');
    const sandbox = {
        module: { exports: {} },
        __dirname: projectRoot,
        Buffer,
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        setImmediate,
        process,
        console: { log() {}, error() {}, warn() {} },
        require: name => {
            if (Object.prototype.hasOwnProperty.call(dependencies, name)) return dependencies[name];
            if (name === 'electron') return electron;
            // Loading the class must not construct real settings or touch user data.
            if (name === './settings.js') return class SettingsManager {};
            return projectRequire(name);
        }
    };
    vm.runInNewContext(`${source.split(marker)[0]}\nmodule.exports = SkyIncludeBrowser;`, sandbox, {
        filename: path.join(projectRoot, 'main.js')
    });
    return sandbox.module.exports;
}

function makeBrowser({
    settings: configuredSettings = {}, dependencies = {},
    browserOverrides = {}, tabOverrides = {}, webContentsOverrides = {}
} = {}) {
    const electron = makeElectron();
    const Browser = loadBrowserClass({ dependencies, electron });
    const browser = Object.create(Browser.prototype);
    const events = [];
    const logs = [];
    const history = [];
    const statuses = [];
    const settings = { searchEngine: 'https://duckduckgo.com/?q=', ...configuredSettings };
    const attachedViews = new Set();
    browser.mainWindow = {
        isDestroyed: () => false,
        webContents: { send: (channel, data) => events.push({ channel, data }) },
        addBrowserView: view => attachedViews.add(view),
        removeBrowserView: view => attachedViews.delete(view),
        getBrowserViews: () => [...attachedViews]
    };
    browser.settingsManager = { getSetting: key => settings[key] };
    browser.tabs = new Map();
    browser.tabCounter = 1;
    browser.activeTabId = 1;
    browser.hnsHostHeaders = new Map();
    browser.hnsProxyHosts = new Map();
    browser.hnsHttpsAvailabilityCache = new Map();
    browser.hnsHttpsAvailabilityTtlMs = 300000;
    browser.daneVerifiedCertificates = new Map();
    browser.daneTrustTtlMs = 300000;
    browser.daneLookupTimeoutMs = 2500;
    browser.daneProbeTimeoutMs = 4000;
    browser.githubPagesAddresses = new Set();
    browser.proxyConfiguredSessions = new WeakSet();
    browser.hnsResolver = {
        resolveHNSDomain: async () => { throw new Error('Test must stub HNS resolution'); },
        resolveTLSARecords: async () => [],
        clearCache() {}
    };
    browser.log = (event, data) => logs.push({ event, data });
    browser.addToHistory = (...args) => history.push(args);
    browser.sendStatusMessage = (...args) => statuses.push(args);
    browser.configureHnsProxyForSession = async () => {};
    browser.updateCurrentViewBounds = () => {};
    const webContents = makeWebContents(webContentsOverrides);
    const tab = {
        id: 1, view: { webContents }, url: 'https://example.com/',
        displayUrl: 'https://example.com/', title: 'Test page',
        loading: false, resolving: false, favicon: null, hostingProvider: null,
        hnsProfile: null, securityInfo: null, canGoBack: false, canGoForward: false,
        navigationToken: Symbol('initial-navigation'), navigationAbortController: new AbortController(),
        ...tabOverrides
    };
    browser.tabs.set(tab.id, tab);
    browser.currentView = tab.view;
    attachedViews.add(tab.view);
    Object.assign(browser, browserOverrides);
    return { browser, tab, webContents, events, logs, history, statuses, settings, electron };
}

module.exports = { deferred, settle, makeWebContents, makeElectron, loadBrowserClass, makeBrowser };
