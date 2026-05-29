const { app, BrowserWindow, BrowserView, ipcMain, Menu, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { URL, fileURLToPath } = require('url');
const http = require('http');

// Initialize managers
const SettingsManager = require('./settings.js');
const { HNSResolver } = require('./resolver.js');

let activeBrowser = null;
const LATEST_RELEASE_URL = 'https://github.com/shadstoneofficial/skyinclude-browser/releases/latest';

class SkyIncludeBrowser {
    constructor() {
        this.mainWindow = null;
        this.currentView = null;
        this.tabs = new Map();
        this.activeTabId = null;
        this.tabCounter = 0;
        this.history = [];
        this.hnsHostHeaders = new Map();
        this.hnsProxyHosts = new Map();
        this.hnsProxyPort = null;
        this.hnsProxyServer = null;
        this.proxyConfiguredSessions = new WeakSet();
        this.githubPagesAddresses = new Set([
            '185.199.108.153',
            '185.199.109.153',
            '185.199.110.153',
            '185.199.111.153'
        ]);
        this.appVersion = app.getVersion();
        this.logFile = path.join(app.getPath('userData'), 'skyinclude-debug.log');
        this.log('app-started', {
            version: this.appVersion,
            platform: process.platform,
            arch: process.arch
        });
        
        // Initialize managers
        this.settingsManager = new SettingsManager();
        this.hnsResolver = new HNSResolver(this.settingsManager);
        
        // Disable telemetry and analytics
        app.setAppUserModelId('com.skyinclude.browser');
        app.commandLine.appendSwitch('--disable-features', 'MediaRouter');
        app.commandLine.appendSwitch('--disable-background-timer-throttling');
        app.commandLine.appendSwitch('--disable-backgrounding-occluded-windows');
        app.commandLine.appendSwitch('--disable-renderer-backgrounding');
        app.commandLine.appendSwitch('--disable-component-update');
        app.commandLine.appendSwitch('--disable-default-apps');
        app.commandLine.appendSwitch('--disable-extensions');
        app.commandLine.appendSwitch('--disable-plugins');
        app.commandLine.appendSwitch('--disable-sync');
        app.commandLine.appendSwitch('--disable-translate');
        app.commandLine.appendSwitch('--no-default-browser-check');
        app.commandLine.appendSwitch('--no-first-run');
    }

    async createMainWindow() {
        this.mainWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            minWidth: 800,
            minHeight: 600,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                enableRemoteModule: false,
                preload: path.join(__dirname, 'preload.js'),
                webSecurity: true
            },
            show: false
        });

        this.setupMenus();
        this.setupIpcHandlers();
        await this.startHnsProxy();
        await this.configureHnsProxyForSession(session.defaultSession);

        await this.mainWindow.loadFile('index.html');
        
        // Show window when ready
        this.mainWindow.once('ready-to-show', () => {
            this.mainWindow.show();
            this.updateCurrentViewBounds();
        });

        this.mainWindow.on('resize', () => this.updateCurrentViewBounds());
        this.mainWindow.on('maximize', () => this.updateCurrentViewBounds());
        this.mainWindow.on('unmaximize', () => this.updateCurrentViewBounds());
        this.mainWindow.on('enter-full-screen', () => this.updateCurrentViewBounds());
        this.mainWindow.on('leave-full-screen', () => this.updateCurrentViewBounds());

        // Create initial tab with home page
        await this.createNewTab('skyinclude://home');

    }

    async createNewTab(url = 'skyinclude://home') {
        const tabId = ++this.tabCounter;
        
        const view = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                enableRemoteModule: false,
                webSecurity: true,
                allowRunningInsecureContent: false,
                experimentalFeatures: false
            }
        });

        // Configure view for privacy
        view.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
            // Deny all permissions by default for privacy
            callback(false);
        });

        view.webContents.session.webRequest.onBeforeSendHeaders((details, callback) => {
            try {
                const requestHost = new URL(details.url).hostname;
                const hnsHost = this.hnsHostHeaders.get(`${details.webContentsId}:${requestHost}`);
                if (hnsHost) {
                    details.requestHeaders.Host = hnsHost;
                }
            } catch (error) {
                // Leave headers unchanged for non-standard URLs.
            }

            if (this.settingsManager.getSetting('doNotTrack') !== false) {
                details.requestHeaders.DNT = '1';
            }

            callback({ requestHeaders: details.requestHeaders });
        });

        await this.configureHnsProxyForSession(view.webContents.session);

        view.webContents.setWindowOpenHandler(({ url: navigationUrl }) => {
            this.createNewTab(navigationUrl).catch(error => {
                this.log('new-tab-error', { url: navigationUrl, message: error.message });
            });
            return { action: 'deny' };
        });

        view.webContents.on('will-navigate', (event, navigationUrl) => {
            const tab = this.tabs.get(tabId);
            if (tab && tab.pendingLoadUrl === this.normalizeGatewayUrl(navigationUrl)) {
                return;
            }

            if (this.shouldResolveNavigation(navigationUrl)) {
                event.preventDefault();
                this.loadUrlInTab(tabId, navigationUrl);
            }
        });

        view.webContents.on('did-navigate', (event, navigationUrl) => {
            this.updateTabUrlFromNavigation(tabId, navigationUrl);
        });

        view.webContents.on('did-navigate-in-page', (event, navigationUrl) => {
            this.updateTabUrlFromNavigation(tabId, navigationUrl);
        });

        this.tabs.set(tabId, {
            id: tabId,
            view: view,
            url: url,
            title: 'New Tab',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            hostingProvider: null
        });

        this.switchToTab(tabId);
        this.loadUrlInTab(tabId, url).catch(error => {
            this.log('initial-tab-load-error', { tabId, url, message: error.message });
        });

        return tabId;
    }

    switchToTab(tabId) {
        if (this.currentView) {
            this.mainWindow.removeBrowserView(this.currentView);
        }

        const tab = this.tabs.get(tabId);
        if (!tab) return;

        this.currentView = tab.view;
        this.activeTabId = tabId;
        this.mainWindow.addBrowserView(this.currentView);
        this.updateCurrentViewBounds();

        // Update UI
        this.mainWindow.webContents.send('tab-switched', {
            tabId: tabId,
            url: tab.url,
            title: tab.title,
            canGoBack: tab.canGoBack,
            canGoForward: tab.canGoForward,
            loading: tab.loading,
            hostingProvider: tab.hostingProvider
        });
    }

    updateCurrentViewBounds() {
        if (!this.mainWindow || !this.currentView) {
            return;
        }

        const topChromeHeight = 120;
        const [width, height] = this.mainWindow.getContentSize();
        this.currentView.setBounds({
            x: 0,
            y: topChromeHeight,
            width,
            height: Math.max(0, height - topChromeHeight)
        });
    }

    closeTab(tabId) {
        const tab = this.tabs.get(tabId);
        if (!tab) return;

        if (tab.view === this.currentView) {
            this.mainWindow.removeBrowserView(this.currentView);
            this.currentView = null;
        }

        tab.view.webContents.destroy();
        this.tabs.delete(tabId);

        // Switch to another tab or create new one
        if (this.tabs.size === 0) {
            this.createNewTab().catch(error => {
                this.log('new-tab-error', { message: error.message });
            });
        } else if (tabId === this.activeTabId) {
            const remainingTabs = Array.from(this.tabs.keys());
            this.switchToTab(remainingTabs[0]);
        }

        this.mainWindow.webContents.send('tab-closed', tabId);
    }

    async loadUrlInTab(tabId, inputUrl) {
        const tab = this.tabs.get(tabId);
        if (!tab) return;

        try {
            tab.loading = true;
            tab.hostingProvider = null;
            this.mainWindow.webContents.send('loading-changed', { tabId, loading: true, hostingProvider: null });

            let finalUrl = inputUrl;
            let loadOptions = {};

            // Handle special URLs
            if (inputUrl === 'skyinclude://home' || inputUrl === '') {
                finalUrl = `file://${path.join(__dirname, 'announcement.html')}`;
                tab.displayUrl = 'skyinclude://home';
            } else {
                // Check if it's an HNS domain or needs resolution
                const resolved = await this.resolveUrl(inputUrl);
                finalUrl = resolved.url || resolved;
                loadOptions = resolved.options || {};
                tab.displayUrl = resolved.displayUrl || inputUrl;
                tab.hostingProvider = resolved.hostingProvider || null;

                if (resolved.proxyHost && resolved.resolvedHost) {
                    this.hnsProxyHosts.set(resolved.proxyHost, resolved.resolvedHost);
                    this.log('hns-proxy-map', {
                        tabId,
                        proxyHost: resolved.proxyHost,
                        resolvedHost: resolved.resolvedHost
                    });
                }

                if (resolved.bypassCache) {
                    await tab.view.webContents.session.clearCache();
                    loadOptions.extraHeaders = [
                        loadOptions.extraHeaders || '',
                        'Cache-Control: no-cache',
                        'Pragma: no-cache'
                    ].filter(Boolean).join('\r\n');
                }

                if (resolved.hnsHostHeader && resolved.resolvedHost) {
                    this.hnsHostHeaders.set(`${tab.view.webContents.id}:${resolved.resolvedHost}`, resolved.hnsHostHeader);
                    this.log('hns-host-map', {
                        tabId,
                        webContentsId: tab.view.webContents.id,
                        resolvedHost: resolved.resolvedHost,
                        hnsHost: resolved.hnsHostHeader,
                        finalUrl
                    });
                }
            }

            this.log('load-url', { tabId, inputUrl, finalUrl, loadOptions });
            tab.pendingLoadUrl = finalUrl;
            await tab.view.webContents.loadURL(finalUrl, loadOptions);
            delete tab.pendingLoadUrl;
            
            tab.url = tab.displayUrl || inputUrl; // Keep original URL for display
            tab.loading = false;

            // Update navigation state
            tab.canGoBack = tab.view.webContents.canGoBack();
            tab.canGoForward = tab.view.webContents.canGoForward();

            this.mainWindow.webContents.send('loading-changed', { 
                tabId, 
                loading: false,
                url: tab.url,
                canGoBack: tab.canGoBack,
                canGoForward: tab.canGoForward,
                hostingProvider: tab.hostingProvider
            });

            // Add to history
            this.addToHistory(inputUrl, tab.title);

        } catch (error) {
            delete tab.pendingLoadUrl;
            this.log('load-error', { tabId, inputUrl, message: error.message, code: error.code });
            if (this.isExpectedNavigationAbort(error)) {
                tab.loading = false;
                this.mainWindow.webContents.send('loading-changed', { tabId, loading: false, url: tab.url });
                return;
            }
            console.error('Failed to load URL:', error);
            tab.loading = false;
            this.mainWindow.webContents.send('loading-error', { 
                tabId, 
                error: error.message,
                url: inputUrl
            });
        }
    }

    isExpectedNavigationAbort(error) {
        return error && String(error.message || '').includes('ERR_ABORTED');
    }

    async resolveUrl(input) {
        // Normalize input
        let url = this.normalizeGatewayUrl(input.trim());
        
        // If no protocol, assume https
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
            url = 'https://' + url;
        }
        url = this.normalizeGatewayUrl(url);

        try {
            const parsedUrl = new URL(url);
            const hostname = parsedUrl.hostname;
            
            // Check if it's potentially an HNS domain
            if (this.isHNSDomain(hostname)) {
                console.log('Attempting HNS resolution');
                
                // Try HNS resolution
                const hnsResult = await this.resolveHNS(hostname);
                if (hnsResult) {
                    this.log('hns-resolution-success', this.getResolutionDiagnostics(hnsResult));
                    return this.buildHNSNavigation(url, hnsResult);
                }
                
                // Keep HNS traffic on the local proxy even when pre-resolution is transient.
                console.log('HNS pre-resolution failed, deferring to local proxy');
                this.mainWindow.webContents.send('hns-fallback', { domain: hostname });
                return this.buildUnresolvedHNSNavigation(url, hostname);
            }
            
            return { url };
        } catch (error) {
            console.error('URL resolution error:', error);
            throw new Error(`Invalid URL: ${input}`);
        }
    }

    shouldResolveNavigation(navigationUrl) {
        try {
            const normalizedUrl = this.normalizeGatewayUrl(navigationUrl);
            const parsedUrl = new URL(normalizedUrl);
            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                return false;
            }

            if (this.isIPAddress(parsedUrl.hostname)) {
                return false;
            }

            return this.isHNSDomain(parsedUrl.hostname);
        } catch (error) {
            return false;
        }
    }

    updateTabUrlFromNavigation(tabId, navigationUrl) {
        const tab = this.tabs.get(tabId);
        if (!tab) return;

        try {
            const parsedUrl = new URL(this.normalizeGatewayUrl(navigationUrl));
            if (parsedUrl.protocol === 'file:' && parsedUrl.pathname.endsWith('/announcement.html')) {
                tab.url = 'skyinclude://home';
                tab.hostingProvider = null;
                this.mainWindow.webContents.send('loading-changed', {
                    tabId,
                    loading: false,
                    url: tab.url,
                    canGoBack: tab.view.webContents.canGoBack(),
                    canGoForward: tab.view.webContents.canGoForward(),
                    hostingProvider: tab.hostingProvider
                });
                return;
            }

            if (this.isIPAddress(parsedUrl.hostname)) {
                tab.hostingProvider = null;
                return;
            }

            if (!this.isHNSDomain(parsedUrl.hostname)) {
                tab.hostingProvider = null;
            }

            tab.url = parsedUrl.toString().replace(/^http:\/\//, '');
            this.mainWindow.webContents.send('loading-changed', {
                tabId,
                loading: false,
                url: tab.url,
                canGoBack: tab.view.webContents.canGoBack(),
                canGoForward: tab.view.webContents.canGoForward(),
                hostingProvider: tab.hostingProvider
            });
        } catch (error) {
            this.log('navigation-url-update-error', { tabId, navigationUrl, message: error.message });
        }
    }

    normalizeGatewayUrl(inputUrl) {
        try {
            const parsedUrl = new URL(inputUrl);
            if (parsedUrl.hostname.endsWith('.hns.to')) {
                parsedUrl.hostname = parsedUrl.hostname.slice(0, -'.hns.to'.length);
                parsedUrl.protocol = 'http:';
                return parsedUrl.toString();
            }
        } catch (error) {
            // Plain host inputs are normalized after protocol insertion.
        }

        return inputUrl;
    }

    isHNSDomain(hostname) {
        const normalized = hostname.toLowerCase();
        if (this.isIPAddress(normalized)) {
            return false;
        }

        const icannTlds = new Set([
            'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'co',
            'ai', 'app', 'dev', 'xyz', 'info', 'biz', 'us', 'uk', 'ca',
            'de', 'fr', 'jp', 'cn', 'au', 'in', 'br', 'ru', 'ch', 'nl'
        ]);
        const hnsHints = new Set([
            'hns', 'agent', 'chatbot', 'nb', 'sats', 'blockchain', 'crypto',
            'mercenary', 'bit', 'coin', 'wallet'
        ]);

        const parts = normalized.split('.').filter(Boolean);
        if (parts.length === 1) {
            return /^[a-z0-9-]+$/.test(parts[0]);
        }

        const tld = parts[parts.length - 1];
        return hnsHints.has(tld) || !icannTlds.has(tld);
    }

    isIPAddress(hostname) {
        return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
    }

    async resolveHNS(domain) {
        const attempts = 3;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                const result = await this.hnsResolver.resolveHNSDomain(domain);
                if (result) {
                    if (attempt > 1) {
                        this.log('hns-resolution-retry-success', {
                            attempt,
                            ...this.getResolutionDiagnostics(result)
                        });
                    }
                    return result;
                }

                this.log('hns-resolution-empty', { attempt });
            } catch (error) {
                this.log('hns-resolution-error', { attempt, message: error.message });
                console.error('HNS resolution failed:', error);
            }

            if (attempt < attempts) {
                if (typeof this.hnsResolver.clearCache === 'function') {
                    this.hnsResolver.clearCache();
                }
                await new Promise(resolve => setTimeout(resolve, 300 * attempt));
            }
        }

        return null;
    }

    getResolutionDiagnostics(resolution) {
        if (!resolution || typeof resolution !== 'object') {
            return { source: 'unknown', route: 'unknown' };
        }

        const records = resolution.records || {};
        const counts = Object.fromEntries(['A', 'AAAA', 'CNAME', 'TXT']
            .map(type => [type, Array.isArray(records[type]) ? records[type].length : 0]));
        const route = resolution.address
            ? 'web-address'
            : resolution.canonicalName
                ? 'web-cname'
                : resolution.url
                    ? 'redirect-url'
                    : 'records-only';

        return {
            source: resolution.source || 'unknown',
            route,
            addressType: resolution.addressType || null,
            recordCounts: counts,
            hasAddress: Boolean(resolution.address),
            hasUrl: Boolean(resolution.url)
        };
    }

    buildHNSNavigation(originalUrl, resolution) {
        const parsedUrl = new URL(originalUrl);
        const hostingProvider = this.getHostingProviderForResolution(resolution);

        if (typeof resolution === 'string') {
            return { url: resolution };
        }

        if (resolution.url && !resolution.address) {
            return { url: resolution.url, hostingProvider };
        }

        if (resolution.address) {
            parsedUrl.protocol = 'http:';

            return {
                url: parsedUrl.toString(),
                displayUrl: `${resolution.domain}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`,
                hnsHostHeader: resolution.domain,
                proxyHost: resolution.domain,
                resolvedHost: resolution.address,
                bypassCache: true,
                hostingProvider
            };
        }

        if (resolution.url) {
            return { url: resolution.url, hostingProvider };
        }

        throw new Error(`No browsable HNS records found for ${resolution.domain}`);
    }

    buildUnresolvedHNSNavigation(originalUrl, hostname) {
        const parsedUrl = new URL(originalUrl);
        parsedUrl.protocol = 'http:';
        parsedUrl.hostname = this.normalizeGatewayHost(hostname);

        return {
            url: parsedUrl.toString(),
            displayUrl: `${parsedUrl.hostname}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`,
            hnsHostHeader: parsedUrl.hostname,
            proxyHost: parsedUrl.hostname,
            hostingProvider: null,
            bypassCache: true
        };
    }

    getHostingProviderForResolution(resolution) {
        if (!resolution || typeof resolution !== 'object') {
            return null;
        }

        const addresses = [
            resolution.address,
            ...(Array.isArray(resolution.records?.A) ? resolution.records.A : [])
        ].filter(Boolean);

        return addresses.some(address => this.githubPagesAddresses.has(address)) ? 'github-pages' : null;
    }

    addToHistory(url, title) {
        if (this.settingsManager.getSetting('saveHistory') === false) {
            return;
        }

        const historyManager = require('./history.js');
        historyManager.addEntry(url, title);
    }

    log(event, data = {}) {
        try {
            const dir = path.dirname(this.logFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const versionSummary = event === 'app-started' && data.version ? ` version=${data.version}` : '';
            fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${event}${versionSummary} ${JSON.stringify(this.redactLogData(data))}\n`);
        } catch (error) {
            console.error('Failed to write SkyInclude log:', error);
        }
    }

    redactLogData(value) {
        const sensitiveKeys = new Set([
            'address',
            'domain',
            'finalUrl',
            'hnsHost',
            'host',
            'hostname',
            'inputUrl',
            'navigationUrl',
            'path',
            'proxyForHns',
            'proxyHost',
            'resolvedHost',
            'url'
        ]);

        if (Array.isArray(value)) {
            return value.map(item => this.redactLogData(item));
        }

        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [
                key,
                sensitiveKeys.has(key) ? '[redacted]' : this.redactLogData(item)
            ]));
        }

        return value;
    }

    async startHnsProxy() {
        if (this.hnsProxyServer) return;

        this.hnsProxyServer = http.createServer((clientReq, clientRes) => {
            this.handleHnsProxyRequest(clientReq, clientRes);
        });

        await new Promise((resolve, reject) => {
            this.hnsProxyServer.once('error', reject);
            this.hnsProxyServer.listen(0, '127.0.0.1', () => {
                this.hnsProxyServer.off('error', reject);
                this.hnsProxyPort = this.hnsProxyServer.address().port;
                this.log('hns-proxy-started', { port: this.hnsProxyPort });
                resolve();
            });
        });
    }

    async configureHnsProxyForSession(electronSession) {
        if (!this.hnsProxyPort) {
            await this.startHnsProxy();
        }

        if (this.proxyConfiguredSessions.has(electronSession)) {
            return;
        }

        await electronSession.setProxy({
            proxyRules: `http=127.0.0.1:${this.hnsProxyPort}`,
            proxyBypassRules: 'localhost;127.0.0.1'
        });

        if (typeof electronSession.closeAllConnections === 'function') {
            await electronSession.closeAllConnections();
        }

        const proxyForHns = await electronSession.resolveProxy('http://skyinclude/');
        this.proxyConfiguredSessions.add(electronSession);
        this.log('proxy-configured', { port: this.hnsProxyPort, proxyForHns });
    }

    buildProxyPacScript() {
        const port = this.hnsProxyPort || 0;
        return `
            function FindProxyForURL(url, host) {
                if (host === "localhost" || host === "127.0.0.1") return "DIRECT";
                if (dnsDomainIs(host, ".mercenary") || dnsDomainIs(host, ".mastermind") ||
                    dnsDomainIs(host, ".skyinclude") || host === "skyinclude" ||
                    dnsDomainIs(host, ".agent") || dnsDomainIs(host, ".chatbot") ||
                    shExpMatch(host, "*.hns.to")) {
                    return "PROXY 127.0.0.1:${port}";
                }
                return "DIRECT";
            }
        `;
    }

    async handleHnsProxyRequest(clientReq, clientRes) {
        try {
            const requestUrl = new URL(clientReq.url);
            const host = this.normalizeGatewayHost(requestUrl.hostname);
            const isHnsHost = this.isHNSDomain(host);
            let address = isHnsHost ? this.hnsProxyHosts.get(host) : requestUrl.hostname;

            if (isHnsHost && !address) {
                const resolution = await this.resolveHNS(host);
                address = resolution && resolution.address;
                if (address) {
                    this.hnsProxyHosts.set(host, address);
                }
            }

            if (isHnsHost && !address) {
                clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
                clientRes.end(`No HNS address found for ${host}`);
                return;
            }

            const headers = { ...clientReq.headers };
            headers.host = isHnsHost ? host : (clientReq.headers.host || requestUrl.host);
            delete headers['proxy-connection'];

            this.log('hns-proxy-request', {
                method: clientReq.method,
                host,
                isHnsHost,
                address,
                path: requestUrl.pathname + requestUrl.search
            });

            const upstreamReq = http.request({
                hostname: address,
                port: requestUrl.port || 80,
                method: clientReq.method,
                path: requestUrl.pathname + requestUrl.search,
                headers
            }, upstreamRes => {
                clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
                upstreamRes.pipe(clientRes);
            });

            upstreamReq.on('error', error => {
                this.log('hns-proxy-error', { host, address, message: error.message });
                if (!clientRes.headersSent) {
                    clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
                }
                clientRes.end(error.message);
            });

            clientReq.pipe(upstreamReq);
        } catch (error) {
            this.log('hns-proxy-request-error', { url: clientReq.url, message: error.message });
            clientRes.writeHead(500, { 'Content-Type': 'text/plain' });
            clientRes.end(error.message);
        }
    }

    normalizeGatewayHost(hostname) {
        return hostname.endsWith('.hns.to') ? hostname.slice(0, -'.hns.to'.length) : hostname;
    }

    getIpcSenderUrl(event) {
        return event.senderFrame?.url || event.sender.getURL();
    }

    isTrustedAppFileUrl(senderUrl) {
        try {
            const parsedUrl = new URL(senderUrl);
            if (parsedUrl.protocol !== 'file:') {
                return false;
            }

            const senderPath = path.normalize(fileURLToPath(parsedUrl));
            const trustedFiles = new Set([
                path.normalize(path.join(__dirname, 'index.html')),
                path.normalize(path.join(__dirname, 'settings-ui.html'))
            ]);

            return trustedFiles.has(senderPath);
        } catch (error) {
            return false;
        }
    }

    requireTrustedIpcSender(event, channel) {
        const senderUrl = this.getIpcSenderUrl(event);
        if (!this.isTrustedAppFileUrl(senderUrl)) {
            this.log('blocked-ipc-sender', { channel, senderUrl });
            throw new Error('Blocked IPC request from untrusted sender');
        }
    }

    resolveTabId(tabId) {
        if (tabId === undefined || tabId === null || tabId === '') {
            if (!this.activeTabId) {
                throw new Error('No active tab');
            }
            return this.activeTabId;
        }

        const normalizedTabId = Number(tabId);
        if (!Number.isSafeInteger(normalizedTabId) || normalizedTabId <= 0 || !this.tabs.has(normalizedTabId)) {
            throw new Error('Invalid tab id');
        }

        return normalizedTabId;
    }

    validateNavigationInput(url, fallbackUrl = 'skyinclude://home') {
        if (url === undefined || url === null || url === '') {
            return fallbackUrl;
        }

        if (typeof url !== 'string') {
            throw new Error('URL must be a string');
        }

        const trimmedUrl = url.trim();
        if (!trimmedUrl) {
            return fallbackUrl;
        }

        if (trimmedUrl.length > 2048) {
            throw new Error('URL is too long');
        }

        return trimmedUrl;
    }

    validateNavigationPayload(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('Invalid navigation payload');
        }

        return {
            tabId: this.resolveTabId(payload.tabId),
            url: this.validateNavigationInput(payload.url, '')
        };
    }

    getAllowedSettingKeys() {
        return new Set([
            'hnsResolutionMode',
            'hnsResolvers',
            'hnsCustomResolver',
            'hnsTimeout',
            'hnsDANE',
            'hnsFallbackToDNS',
            'blockTrackers',
            'enableJavaScript',
            'blockAds',
            'doNotTrack',
            'clearDataOnExit',
            'strictSSL',
            'mixedContentBlocking',
            'certificateTransparency',
            'secureOnlyMode',
            'homepage',
            'searchEngine',
            'downloadPath',
            'language',
            'theme',
            'hardwareAcceleration',
            'experimentalFeatures',
            'developerMode',
            'customCSS',
            'userAgent',
            'historyRetentionDays',
            'maxHistoryEntries',
            'saveHistory',
            'autoUpdate',
            'betaUpdates'
        ]);
    }

    sanitizeSettingsPayload(settings) {
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            throw new Error('Settings payload must be an object');
        }

        const allowedSettingKeys = this.getAllowedSettingKeys();
        const sanitizedSettings = {};

        Object.entries(settings).forEach(([key, value]) => {
            if (allowedSettingKeys.has(key)) {
                sanitizedSettings[key] = value;
            }
        });

        return sanitizedSettings;
    }

    sanitizeSettingUpdate(key, value) {
        if (typeof key !== 'string' || !this.getAllowedSettingKeys().has(key)) {
            throw new Error('Invalid setting key');
        }

        return this.sanitizeSettingsPayload({ [key]: value });
    }

    isAllowedExternalUrl(navigationUrl) {
        try {
            const parsedUrl = new URL(navigationUrl);
            return ['https:', 'mailto:'].includes(parsedUrl.protocol);
        } catch (error) {
            return false;
        }
    }

    openExternalUrl(navigationUrl) {
        if (!this.isAllowedExternalUrl(navigationUrl)) {
            this.log('blocked-external-url', { url: navigationUrl });
            return;
        }

        shell.openExternal(navigationUrl).catch(error => {
            this.log('external-url-open-error', { url: navigationUrl, message: error.message });
        });
    }

    getAppInfo() {
        return {
            name: app.getName(),
            version: this.appVersion,
            platform: process.platform,
            arch: process.arch,
            latestReleaseUrl: LATEST_RELEASE_URL
        };
    }

    showAboutDialog() {
        const detail = [
            `Version ${this.appVersion}`,
            `Platform ${process.platform} ${process.arch}`,
            '',
            'SkyInclude Browser resolves Handshake/HNS websites and HeadlessDomains agent records.'
        ].join('\n');

        dialog.showMessageBox(this.mainWindow, {
            type: 'info',
            title: 'About SkyInclude Browser',
            message: 'SkyInclude Browser',
            detail,
            buttons: ['OK']
        }).catch(error => {
            this.log('about-dialog-error', { message: error.message });
        });
    }

    openLatestReleasePage() {
        this.openExternalUrl(LATEST_RELEASE_URL);
        this.sendStatusMessage('If you install an update, fully quit and reopen SkyInclude Browser.', 'info');
    }

    sendStatusMessage(message, type = 'info') {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('show-status-message', { message, type });
        }
    }

    async openDebugLog() {
        try {
            if (!fs.existsSync(this.logFile)) {
                this.log('debug-log-created');
            }

            const errorMessage = await shell.openPath(this.logFile);
            if (errorMessage) {
                throw new Error(errorMessage);
            }

            this.log('debug-log-opened');
            this.sendStatusMessage('Opened SkyInclude debug log.', 'success');
        } catch (error) {
            this.log('debug-log-open-error', { message: error.message });
            this.sendStatusMessage(`Unable to open debug log: ${error.message}`, 'error');
        }
    }

    async clearCacheAndReload() {
        if (typeof this.hnsResolver.clearCache === 'function') {
            this.hnsResolver.clearCache();
        }

        this.hnsHostHeaders.clear();
        this.hnsProxyHosts.clear();

        const sessions = new Set([session.defaultSession]);
        if (this.currentView?.webContents?.session) {
            sessions.add(this.currentView.webContents.session);
        }

        await Promise.all(Array.from(sessions).map(async electronSession => {
            await electronSession.clearCache();
        }));

        this.log('cache-clear-reload', {
            activeTabId: this.activeTabId,
            hnsCacheCleared: true,
            sessionCount: sessions.size
        });

        const activeTab = this.tabs.get(this.activeTabId);
        if (activeTab) {
            const reloadUrl = activeTab.url || activeTab.displayUrl || 'skyinclude://home';
            await this.loadUrlInTab(activeTab.id, reloadUrl);
            return { reloaded: true, message: 'Cache cleared and current page reloaded.' };
        }

        return { reloaded: false, message: 'Cache cleared.' };
    }

    showAppPopupMenu(anchor = {}) {
        const menu = Menu.buildFromTemplate([
            {
                label: `SkyInclude Browser v${this.appVersion}`,
                enabled: false
            },
            { type: 'separator' },
            {
                label: 'Check for Updates',
                click: () => this.openLatestReleasePage()
            },
            {
                label: 'Clear Cache / Reload HNS',
                click: () => {
                    this.clearCacheAndReload()
                        .then(result => this.sendStatusMessage(result.message, 'success'))
                        .catch(error => this.sendStatusMessage(`Unable to clear cache: ${error.message}`, 'error'));
                }
            },
            { type: 'separator' },
            {
                label: 'New Tab',
                accelerator: 'CmdOrCtrl+T',
                click: () => {
                    this.createNewTab().catch(error => {
                        this.log('new-tab-error', { message: error.message });
                    });
                }
            },
            {
                label: 'History',
                click: () => {
                    this.mainWindow.webContents.send('show-history');
                }
            },
            {
                label: 'Settings',
                click: () => {
                    this.mainWindow.webContents.send('show-settings');
                }
            },
            { type: 'separator' },
            {
                label: 'Developer Tools',
                click: () => {
                    if (this.currentView) {
                        this.currentView.webContents.openDevTools();
                    }
                }
            },
            {
                label: 'Open Debug Log',
                click: () => {
                    this.openDebugLog();
                }
            },
            { type: 'separator' },
            {
                label: 'About SkyInclude Browser',
                click: () => this.showAboutDialog()
            }
        ]);

        const popupOptions = { window: this.mainWindow };
        if (Number.isFinite(anchor.x) && Number.isFinite(anchor.y)) {
            popupOptions.x = Math.round(anchor.x);
            popupOptions.y = Math.round(anchor.y);
        }

        menu.popup(popupOptions);
    }

    setupMenus() {
        const template = [
            {
                label: 'File',
                submenu: [
                    {
                        label: 'New Tab',
                        accelerator: 'CmdOrCtrl+T',
                        click: () => {
                            this.createNewTab().catch(error => {
                                this.log('new-tab-error', { message: error.message });
                            });
                        }
                    },
                    {
                        label: 'Close Tab',
                        accelerator: 'CmdOrCtrl+W',
                        click: () => {
                            if (this.activeTabId) {
                                this.closeTab(this.activeTabId);
                            }
                        }
                    },
                    { type: 'separator' },
                    {
                        label: 'Quit',
                        accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Ctrl+Q',
                        click: () => app.quit()
                    }
                ]
            },
            {
                label: 'Edit',
                submenu: [
                    { role: 'undo' },
                    { role: 'redo' },
                    { type: 'separator' },
                    { role: 'cut' },
                    { role: 'copy' },
                    { role: 'paste' },
                    { role: 'pasteAndMatchStyle' },
                    { role: 'delete' },
                    { type: 'separator' },
                    { role: 'selectAll' }
                ]
            },
            {
                label: 'View',
                submenu: [
                    {
                        label: 'Reload',
                        accelerator: 'CmdOrCtrl+R',
                        click: () => {
                            if (this.currentView) {
                                this.currentView.webContents.reload();
                            }
                        }
                    },
                    {
                        label: 'Developer Tools',
                        accelerator: 'F12',
                        click: () => {
                            if (this.currentView) {
                                this.currentView.webContents.openDevTools();
                            }
                        }
                    }
                ]
            },
            {
                label: 'Troubleshooting',
                submenu: [
                    {
                        label: 'Clear Cache / Reload HNS',
                        click: () => {
                            this.clearCacheAndReload()
                                .then(result => this.sendStatusMessage(result.message, 'success'))
                                .catch(error => this.sendStatusMessage(`Unable to clear cache: ${error.message}`, 'error'));
                        }
                    },
                    {
                        label: 'Open Debug Log',
                        click: () => {
                            this.openDebugLog();
                        }
                    }
                ]
            },
            {
                label: 'History',
                submenu: [
                    {
                        label: 'Show History',
                        click: () => {
                            this.mainWindow.webContents.send('show-history');
                        }
                    },
                    {
                        label: 'Clear History',
                        click: () => {
                            const historyManager = require('./history.js');
                            historyManager.clearHistory();
                        }
                    }
                ]
            },
            {
                label: 'Settings',
                submenu: [
                    {
                        label: 'Preferences',
                        click: () => {
                            this.openSettingsWindow();
                        }
                    }
                ]
            },
            {
                label: 'Help',
                submenu: [
                    {
                        label: `About SkyInclude Browser v${this.appVersion}`,
                        click: () => this.showAboutDialog()
                    },
                    {
                        label: 'Check for Updates',
                        click: () => this.openLatestReleasePage()
                    }
                ]
            }
        ];

        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);
    }
    
    openSettingsWindow() {
        // Create a new window for settings
        const settingsWindow = new BrowserWindow({
            width: 900,
            height: 700,
            minWidth: 800,
            minHeight: 600,
            parent: this.mainWindow,
            modal: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                enableRemoteModule: false,
                preload: path.join(__dirname, 'preload.js'),
                webSecurity: true
            },
            title: 'SkyInclude Browser Settings'
        });

        settingsWindow.loadFile('settings-ui.html');
        
        settingsWindow.once('ready-to-show', () => {
            settingsWindow.show();
        });
    }

    setupIpcHandlers() {
        // Navigation handlers
        ipcMain.handle('navigate-to', async (event, payload) => {
            this.requireTrustedIpcSender(event, 'navigate-to');
            const { tabId, url } = this.validateNavigationPayload(payload);
            await this.loadUrlInTab(tabId, url);
        });

        ipcMain.handle('go-back', (event, tabId) => {
            this.requireTrustedIpcSender(event, 'go-back');
            const tab = this.tabs.get(this.resolveTabId(tabId));
            if (tab && tab.view.webContents.canGoBack()) {
                tab.view.webContents.goBack();
            }
        });

        ipcMain.handle('go-forward', (event, tabId) => {
            this.requireTrustedIpcSender(event, 'go-forward');
            const tab = this.tabs.get(this.resolveTabId(tabId));
            if (tab && tab.view.webContents.canGoForward()) {
                tab.view.webContents.goForward();
            }
        });

        ipcMain.handle('reload', (event, tabId) => {
            this.requireTrustedIpcSender(event, 'reload');
            const tab = this.tabs.get(this.resolveTabId(tabId));
            if (tab) {
                tab.view.webContents.reload();
            }
        });

        // Tab management
        ipcMain.handle('new-tab', async (event, url) => {
            this.requireTrustedIpcSender(event, 'new-tab');
            return await this.createNewTab(this.validateNavigationInput(url));
        });

        ipcMain.handle('close-tab', (event, tabId) => {
            this.requireTrustedIpcSender(event, 'close-tab');
            this.closeTab(this.resolveTabId(tabId));
        });

        ipcMain.handle('switch-tab', (event, tabId) => {
            this.requireTrustedIpcSender(event, 'switch-tab');
            this.switchToTab(this.resolveTabId(tabId));
        });

        ipcMain.handle('get-tabs', (event) => {
            this.requireTrustedIpcSender(event, 'get-tabs');
            return Array.from(this.tabs.values()).map(tab => ({
                id: tab.id,
                url: tab.url,
                title: tab.title,
                loading: tab.loading,
                hostingProvider: tab.hostingProvider,
                active: tab.id === this.activeTabId
            }));
        });

        // History
        ipcMain.handle('get-history', (event) => {
            this.requireTrustedIpcSender(event, 'get-history');
            const historyManager = require('./history.js');
            return historyManager.getHistory();
        });

        // Settings
        ipcMain.handle('get-settings', (event) => {
            this.requireTrustedIpcSender(event, 'get-settings');
            return this.settingsManager.getSettings();
        });

        ipcMain.handle('save-settings', (event, settings) => {
            this.requireTrustedIpcSender(event, 'save-settings');
            const result = this.settingsManager.updateSettings(this.sanitizeSettingsPayload(settings));
            // Reinitialize resolver with new settings
            this.hnsResolver = new HNSResolver(this.settingsManager);
            return result;
        });
        
        ipcMain.handle('update-setting', (event, key, value) => {
            this.requireTrustedIpcSender(event, 'update-setting');
            const settingsUpdate = this.sanitizeSettingUpdate(key, value);
            const validatedSettings = this.settingsManager.validateSettings(settingsUpdate);
            if (!Object.prototype.hasOwnProperty.call(validatedSettings, key)) {
                throw new Error('Invalid setting value');
            }

            const result = this.settingsManager.updateSettings(validatedSettings);
            // Reinitialize resolver if HNS settings changed
            if (key.startsWith('hns')) {
                this.hnsResolver = new HNSResolver(this.settingsManager);
            }
            return result;
        });

        ipcMain.handle('get-app-info', (event) => {
            this.requireTrustedIpcSender(event, 'get-app-info');
            return this.getAppInfo();
        });

        ipcMain.handle('show-about', (event) => {
            this.requireTrustedIpcSender(event, 'show-about');
            this.showAboutDialog();
        });

        ipcMain.handle('open-latest-release', (event) => {
            this.requireTrustedIpcSender(event, 'open-latest-release');
            this.openLatestReleasePage();
        });

        ipcMain.handle('clear-cache-and-reload', async (event) => {
            this.requireTrustedIpcSender(event, 'clear-cache-and-reload');
            return await this.clearCacheAndReload();
        });

        ipcMain.handle('open-debug-log', async (event) => {
            this.requireTrustedIpcSender(event, 'open-debug-log');
            await this.openDebugLog();
        });

        ipcMain.handle('show-app-menu', (event, anchor) => {
            this.requireTrustedIpcSender(event, 'show-app-menu');
            const safeAnchor = anchor && typeof anchor === 'object' ? anchor : {};
            this.showAppPopupMenu({
                x: Number(safeAnchor.x),
                y: Number(safeAnchor.y)
            });
        });
    }
}

// App event handlers
app.whenReady().then(async () => {
    activeBrowser = new SkyIncludeBrowser();
    await activeBrowser.createMainWindow();
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        activeBrowser = new SkyIncludeBrowser();
        await activeBrowser.createMainWindow();
    }
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
    contents.on('new-window', (event, navigationUrl) => {
        event.preventDefault();
        if (activeBrowser) {
            activeBrowser.openExternalUrl(navigationUrl);
        }
    });
});
