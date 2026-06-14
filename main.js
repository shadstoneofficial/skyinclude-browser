const { app, BrowserWindow, BrowserView, ipcMain, Menu, dialog, shell, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { URL, fileURLToPath } = require('url');
const http = require('http');
const net = require('net');
const crypto = require('crypto');

// Initialize managers
const SettingsManager = require('./settings.js');
const { HNSResolver } = require('./resolver.js');
const { inspectHnsHttpsCertificate } = require('./hns-tls.js');

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
        this.statusBarVisible = false;
        this.daneVerifiedCertificates = new Map();
        this.daneTrustTtlMs = 5 * 60 * 1000;
        this.hnsHttpsAvailabilityCache = new Map();
        this.hnsHttpsAvailabilityTtlMs = 5 * 60 * 1000;
        this.daneLookupTimeoutMs = 2500;
        this.daneProbeTimeoutMs = 4000;
        this.certificateVerifierConfiguredSessions = new WeakSet();
        this.securityPopover = null;
        this.hnsProfilePopover = null;
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
        this.mainWindow.on('move', () => this.closeHnsProfilePopover());
        this.mainWindow.on('maximize', () => this.updateCurrentViewBounds());
        this.mainWindow.on('unmaximize', () => this.updateCurrentViewBounds());
        this.mainWindow.on('enter-full-screen', () => this.updateCurrentViewBounds());
        this.mainWindow.on('leave-full-screen', () => this.updateCurrentViewBounds());
        this.mainWindow.on('closed', () => this.closeHnsProfilePopover());

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
            this.updateTabUrlFromNavigation(tabId, navigationUrl).catch(error => {
                this.log('navigation-url-update-error', { tabId, navigationUrl, message: error.message });
            });
        });

        view.webContents.on('did-navigate-in-page', (event, navigationUrl) => {
            this.updateTabUrlFromNavigation(tabId, navigationUrl).catch(error => {
                this.log('navigation-url-update-error', { tabId, navigationUrl, message: error.message });
            });
        });

        view.webContents.on('page-title-updated', (event, title) => {
            this.updateTabTitle(tabId, title);
        });

        view.webContents.on('page-favicon-updated', (event, favicons) => {
            this.updateTabFavicon(tabId, favicons);
        });

        view.webContents.on('context-menu', (event, params) => {
            this.showPageContextMenu(view.webContents, params);
        });

        view.webContents.on('did-finish-load', () => {
            this.updateTabTitle(tabId, view.webContents.getTitle());
        });

        this.tabs.set(tabId, {
            id: tabId,
            view: view,
            url: url,
            title: 'New Tab',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            favicon: null,
            hostingProvider: null,
            hnsProfile: null,
            securityInfo: null
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
            favicon: tab.favicon,
            hostingProvider: tab.hostingProvider,
            hnsProfile: tab.hnsProfile,
            securityInfo: tab.securityInfo
        });
    }

    updateTabTitle(tabId, title) {
        const tab = this.tabs.get(tabId);
        if (!tab) return;
        if (tab.url === 'skyinclude://home' || tab.displayUrl === 'skyinclude://home') {
            tab.title = 'New Tab';
            return;
        }

        const cleanTitle = this.cleanPageTitle(title);
        if (!cleanTitle || cleanTitle === tab.title) {
            return;
        }

        tab.title = cleanTitle;
        this.sendTabUpdated(tab);
    }

    updateTabFavicon(tabId, favicons = []) {
        const tab = this.tabs.get(tabId);
        if (!tab || !Array.isArray(favicons)) return;

        const favicon = favicons.find(candidate => {
            if (typeof candidate !== 'string' || !candidate) return false;
            return /^(https?:|data:|file:)/.test(candidate);
        });

        if (!favicon || favicon === tab.favicon) {
            return;
        }

        tab.favicon = favicon;
        this.sendTabUpdated(tab);
    }

    cleanPageTitle(title) {
        if (typeof title !== 'string') {
            return '';
        }

        const cleanTitle = title.trim().replace(/\s+/g, ' ');
        if (!cleanTitle || cleanTitle === 'SkyInclude Browser') {
            return '';
        }

        return cleanTitle;
    }

    getHistoryTitle(tab) {
        const title = this.cleanPageTitle(tab?.title);
        return title && title !== 'New Tab' ? title : '';
    }

    getFallbackTitleForUrl(displayUrl) {
        if (!displayUrl || displayUrl === 'skyinclude://home') {
            return 'New Tab';
        }

        try {
            const parsedUrl = new URL(displayUrl.includes('://') ? displayUrl : `http://${displayUrl}`);
            return parsedUrl.hostname || displayUrl;
        } catch (error) {
            return String(displayUrl).slice(0, 40);
        }
    }

    getHostnameForDisplayUrl(displayUrl) {
        try {
            const parsedUrl = new URL(displayUrl.includes('://') ? displayUrl : `http://${displayUrl}`);
            return parsedUrl.hostname;
        } catch (error) {
            return '';
        }
    }

    buildSecurityInfo(type, options = {}) {
        const domain = options.domain || null;
        const state = options.state || null;
        const tlsaName = domain ? `_443._tcp.${domain}` : 'TLSA service name';
        const hnsDetails = domain ? [
            ['HNS name', domain],
            ['HNS resolution', 'Resolved by SkyInclude before page load']
        ] : [];

        if (type === 'local-home') {
            return {
                level: 'local',
                title: 'SkyInclude start page',
                summary: 'This is a local SkyInclude Browser page.',
                details: [
                    ['Page source', 'Bundled with the SkyInclude Browser app'],
                    ['Network connection', 'None for this page']
                ]
            };
        }

        if (type === 'hns-http') {
            return {
                level: 'warning',
                title: 'Native HNS HTTP',
                summary: 'This name resolved through Handshake/HNS, but this page is loaded over HTTP and is not encrypted.',
                details: [
                    ...hnsDetails,
                    ['Encryption', 'Not encrypted'],
                    ['DANE/TLSA', 'Not checked for this HTTP page']
                ]
            };
        }

        if (type === 'hns-unresolved') {
            return {
                level: 'danger',
                title: 'HNS site not resolved',
                summary: 'SkyInclude could not find a browsable HNS A/AAAA/CNAME record for this name.',
                details: [
                    ['HNS name', domain || 'Unknown'],
                    ['Resolution', 'No browsable address record found'],
                    ['DANE/TLSA', 'Cannot verify without a reachable HTTPS server']
                ]
            };
        }

        if (type === 'hns-dane') {
            const states = {
                verified: {
                    level: 'hns-dane',
                    title: 'HNS DANE verified',
                    summary: 'The HTTPS server certificate matches the published HNS TLSA record. SkyInclude is allowing this exact HNS hostname and certificate fingerprint for this session.',
                    dane: 'TLSA matched certificate or public key'
                },
                no_tlsa: {
                    level: 'warning',
                    title: 'No HNS TLSA record',
                    summary: 'This HNS name can still be opened through native HNS HTTP, but it is not DANE verified.',
                    dane: `No TLSA record found at ${tlsaName}`
                },
                tlsa_mismatch: {
                    level: 'danger',
                    title: 'HNS TLSA mismatch',
                    summary: 'The site published TLSA data, but it does not match the HTTPS server certificate.',
                    dane: 'TLSA record did not match the inspected certificate'
                },
                cert_expired: {
                    level: 'danger',
                    title: 'Certificate expired',
                    summary: 'The HTTPS certificate is expired, so SkyInclude cannot treat this HNS HTTPS endpoint as verified.',
                    dane: 'Certificate failed validity checks'
                },
                cert_not_yet_valid: {
                    level: 'danger',
                    title: 'Certificate not yet valid',
                    summary: 'The HTTPS certificate is not valid yet, so SkyInclude cannot treat this HNS HTTPS endpoint as verified.',
                    dane: 'Certificate failed validity checks'
                },
                unsupported_record: {
                    level: 'danger',
                    title: 'Unsupported TLSA record',
                    summary: 'The site published TLSA data using a format this version does not support yet.',
                    dane: 'TLSA exists but is outside the current MVP subset'
                },
                resolver_failure: {
                    level: 'danger',
                    title: 'TLSA resolver failure',
                    summary: 'SkyInclude could not complete the HNS TLSA lookup for this site.',
                    dane: options.error || 'TLSA lookup failed'
                },
                connection_failure: {
                    level: 'danger',
                    title: 'HTTPS certificate probe failed',
                    summary: 'SkyInclude could not inspect this site\'s HTTPS certificate.',
                    dane: options.error || 'HTTPS certificate probe failed'
                }
            };
            const details = states[state] || states.connection_failure;
            return {
                level: details.level,
                title: details.title,
                summary: details.summary,
                details: [
                    ...hnsDetails,
                    ['TLSA record', details.dane],
                    ['Certificate validation', state === 'verified'
                        ? 'Verified against HNS TLSA data by SkyInclude'
                        : 'Not verified'],
                    ['Page rendering', state === 'verified'
                        ? 'Allowed for this exact HNS hostname and certificate fingerprint'
                        : 'Direct native HNS HTTPS rendering is not enabled for this state']
                ]
            };
        }

        return null;
    }

    normalizeCertificateFingerprint(value) {
        return String(value || '').replace(/:/g, '').toLowerCase();
    }

    getCertificateFingerprint(certificate) {
        const knownFingerprint = this.normalizeCertificateFingerprint(certificate?.fingerprint256 || certificate?.fingerprint);
        if (knownFingerprint) {
            return knownFingerprint;
        }

        if (certificate?.raw && Buffer.isBuffer(certificate.raw)) {
            return crypto.createHash('sha256').update(certificate.raw).digest('hex');
        }

        return '';
    }

    getCertificateFingerprints(certificate) {
        const fingerprints = new Set([
            this.normalizeCertificateFingerprint(certificate?.fingerprint256),
            this.normalizeCertificateFingerprint(certificate?.fingerprint)
        ].filter(Boolean));

        if (certificate?.raw && Buffer.isBuffer(certificate.raw)) {
            fingerprints.add(crypto.createHash('sha256').update(certificate.raw).digest('hex'));
        }

        if (certificate?.data) {
            try {
                const x509 = new crypto.X509Certificate(certificate.data);
                fingerprints.add(crypto.createHash('sha256').update(x509.raw).digest('hex'));
            } catch (error) {
                // Electron certificate data is platform-shaped; ignore if it is not parseable PEM/DER.
            }
        }

        return Array.from(fingerprints);
    }

    rememberDaneVerifiedCertificate(domain, certificate) {
        const normalizedDomain = this.normalizeGatewayHost(String(domain || '').toLowerCase());
        const fingerprints = this.getCertificateFingerprints(certificate);
        if (!normalizedDomain || !fingerprints.length || !this.isHNSDomain(normalizedDomain)) {
            return null;
        }

        const validTo = this.hnsResolver.normalizeCertificateDate(
            this.hnsResolver.getCertificateDate(certificate, 'valid_to', 'validTo')
        );
        const expiresAt = Math.min(
            Date.now() + this.daneTrustTtlMs,
            validTo || Date.now() + this.daneTrustTtlMs
        );

        if (expiresAt <= Date.now()) {
            return null;
        }

        const trust = {
            domain: normalizedDomain,
            fingerprints,
            expiresAt
        };
        this.daneVerifiedCertificates.set(normalizedDomain, trust);
        this.log('hns-dane-trust-added', {
            domain: normalizedDomain,
            fingerprint: fingerprints[0],
            expiresAt
        });

        return trust;
    }

    getActiveDaneTrust(domain) {
        const normalizedDomain = this.normalizeGatewayHost(String(domain || '').toLowerCase());
        const trust = this.daneVerifiedCertificates.get(normalizedDomain);
        if (!trust) {
            return null;
        }

        if (trust.expiresAt <= Date.now()) {
            this.daneVerifiedCertificates.delete(normalizedDomain);
            return null;
        }

        return trust;
    }

    isDaneVerifiedCertificateAllowed(hostname, certificate) {
        const normalizedHostname = this.normalizeGatewayHost(String(hostname || '').toLowerCase());
        if (!normalizedHostname || !this.isHNSDomain(normalizedHostname)) {
            return false;
        }

        const trust = this.getActiveDaneTrust(normalizedHostname);
        if (!trust) {
            return false;
        }

        const fingerprints = this.getCertificateFingerprints(certificate);
        return fingerprints.some(fingerprint => trust.fingerprints.includes(fingerprint));
    }

    getBoundedDaneTimeout(defaultMs) {
        const configuredTimeout = Number(this.settingsManager.getSetting('hnsTimeout') || defaultMs);
        if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0) {
            return defaultMs;
        }

        return Math.min(configuredTimeout, 30000);
    }

    getDaneLookupTimeout() {
        return this.getBoundedDaneTimeout(this.daneLookupTimeoutMs);
    }

    getDaneProbeTimeout() {
        return this.getBoundedDaneTimeout(this.daneProbeTimeoutMs);
    }

    sendTabUpdated(tab) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            return;
        }

        this.mainWindow.webContents.send('tab-updated', {
            tabId: tab.id,
            url: tab.url,
            title: tab.title,
            loading: tab.loading,
            favicon: tab.favicon,
            hostingProvider: tab.hostingProvider,
            hnsProfile: tab.hnsProfile,
            securityInfo: tab.securityInfo,
            canGoBack: tab.view.webContents.canGoBack(),
            canGoForward: tab.view.webContents.canGoForward(),
            active: tab.id === this.activeTabId
        });
    }

    updateCurrentViewBounds() {
        if (!this.mainWindow || !this.currentView) {
            return;
        }

        const topChromeHeight = this.statusBarVisible ? 130 : 88;
        const [width, height] = this.mainWindow.getContentSize();
        this.currentView.setBounds({
            x: 0,
            y: topChromeHeight,
            width,
            height: Math.max(0, height - topChromeHeight)
        });
    }

    setStatusBarVisible(visible) {
        this.statusBarVisible = visible === true;
        this.updateCurrentViewBounds();
    }

    setBrowserViewVisible(visible) {
        if (!this.mainWindow || !this.currentView) {
            return;
        }

        const isAttached = this.mainWindow.getBrowserViews().includes(this.currentView);
        if (visible && !isAttached) {
            this.mainWindow.addBrowserView(this.currentView);
            this.updateCurrentViewBounds();
            return;
        }

        if (!visible && isAttached) {
            this.mainWindow.removeBrowserView(this.currentView);
        }
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
            tab.hnsProfile = null;
            tab.favicon = null;
            tab.securityInfo = null;
            this.mainWindow.webContents.send('loading-changed', { tabId, loading: true, hostingProvider: null, hnsProfile: null, securityInfo: null, favicon: null });

            let finalUrl = inputUrl;
            let loadOptions = {};

            // Handle special URLs
            if (inputUrl === 'skyinclude://home' || inputUrl === '') {
                finalUrl = `file://${path.join(__dirname, 'announcement.html')}`;
                tab.displayUrl = 'skyinclude://home';
                tab.securityInfo = this.buildSecurityInfo('local-home');
            } else {
                // Check if it's an HNS domain or needs resolution
                const resolved = await this.resolveUrl(inputUrl);
                finalUrl = resolved.url || resolved;
                loadOptions = resolved.options || {};
                tab.displayUrl = resolved.displayUrl || inputUrl;
                tab.hostingProvider = resolved.hostingProvider || null;
                tab.hnsProfile = resolved.hnsProfile || null;
                tab.securityInfo = resolved.securityInfo || null;
                tab.pendingHttpsAvailabilityCheck = resolved.httpsAvailabilityCheck || null;

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

            tab.url = tab.displayUrl || inputUrl;
            tab.title = this.getFallbackTitleForUrl(tab.url);
            this.sendTabUpdated(tab);

            this.log('load-url', { tabId, inputUrl, finalUrl, loadOptions });
            tab.pendingLoadUrl = finalUrl;
            await tab.view.webContents.loadURL(finalUrl, loadOptions);
            delete tab.pendingLoadUrl;
            
            tab.url = tab.displayUrl || inputUrl; // Keep original URL for display
            this.updateTabTitle(tabId, tab.view.webContents.getTitle());
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
                hostingProvider: tab.hostingProvider,
                hnsProfile: tab.hnsProfile,
                securityInfo: tab.securityInfo
            });
            this.sendTabUpdated(tab);

            if (tab.id === this.activeTabId && tab.pendingHttpsAvailabilityCheck) {
                const check = tab.pendingHttpsAvailabilityCheck;
                delete tab.pendingHttpsAvailabilityCheck;
                this.checkHnsHttpsAvailability(tab.id, check).catch(error => {
                    this.log('hns-https-availability-error', {
                        domain: check.domain,
                        message: error.message
                    });
                });
            }

            // Add to history
            this.addToHistory(tab.url, this.getHistoryTitle(tab), tab.favicon);

        } catch (error) {
            delete tab.pendingLoadUrl;
            this.log('load-error', { tabId, inputUrl, message: error.message, code: error.code });
            if (this.isExpectedNavigationAbort(error)) {
                tab.loading = false;
                this.mainWindow.webContents.send('loading-changed', { tabId, loading: false, url: tab.url, securityInfo: tab.securityInfo });
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
        
        // If no protocol, HNS names default to the native HNS HTTP path for compatibility.
        // Explicit https:// HNS URLs still use the DANE/TLSA status path.
        if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('file://')) {
            const inputHost = url.split(/[/?#]/)[0];
            url = `${this.isHNSDomain(inputHost) ? 'http' : 'https'}://${url}`;
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
                    return await this.buildHNSNavigation(url, hnsResult);
                }
                
                // Keep HNS traffic on the local proxy even when pre-resolution is transient.
                console.log('HNS pre-resolution failed, deferring to local proxy');
                this.mainWindow.webContents.send('hns-fallback', { domain: hostname });
                if (parsedUrl.protocol === 'https:') {
                    return await this.buildUnresolvedHNSStatusNavigation(url, hostname);
                }
                return this.buildUnresolvedHNSNavigation(url, hostname);
            }
            
            return { url, hostingProvider: this.getHostingProviderForUrl(url) };
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

    async updateTabUrlFromNavigation(tabId, navigationUrl) {
        const tab = this.tabs.get(tabId);
        if (!tab) return;

        try {
            const parsedUrl = new URL(this.normalizeGatewayUrl(navigationUrl));
            if (parsedUrl.protocol === 'file:' && parsedUrl.pathname.endsWith('/announcement.html')) {
                tab.url = 'skyinclude://home';
                tab.title = 'New Tab';
                tab.hostingProvider = null;
                tab.hnsProfile = null;
                tab.securityInfo = this.buildSecurityInfo('local-home');
                this.mainWindow.webContents.send('loading-changed', {
                    tabId,
                    loading: false,
                    url: tab.url,
                    canGoBack: tab.view.webContents.canGoBack(),
                    canGoForward: tab.view.webContents.canGoForward(),
                    hostingProvider: tab.hostingProvider,
                    hnsProfile: tab.hnsProfile,
                    securityInfo: tab.securityInfo
                });
                this.sendTabUpdated(tab);
                return;
            }

            if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                if (parsedUrl.protocol === 'data:' && tab.securityInfo) {
                    this.mainWindow.webContents.send('loading-changed', {
                        tabId,
                        loading: false,
                        url: tab.url,
                        canGoBack: tab.view.webContents.canGoBack(),
                        canGoForward: tab.view.webContents.canGoForward(),
                        hostingProvider: tab.hostingProvider,
                        hnsProfile: tab.hnsProfile,
                        securityInfo: tab.securityInfo
                    });
                    this.sendTabUpdated(tab);
                    return;
                }

                tab.hostingProvider = null;
                tab.hnsProfile = null;
                tab.securityInfo = null;
                this.mainWindow.webContents.send('loading-changed', {
                    tabId,
                    loading: false,
                    url: tab.url,
                    canGoBack: tab.view.webContents.canGoBack(),
                    canGoForward: tab.view.webContents.canGoForward(),
                    hostingProvider: tab.hostingProvider,
                    hnsProfile: tab.hnsProfile,
                    securityInfo: tab.securityInfo
                });
                this.sendTabUpdated(tab);
                return;
            }

            if (this.isIPAddress(parsedUrl.hostname)) {
                tab.hostingProvider = null;
                tab.hnsProfile = null;
                tab.securityInfo = null;
            } else if (!this.isHNSDomain(parsedUrl.hostname)) {
                tab.hostingProvider = this.getHostingProviderForUrl(parsedUrl.toString());
                tab.hnsProfile = null;
                tab.securityInfo = null;
            } else {
                await this.updateHNSMetadataForNavigation(tab, parsedUrl);
            }

            const previousHost = this.getHostnameForDisplayUrl(tab.url);
            tab.url = parsedUrl.toString().replace(/^http:\/\//, '');
            const nextHost = this.getHostnameForDisplayUrl(tab.url);
            if (!tab.title || tab.title === 'New Tab' || (previousHost && nextHost && previousHost !== nextHost)) {
                tab.title = this.getFallbackTitleForUrl(tab.url);
            }
            this.mainWindow.webContents.send('loading-changed', {
                tabId,
                loading: false,
                url: tab.url,
                canGoBack: tab.view.webContents.canGoBack(),
                canGoForward: tab.view.webContents.canGoForward(),
                hostingProvider: tab.hostingProvider,
                hnsProfile: tab.hnsProfile,
                securityInfo: tab.securityInfo
            });
            this.sendTabUpdated(tab);
        } catch (error) {
            this.log('navigation-url-update-error', { tabId, navigationUrl, message: error.message });
        }
    }

    async updateHNSMetadataForNavigation(tab, parsedUrl) {
        const hostname = this.normalizeGatewayHost(parsedUrl.hostname);
        try {
            const resolution = await this.resolveHNS(hostname);
            if (resolution) {
                tab.hostingProvider = this.getHostingProviderForResolution(resolution);
                tab.hnsProfile = resolution.hnsProfile || null;
                tab.securityInfo = parsedUrl.protocol === 'http:'
                    ? this.buildSecurityInfo('hns-http', { domain: hostname })
                    : tab.securityInfo;
                if (resolution.address) {
                    this.hnsProxyHosts.set(hostname, resolution.address);
                }
                return;
            }
        } catch (error) {
            this.log('hns-navigation-metadata-error', { host: hostname, message: error.message });
        }

        tab.hostingProvider = null;
        tab.hnsProfile = null;
        tab.securityInfo = this.buildSecurityInfo('hns-unresolved', { domain: hostname });
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
        const attempts = 1;
        const startedAt = Date.now();

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            const attemptStartedAt = Date.now();
            try {
                const result = await this.hnsResolver.resolveHNSDomain(domain);
                if (result) {
                    this.log('hns-resolution-complete', {
                        attempt,
                        elapsedMs: Date.now() - startedAt,
                        attemptElapsedMs: Date.now() - attemptStartedAt,
                        ...this.getResolutionDiagnostics(result)
                    });
                    return result;
                }

                this.log('hns-resolution-empty', {
                    attempt,
                    elapsedMs: Date.now() - startedAt,
                    attemptElapsedMs: Date.now() - attemptStartedAt
                });
            } catch (error) {
                this.log('hns-resolution-error', {
                    attempt,
                    message: error.message,
                    elapsedMs: Date.now() - startedAt,
                    attemptElapsedMs: Date.now() - attemptStartedAt
                });
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
            hasHnsBioProfile: Boolean(resolution.hnsProfile?.entries?.length),
            hasAddress: Boolean(resolution.address),
            hasUrl: Boolean(resolution.url)
        };
    }

    buildHttpsUpgradeUrl(parsedUrl, domain) {
        const upgradeUrl = new URL(parsedUrl.toString());
        upgradeUrl.protocol = 'https:';
        upgradeUrl.hostname = domain;
        upgradeUrl.port = '';
        return upgradeUrl.toString();
    }

    async checkHnsHttpsAvailability(tabId, check) {
        if (!check?.domain || !check?.address || !check?.upgradeUrl) {
            return;
        }

        const tab = this.tabs.get(tabId);
        if (!tab || tab.id !== this.activeTabId || tab.loading) {
            return;
        }

        const cacheKey = `${check.domain}|${check.address}|${check.port || 443}`.toLowerCase();
        const cached = this.hnsHttpsAvailabilityCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < this.hnsHttpsAvailabilityTtlMs) {
            this.log('hns-https-availability-cache-hit', {
                domain: check.domain,
                state: cached.state,
                elapsedMs: 0
            });
            if (cached.state === 'verified') {
                this.sendStatusMessage(`DANE-verified HTTPS is available for ${check.domain}.`, 'success', {
                    label: 'Open HTTPS',
                    url: check.upgradeUrl
                });
            }
            return;
        }

        const startedAt = Date.now();

        let records = [];
        try {
            records = await this.hnsResolver.resolveTLSARecords(check.domain, {
                timeout: this.getDaneLookupTimeout()
            });
        } catch (error) {
            this.log('hns-https-availability-tlsa-error', {
                domain: check.domain,
                message: error.message,
                elapsedMs: Date.now() - startedAt
            });
            return;
        }

        if (!records.length) {
            this.hnsHttpsAvailabilityCache.set(cacheKey, { state: 'no_tlsa', timestamp: Date.now() });
            this.log('hns-https-availability-none', {
                domain: check.domain,
                elapsedMs: Date.now() - startedAt
            });
            return;
        }

        const probe = await inspectHnsHttpsCertificate({
            domain: check.domain,
            address: check.address,
            port: check.port || 443,
            timeout: this.getDaneProbeTimeout()
        });

        if (!probe.ok) {
            this.log('hns-https-availability-probe-failed', {
                domain: check.domain,
                state: probe.state,
                error: probe.error,
                elapsedMs: Date.now() - startedAt
            });
            return;
        }

        const daneResult = await this.hnsResolver.verifyDANE(check.domain, probe.certificate, {
            force: true,
            records
        });

        this.log('hns-https-availability-dane-result', {
            domain: check.domain,
            state: daneResult.state,
            supportedRecords: daneResult.supportedRecords,
            unsupportedRecords: daneResult.unsupportedRecords,
            elapsedMs: Date.now() - startedAt
        });

        if (daneResult.state !== 'verified') {
            this.hnsHttpsAvailabilityCache.set(cacheKey, {
                state: daneResult.state,
                timestamp: Date.now()
            });
            return;
        }

        this.hnsHttpsAvailabilityCache.set(cacheKey, {
            state: 'verified',
            timestamp: Date.now()
        });
        this.rememberDaneVerifiedCertificate(check.domain, probe.certificate);

        if (this.tabs.get(tabId) !== tab || tab.id !== this.activeTabId || tab.loading) {
            return;
        }

        this.sendStatusMessage(`DANE-verified HTTPS is available for ${check.domain}.`, 'success', {
            label: 'Open HTTPS',
            url: check.upgradeUrl
        });
    }

    async buildHNSNavigation(originalUrl, resolution) {
        const parsedUrl = new URL(originalUrl);
        const hostingProvider = this.getHostingProviderForResolution(resolution);

        if (typeof resolution === 'string') {
            return { url: resolution };
        }

        if (resolution.url && !resolution.address) {
            return { url: resolution.url, hostingProvider, hnsProfile: resolution.hnsProfile || null };
        }

        if (resolution.address) {
            if (parsedUrl.protocol === 'https:') {
                return await this.buildHNSHttpsNavigation(originalUrl, resolution, hostingProvider);
            }

            parsedUrl.protocol = 'http:';

            return {
                url: parsedUrl.toString(),
                displayUrl: `${resolution.domain}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`,
                hnsHostHeader: resolution.domain,
                proxyHost: resolution.domain,
                resolvedHost: resolution.address,
                bypassCache: true,
                hostingProvider,
                hnsProfile: resolution.hnsProfile || null,
                securityInfo: this.buildSecurityInfo('hns-http', { domain: resolution.domain }),
                httpsAvailabilityCheck: {
                    domain: resolution.domain,
                    address: resolution.address,
                    port: 443,
                    upgradeUrl: this.buildHttpsUpgradeUrl(parsedUrl, resolution.domain)
                }
            };
        }

        if (resolution.url) {
            return { url: resolution.url, hostingProvider, hnsProfile: resolution.hnsProfile || null };
        }

        throw new Error(`No browsable HNS records found for ${resolution.domain}`);
    }

    async buildHNSHttpsNavigation(originalUrl, resolution, hostingProvider = null) {
        const parsedUrl = new URL(originalUrl);
        const domain = resolution.domain || parsedUrl.hostname;
        const fallbackUrl = new URL(originalUrl);
        fallbackUrl.protocol = 'http:';
        const startedAt = Date.now();

        if (this.getActiveDaneTrust(domain)) {
            this.log('hns-dane-trust-cache-hit', {
                domain,
                elapsedMs: Date.now() - startedAt
            });
            return {
                url: parsedUrl.toString(),
                displayUrl: parsedUrl.toString(),
                proxyHost: domain,
                resolvedHost: resolution.address,
                bypassCache: false,
                hostingProvider,
                hnsProfile: resolution.hnsProfile || null,
                securityInfo: this.buildSecurityInfo('hns-dane', { domain, state: 'verified' })
            };
        }

        let records = [];
        try {
            records = await this.hnsResolver.resolveTLSARecords(domain, {
                timeout: this.getDaneLookupTimeout()
            });
        } catch (error) {
            this.log('hns-dane-resolver-failure', {
                domain,
                message: error.message,
                elapsedMs: Date.now() - startedAt
            });
            return this.buildHNSHttpsStatusNavigation({
                originalUrl,
                fallbackUrl: fallbackUrl.toString(),
                domain,
                state: 'resolver_failure',
                error: error.message,
                hostingProvider,
                hnsProfile: resolution.hnsProfile || null
            });
        }

        if (!records.length) {
            this.log('hns-dane-no-tlsa', {
                domain,
                elapsedMs: Date.now() - startedAt
            });
            return this.buildHNSHttpsStatusNavigation({
                originalUrl,
                fallbackUrl: fallbackUrl.toString(),
                domain,
                state: 'no_tlsa',
                hostingProvider,
                hnsProfile: resolution.hnsProfile || null
            });
        }

        const probe = await inspectHnsHttpsCertificate({
            domain,
            address: resolution.address,
            port: parsedUrl.port ? Number(parsedUrl.port) : 443,
            timeout: this.getDaneProbeTimeout()
        });

        if (!probe.ok) {
            this.log('hns-dane-connection-failure', {
                domain,
                state: probe.state,
                error: probe.error,
                elapsedMs: Date.now() - startedAt
            });
            return this.buildHNSHttpsStatusNavigation({
                originalUrl,
                fallbackUrl: fallbackUrl.toString(),
                domain,
                state: probe.state || 'connection_failure',
                error: probe.error,
                hostingProvider,
                hnsProfile: resolution.hnsProfile || null
            });
        }

        const daneResult = await this.hnsResolver.verifyDANE(domain, probe.certificate, {
            force: true,
            records
        });

        this.log('hns-dane-result', {
            domain,
            state: daneResult.state,
            supportedRecords: daneResult.supportedRecords,
            unsupportedRecords: daneResult.unsupportedRecords,
            elapsedMs: Date.now() - startedAt
        });

        if (daneResult.state === 'verified') {
            const trust = this.rememberDaneVerifiedCertificate(domain, probe.certificate);
            if (trust) {
                return {
                    url: parsedUrl.toString(),
                    displayUrl: parsedUrl.toString(),
                    proxyHost: domain,
                    resolvedHost: resolution.address,
                    bypassCache: true,
                    hostingProvider,
                    hnsProfile: resolution.hnsProfile || null,
                    securityInfo: this.buildSecurityInfo('hns-dane', { domain, state: daneResult.state })
                };
            }

            return this.buildHNSHttpsStatusNavigation({
                originalUrl,
                fallbackUrl: fallbackUrl.toString(),
                domain,
                state: 'connection_failure',
                error: 'DANE verified, but SkyInclude could not pin the certificate fingerprint for rendering.',
                hostingProvider,
                hnsProfile: resolution.hnsProfile || null
            });
        }

        return this.buildHNSHttpsStatusNavigation({
            originalUrl,
            fallbackUrl: fallbackUrl.toString(),
            domain,
            state: daneResult.state,
            error: daneResult.error,
            hostingProvider,
            hnsProfile: resolution.hnsProfile || null
        });
    }

    buildHNSHttpsStatusNavigation({ originalUrl, fallbackUrl, domain, state, error = null, hostingProvider = null, hnsProfile = null }) {
        const parsedUrl = new URL(originalUrl);
        return {
            url: this.buildHNSHttpsStatusDataUrl({ domain, originalUrl, fallbackUrl, state, error }),
            displayUrl: `${domain}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`,
            bypassCache: true,
            hostingProvider,
            hnsProfile,
            securityInfo: this.buildSecurityInfo('hns-dane', { domain, state, error })
        };
    }

    buildHNSHttpsStatusDataUrl({ domain, originalUrl, fallbackUrl, state, error = null }) {
        const states = {
            verified: {
                title: 'HNS DANE Verified',
                body: 'This server certificate matches the published HNS TLSA record. Rendering native HNS HTTPS still needs the scoped Chromium trust path before pages load directly.',
                severity: 'success'
            },
            no_tlsa: {
                title: 'No HNS TLSA Record Found',
                body: 'This site can still be opened over native HNS HTTP, but it is not DANE verified.',
                severity: 'warning'
            },
            tlsa_mismatch: {
                title: 'HNS TLSA Mismatch',
                body: 'This site published a TLSA record, but it does not match the HTTPS server certificate.',
                severity: 'danger'
            },
            cert_expired: {
                title: 'Certificate Expired',
                body: 'This site published TLSA data, but the HTTPS certificate is expired.',
                severity: 'danger'
            },
            cert_not_yet_valid: {
                title: 'Certificate Not Yet Valid',
                body: 'This site published TLSA data, but the HTTPS certificate is not valid yet.',
                severity: 'danger'
            },
            unsupported_record: {
                title: 'Unsupported TLSA Record',
                body: 'This site published TLSA data using a format this version does not support yet.',
                severity: 'danger'
            },
            resolver_failure: {
                title: 'TLSA Resolver Failure',
                body: 'SkyInclude could not check this site\'s HNS TLSA record.',
                severity: 'danger'
            },
            connection_failure: {
                title: 'HTTPS Connection Failed',
                body: 'SkyInclude could not inspect this site\'s HTTPS certificate.',
                severity: 'danger'
            }
        };
        const details = states[state] || states.connection_failure;
        const canFallback = state === 'no_tlsa';
        const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${this.escapeHtml(details.title)}</title>
<style>
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #1f2933; }
main { max-width: 680px; margin: 12vh auto; padding: 0 24px; }
.panel { border: 1px solid #d8dee6; background: #fff; border-radius: 8px; padding: 28px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
.eyebrow { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; color: #64748b; }
h1 { margin: 0 0 12px; font-size: 26px; line-height: 1.2; }
p { margin: 0 0 16px; line-height: 1.55; }
.url { overflow-wrap: anywhere; color: #475569; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
a.button { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 0 14px; border-radius: 6px; text-decoration: none; font-weight: 650; }
a.primary { background: #116466; color: #fff; }
a.secondary { border: 1px solid #cbd5e1; color: #243b53; background: #fff; }
.danger { border-top: 4px solid #b42318; }
.warning { border-top: 4px solid #b7791f; }
.success { border-top: 4px solid #0f766e; }
.error { margin-top: 16px; color: #7f1d1d; font-size: 13px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
<section class="panel ${this.escapeHtml(details.severity)}">
<p class="eyebrow">${this.escapeHtml(domain)}</p>
<h1>${this.escapeHtml(details.title)}</h1>
<p>${this.escapeHtml(details.body)}</p>
<p class="url">${this.escapeHtml(originalUrl)}</p>
${error ? `<p class="error">${this.escapeHtml(error)}</p>` : ''}
<div class="actions">
${canFallback ? `<a class="button primary" href="${this.escapeHtml(fallbackUrl)}">Open Native HNS HTTP</a>` : ''}
<a class="button secondary" href="about:blank" onclick="if (history.length > 1) { history.back(); return false; }">Cancel</a>
</div>
</section>
</main>
</body>
</html>`;

        return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    }

    buildHNSStatusDataUrl({ title, domain, body, originalUrl, error = null, severity = 'warning', actions = [] }) {
        const actionLinks = actions.map(action => {
            const classes = action.primary ? 'button primary' : 'button secondary';
            return `<a class="${classes}" href="${this.escapeHtml(action.href)}">${this.escapeHtml(action.label)}</a>`;
        }).join('');
        const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${this.escapeHtml(title)}</title>
<style>
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #1f2933; }
main { max-width: 680px; margin: 12vh auto; padding: 0 24px; }
.panel { border: 1px solid #d8dee6; background: #fff; border-radius: 8px; padding: 28px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
.eyebrow { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; color: #64748b; }
h1 { margin: 0 0 12px; font-size: 26px; line-height: 1.2; }
p { margin: 0 0 16px; line-height: 1.55; }
.url { overflow-wrap: anywhere; color: #475569; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
a.button { display: inline-flex; align-items: center; justify-content: center; min-height: 38px; padding: 0 14px; border-radius: 6px; text-decoration: none; font-weight: 650; }
a.primary { background: #116466; color: #fff; }
a.secondary { border: 1px solid #cbd5e1; color: #243b53; background: #fff; }
.danger { border-top: 4px solid #b42318; }
.warning { border-top: 4px solid #b7791f; }
.success { border-top: 4px solid #0f766e; }
.error { margin-top: 16px; color: #7f1d1d; font-size: 13px; overflow-wrap: anywhere; }
</style>
</head>
<body>
<main>
<section class="panel ${this.escapeHtml(severity)}">
<p class="eyebrow">${this.escapeHtml(domain)}</p>
<h1>${this.escapeHtml(title)}</h1>
<p>${this.escapeHtml(body)}</p>
<p class="url">${this.escapeHtml(originalUrl)}</p>
${error ? `<p class="error">${this.escapeHtml(error)}</p>` : ''}
<div class="actions">${actionLinks}</div>
</section>
</main>
</body>
</html>`;

        return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
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
            hnsProfile: null,
            bypassCache: true,
            securityInfo: this.buildSecurityInfo('hns-unresolved', { domain: parsedUrl.hostname })
        };
    }

    async buildUnresolvedHNSStatusNavigation(originalUrl, hostname) {
        const parsedUrl = new URL(originalUrl);
        const serviceName = `_443._tcp.${hostname}`;
        const settings = this.hnsResolver.getResolverSettings();
        const timeout = this.settingsManager.getSetting('hnsTimeout') || settings.timeout || 15000;
        const fallbackUrl = new URL(originalUrl);
        fallbackUrl.protocol = 'http:';

        const [serviceARecords, serviceTlsaRecords] = await Promise.all([
            this.hnsResolver.queryDoh(settings.dohResolver, serviceName, 'A', timeout).catch(() => []),
            this.hnsResolver.resolveTLSARecords(hostname).catch(() => [])
        ]);
        const body = serviceARecords.length && !serviceTlsaRecords.length
            ? `A record found at ${serviceName}, but the website itself needs an A/AAAA record at ${hostname}. DANE also needs a TLSA record at ${serviceName}, not an A record there.`
            : `No browsable HNS A/AAAA/CNAME record was found for ${hostname}.`;

        this.log('hns-unresolved-status', {
            host: hostname,
            serviceARecords: serviceARecords.length,
            serviceTlsaRecords: serviceTlsaRecords.length
        });

        return {
            url: this.buildHNSStatusDataUrl({
                title: 'HNS Site Not Resolved',
                domain: hostname,
                body,
                originalUrl,
                severity: 'danger',
                actions: [
                    { label: 'Try Native HNS HTTP', href: fallbackUrl.toString(), primary: true },
                    { label: 'Cancel', href: 'about:blank' }
                ]
            }),
            displayUrl: `${hostname}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`,
            bypassCache: true,
            hostingProvider: null,
            hnsProfile: null,
            securityInfo: this.buildSecurityInfo('hns-unresolved', { domain: hostname })
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

    getHostingProviderForUrl(inputUrl) {
        try {
            const parsedUrl = new URL(inputUrl);
            const hostname = parsedUrl.hostname.toLowerCase();
            if (hostname === 'github.io' || hostname.endsWith('.github.io') || hostname === 'pages.github.com') {
                return 'github-pages';
            }
        } catch (error) {
            return null;
        }

        return null;
    }

    addToHistory(url, title, favicon = null) {
        if (this.settingsManager.getSetting('saveHistory') === false) {
            return;
        }

        const historyManager = require('./history.js');
        historyManager.addEntry(url, title, Date.now(), favicon);
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
        this.hnsProxyServer.on('connect', (clientReq, clientSocket, head) => {
            this.handleHnsProxyConnect(clientReq, clientSocket, head);
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

        this.configureDaneCertificateVerifierForSession(electronSession);

        if (this.proxyConfiguredSessions.has(electronSession)) {
            return;
        }

        await electronSession.setProxy({
            proxyRules: `http=127.0.0.1:${this.hnsProxyPort};https=127.0.0.1:${this.hnsProxyPort}`,
            proxyBypassRules: 'localhost;127.0.0.1'
        });

        if (typeof electronSession.closeAllConnections === 'function') {
            await electronSession.closeAllConnections();
        }

        const proxyForHns = await electronSession.resolveProxy('http://skyinclude/');
        this.proxyConfiguredSessions.add(electronSession);
        this.log('proxy-configured', { port: this.hnsProxyPort, proxyForHns });
    }

    configureDaneCertificateVerifierForSession(electronSession) {
        if (this.certificateVerifierConfiguredSessions.has(electronSession)) {
            return;
        }

        electronSession.setCertificateVerifyProc((request, callback) => {
            const hostname = this.normalizeGatewayHost(String(request.hostname || '').toLowerCase());
            const certificate = request.certificate || null;

            if (this.isDaneVerifiedCertificateAllowed(hostname, certificate)) {
                this.log('hns-dane-cert-accepted', { hostname });
                callback(0);
                return;
            }

            const verificationResult = String(request.verificationResult || '').toUpperCase();
            if (request.errorCode === 0 || verificationResult === 'OK') {
                callback(0);
                return;
            }

            if (hostname && this.isHNSDomain(hostname)) {
                this.log('hns-dane-cert-rejected', {
                    hostname,
                    verificationResult: request.verificationResult || null,
                    errorCode: request.errorCode || null
                });
            }

            callback(-2);
        });

        this.certificateVerifierConfiguredSessions.add(electronSession);
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

            if (!isHnsHost) {
                address = requestUrl.hostname;
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

    async handleHnsProxyConnect(clientReq, clientSocket, head) {
        try {
            const [rawHost, rawPort] = String(clientReq.url || '').split(':');
            const host = this.normalizeGatewayHost(String(rawHost || '').toLowerCase());
            const port = Number(rawPort) || 443;
            const isHnsHost = this.isHNSDomain(host);

            let address = isHnsHost ? this.hnsProxyHosts.get(host) : rawHost;
            if (isHnsHost && !address) {
                const resolution = await this.resolveHNS(host);
                address = resolution && resolution.address;
                if (address) {
                    this.hnsProxyHosts.set(host, address);
                }
            }

            if (isHnsHost && !address) {
                clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                clientSocket.destroy();
                return;
            }

            this.log('hns-proxy-connect', {
                host,
                address,
                port
            });

            const upstreamSocket = net.connect(port, address, () => {
                clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                if (head && head.length) {
                    upstreamSocket.write(head);
                }
                upstreamSocket.pipe(clientSocket);
                clientSocket.pipe(upstreamSocket);
            });

            upstreamSocket.on('error', error => {
                this.log('hns-proxy-connect-error', { host, address, message: error.message });
                if (!clientSocket.destroyed) {
                    clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
                    clientSocket.destroy();
                }
            });

            clientSocket.on('error', () => {
                upstreamSocket.destroy();
            });
        } catch (error) {
            this.log('hns-proxy-connect-request-error', { url: clientReq.url, message: error.message });
            if (!clientSocket.destroyed) {
                clientSocket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
                clientSocket.destroy();
            }
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

    showSecurityPopover(payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            return;
        }

        const info = this.sanitizeSecurityInfo(payload.info);
        const anchor = payload.anchor && typeof payload.anchor === 'object' ? payload.anchor : {};
        const parentBounds = this.mainWindow.getBounds();
        const width = 370;
        const height = Math.min(520, 122 + info.details.length * 56);
        const x = Math.min(
            Math.max(parentBounds.x + 12, parentBounds.x + Math.round(Number(anchor.left) || 0) - 18),
            parentBounds.x + parentBounds.width - width - 12
        );
        const y = Math.min(
            parentBounds.y + parentBounds.height - height - 12,
            parentBounds.y + Math.round(Number(anchor.bottom) || 90) + 8
        );

        this.closeSecurityPopover();
        this.securityPopover = new BrowserWindow({
            parent: this.mainWindow,
            x,
            y,
            width,
            height,
            frame: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true
            }
        });

        this.securityPopover.on('blur', () => this.closeSecurityPopover());
        this.securityPopover.on('closed', () => {
            this.securityPopover = null;
        });

        this.securityPopover.loadURL(this.buildSecurityPopoverDataUrl(info)).catch(error => {
            this.log('security-popover-error', { message: error.message });
        });
        this.securityPopover.once('ready-to-show', () => {
            if (this.securityPopover && !this.securityPopover.isDestroyed()) {
                this.securityPopover.show();
            }
        });
    }

    closeSecurityPopover() {
        if (this.securityPopover && !this.securityPopover.isDestroyed()) {
            this.securityPopover.close();
        }
        this.securityPopover = null;
    }

    sanitizeSecurityInfo(info) {
        const safeInfo = info && typeof info === 'object' ? info : {};
        const details = Array.isArray(safeInfo.details) ? safeInfo.details.slice(0, 8) : [];
        return {
            kicker: String(safeInfo.kicker || 'Connection').slice(0, 40),
            title: String(safeInfo.title || 'Connection information').slice(0, 80),
            summary: String(safeInfo.summary || 'No additional security information is available.').slice(0, 500),
            details: details.map(entry => {
                const label = Array.isArray(entry) ? entry[0] : '';
                const value = Array.isArray(entry) ? entry[1] : '';
                return [
                    String(label || 'Detail').slice(0, 48),
                    String(value || '').slice(0, 500)
                ];
            }).filter(([, value]) => value)
        };
    }

    buildSecurityPopoverDataUrl(info) {
        const rows = info.details.map(([label, value]) => `
            <div class="row">
                <div class="label">${this.escapeHtml(label)}</div>
                <div class="value">${this.escapeHtml(value)}</div>
            </div>
        `).join('');

        const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
.card { border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 12px 28px rgba(15, 23, 42, .22); height: 100vh; overflow: hidden; }
.header { align-items: center; background: #f8fafc; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; padding: 14px 16px; }
.kicker { color: #64748b; font-size: 11px; font-weight: 800; margin-bottom: 3px; text-transform: uppercase; }
.title { color: #111827; font-size: 17px; font-weight: 800; line-height: 1.2; max-width: 286px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.close { align-items: center; background: transparent; border: 0; border-radius: 4px; color: #6b7280; cursor: pointer; display: flex; font-size: 28px; height: 34px; justify-content: center; width: 34px; }
.close:hover { background: #eef2f7; color: #374151; }
.body { max-height: calc(100vh - 74px); overflow-y: auto; padding: 14px 16px; }
.summary { color: #374151; font-size: 14px; line-height: 1.45; margin-bottom: 12px; }
.row { border-top: 1px solid #eef2f7; padding: 10px 0 0; margin-top: 10px; }
.label { color: #64748b; font-size: 11px; font-weight: 800; margin-bottom: 4px; text-transform: uppercase; }
.value { color: #111827; font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; user-select: text; }
</style>
</head>
<body>
<div class="card">
    <div class="header">
        <div>
            <div class="kicker">${this.escapeHtml(info.kicker)}</div>
            <div class="title">${this.escapeHtml(info.title)}</div>
        </div>
        <button class="close" onclick="window.close()" title="Close">×</button>
    </div>
    <div class="body">
        <div class="summary">${this.escapeHtml(info.summary)}</div>
        ${rows}
    </div>
</div>
</body>
</html>`;

        return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    }

    showHnsProfilePopover(payload = {}) {
        if (!this.mainWindow || this.mainWindow.isDestroyed()) {
            return;
        }

        const profile = this.sanitizeHnsProfile(payload.profile);
        if (!profile) {
            this.closeHnsProfilePopover();
            return;
        }

        const anchor = payload.anchor && typeof payload.anchor === 'object' ? payload.anchor : {};
        const parentBounds = this.mainWindow.getBounds();
        const width = 340;
        const height = Math.min(520, 110 + profile.entries.length * 70);
        const x = Math.min(
            Math.max(parentBounds.x + 12, parentBounds.x + Math.round(Number(anchor.left) || 0) - 24),
            parentBounds.x + parentBounds.width - width - 12
        );
        const y = Math.min(
            parentBounds.y + parentBounds.height - height - 12,
            parentBounds.y + Math.round(Number(anchor.bottom) || 90) + 8
        );

        this.closeHnsProfilePopover();
        this.hnsProfilePopover = new BrowserWindow({
            parent: this.mainWindow,
            x,
            y,
            width,
            height,
            frame: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            skipTaskbar: true,
            show: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true
            }
        });

        this.hnsProfilePopover.on('blur', () => this.closeHnsProfilePopover());
        this.hnsProfilePopover.on('closed', () => {
            this.hnsProfilePopover = null;
        });

        this.hnsProfilePopover.loadURL(this.buildHnsProfilePopoverDataUrl(profile)).catch(error => {
            this.log('hns-profile-popover-error', { message: error.message });
        });
        this.hnsProfilePopover.once('ready-to-show', () => {
            if (this.hnsProfilePopover && !this.hnsProfilePopover.isDestroyed()) {
                this.hnsProfilePopover.show();
            }
        });
    }

    closeHnsProfilePopover() {
        if (this.hnsProfilePopover && !this.hnsProfilePopover.isDestroyed()) {
            this.hnsProfilePopover.close();
        }
        this.hnsProfilePopover = null;
    }

    sanitizeHnsProfile(profile) {
        if (!profile || !Array.isArray(profile.entries) || !profile.entries.length) {
            return null;
        }

        const entries = profile.entries.slice(0, 16).map(entry => ({
            label: String(entry.label || entry.key || 'Record').slice(0, 40),
            value: String(entry.value || '').slice(0, 500)
        })).filter(entry => entry.value);

        return entries.length ? {
            domain: String(profile.domain || 'HNS profile').slice(0, 120),
            entries
        } : null;
    }

    buildHnsProfilePopoverDataUrl(profile) {
        const entriesJson = JSON.stringify(profile.entries).replace(/</g, '\\u003c');
        const rows = profile.entries.map((entry, index) => `
            <button class="row" type="button" data-index="${index}" title="Copy ${this.escapeHtml(entry.label)}">
                <span class="label">${this.escapeHtml(entry.label)}</span>
                <span class="value">${this.escapeHtml(entry.value)}</span>
                <span class="copy-state">Copy</span>
            </button>
        `).join('');

        const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #fff; color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
.card { border: 1px solid #d1d5db; border-radius: 8px; box-shadow: 0 12px 28px rgba(15, 23, 42, .22); height: 100vh; overflow: hidden; }
.header { align-items: center; background: #f8fafc; border-bottom: 1px solid #e5e7eb; display: flex; justify-content: space-between; padding: 14px 16px; }
.domain { color: #111827; font-size: 20px; font-weight: 800; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; }
.close { align-items: center; background: transparent; border: 0; border-radius: 4px; color: #6b7280; cursor: pointer; display: flex; font-size: 28px; height: 34px; justify-content: center; width: 34px; }
.close:hover { background: #eef2f7; color: #374151; }
.list { max-height: calc(100vh - 78px); overflow-y: auto; padding: 6px 0; }
.row { background: #fff; border: 0; border-bottom: 1px solid #f3f4f6; color: inherit; cursor: pointer; display: block; font: inherit; padding: 11px 16px; position: relative; text-align: left; width: 100%; }
.row:hover { background: #f8fafc; }
.row:last-child { border-bottom: 0; }
.label { color: #64748b; display: block; font-size: 12px; font-weight: 800; margin-bottom: 6px; text-transform: uppercase; }
.value { color: #111827; display: block; font-size: 15px; line-height: 1.35; overflow-wrap: anywhere; padding-right: 44px; user-select: text; }
.copy-state { color: #15803d; font-size: 11px; font-weight: 800; opacity: 0; position: absolute; right: 16px; top: 14px; transition: opacity .15s ease; }
.row:hover .copy-state, .row.copied .copy-state { opacity: 1; }
.row.copied .copy-state { color: #166534; }
</style>
</head>
<body>
<div class="card">
    <div class="header">
        <div class="domain">${this.escapeHtml(profile.domain)}</div>
        <button class="close" onclick="window.close()" title="Close">×</button>
    </div>
    <div class="list">${rows}</div>
</div>
<script>
const entries = ${entriesJson};
function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
}
async function copyValue(row, value) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(value);
        } else if (!fallbackCopy(value)) {
            throw new Error('copy failed');
        }
        const state = row.querySelector('.copy-state');
        row.classList.add('copied');
        if (state) state.textContent = 'Copied';
        setTimeout(() => {
            row.classList.remove('copied');
            if (state) state.textContent = 'Copy';
        }, 1400);
    } catch (error) {
        const state = row.querySelector('.copy-state');
        if (state) state.textContent = 'Select';
    }
}
document.querySelectorAll('.row').forEach(row => {
    row.addEventListener('click', () => {
        const entry = entries[Number(row.dataset.index)];
        if (entry && entry.value) {
            copyValue(row, entry.value);
        }
    });
});
</script>
</body>
</html>`;

        return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
    }

    escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, character => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]);
    }

    sendStatusMessage(message, type = 'info', action = null) {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('show-status-message', { message, type, action });
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

    showPageContextMenu(webContents, params = {}) {
        const menuItems = [];

        if (params.linkURL) {
            menuItems.push(
                {
                    label: 'Open Link in New Tab',
                    click: () => {
                        this.createNewTab(params.linkURL).catch(error => {
                            this.log('context-open-link-error', { message: error.message });
                        });
                    }
                },
                {
                    label: 'Copy Link',
                    click: () => clipboard.writeText(params.linkURL)
                },
                { type: 'separator' }
            );
        }

        if (params.hasSelection && !params.isEditable) {
            menuItems.push({
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                click: () => webContents.copy()
            });
        }

        if (params.isEditable) {
            if (menuItems.length) {
                menuItems.push({ type: 'separator' });
            }
            menuItems.push(
                {
                    label: 'Cut',
                    accelerator: 'CmdOrCtrl+X',
                    click: () => webContents.cut()
                },
                {
                    label: 'Copy',
                    accelerator: 'CmdOrCtrl+C',
                    click: () => webContents.copy()
                },
                {
                    label: 'Paste',
                    accelerator: 'CmdOrCtrl+V',
                    click: () => webContents.paste()
                },
                { type: 'separator' },
                {
                    label: 'Select All',
                    accelerator: 'CmdOrCtrl+A',
                    click: () => webContents.selectAll()
                }
            );
        } else {
            if (menuItems.length) {
                menuItems.push({ type: 'separator' });
            }
            menuItems.push(
                {
                    label: 'Back',
                    enabled: webContents.canGoBack(),
                    click: () => webContents.goBack()
                },
                {
                    label: 'Forward',
                    enabled: webContents.canGoForward(),
                    click: () => webContents.goForward()
                },
                {
                    label: 'Reload',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => webContents.reload()
                },
                { type: 'separator' },
                {
                    label: 'Select All',
                    accelerator: 'CmdOrCtrl+A',
                    click: () => webContents.selectAll()
                }
            );
        }

        Menu.buildFromTemplate(menuItems).popup({ window: this.mainWindow });
    }

    showEditContextMenu() {
        Menu.buildFromTemplate([
            { role: 'cut', label: 'Cut' },
            { role: 'copy', label: 'Copy' },
            { role: 'paste', label: 'Paste' },
            { type: 'separator' },
            { role: 'selectAll', label: 'Select All' }
        ]).popup({ window: this.mainWindow });
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
                favicon: tab.favicon,
                hostingProvider: tab.hostingProvider,
                hnsProfile: tab.hnsProfile,
                securityInfo: tab.securityInfo,
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

        ipcMain.handle('show-security-popover', (event, payload) => {
            this.requireTrustedIpcSender(event, 'show-security-popover');
            this.showSecurityPopover(payload);
        });

        ipcMain.handle('hide-security-popover', (event) => {
            this.requireTrustedIpcSender(event, 'hide-security-popover');
            this.closeSecurityPopover();
        });

        ipcMain.handle('show-hns-profile-popover', (event, payload) => {
            this.requireTrustedIpcSender(event, 'show-hns-profile-popover');
            this.showHnsProfilePopover(payload);
        });

        ipcMain.handle('hide-hns-profile-popover', (event) => {
            this.requireTrustedIpcSender(event, 'hide-hns-profile-popover');
            this.closeHnsProfilePopover();
        });

        ipcMain.handle('show-edit-context-menu', (event) => {
            this.requireTrustedIpcSender(event, 'show-edit-context-menu');
            this.showEditContextMenu();
        });

        ipcMain.handle('set-browser-view-visible', (event, visible) => {
            this.requireTrustedIpcSender(event, 'set-browser-view-visible');
            this.setBrowserViewVisible(visible === true);
        });

        ipcMain.handle('set-status-bar-visible', (event, visible) => {
            this.requireTrustedIpcSender(event, 'set-status-bar-visible');
            this.setStatusBarVisible(visible === true);
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
