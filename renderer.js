// Renderer Process Script for SkyInclude Browser

class SkyIncludeRenderer {
    constructor() {
        this.tabs = new Map();
        this.activeTabId = null;
        this.currentUrl = '';
        
        this.initializeElements();
        this.setupEventListeners();
        this.setupIpcListeners();
        this.loadInitialState();
    }

    initializeElements() {
        // Navigation elements
        this.backBtn = document.getElementById('back-btn');
        this.forwardBtn = document.getElementById('forward-btn');
        this.reloadBtn = document.getElementById('reload-btn');
        this.addressBar = document.getElementById('address-bar');
        this.loadingIndicator = document.getElementById('loading-indicator');
        this.securityIndicator = document.getElementById('security-indicator');
        this.hostingIndicator = document.getElementById('hosting-indicator');
        this.hnsProfileBtn = document.getElementById('hns-profile-btn');
        this.hnsProfilePopover = document.getElementById('hns-profile-popover');
        this.hnsProfileDomain = document.getElementById('hns-profile-domain');
        this.hnsProfileList = document.getElementById('hns-profile-list');
        this.closeHnsProfileBtn = document.getElementById('close-hns-profile');
        this.clearCacheBtn = document.getElementById('clear-cache-btn');
        this.updateBtn = document.getElementById('update-btn');
        this.appVersionBadge = document.getElementById('app-version-badge');
        this.menuVersionLabel = document.getElementById('menu-version-label');
        
        // Tab elements
        this.tabsContainer = document.getElementById('tabs-container');
        this.newTabBtn = document.getElementById('new-tab-btn');
        
        // Menu and modals
        this.menuBtn = document.getElementById('menu-btn');
        this.menuDropdown = document.getElementById('menu-dropdown');
        this.statusBar = document.getElementById('status-bar');
        this.statusText = document.getElementById('status-text');
        this.closeStatusBtn = document.getElementById('close-status');
        
        // Modals
        this.historyModal = document.getElementById('history-modal');
        this.settingsModal = document.getElementById('settings-modal');
        this.historyList = document.getElementById('history-list');
        
    }

    setupEventListeners() {
        // Navigation
        this.backBtn.addEventListener('click', () => this.goBack());
        this.forwardBtn.addEventListener('click', () => this.goForward());
        this.reloadBtn.addEventListener('click', () => this.reload());
        
        // Address bar
        this.addressBar.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.navigateToUrl(this.addressBar.value);
            }
        });
        
        this.addressBar.addEventListener('focus', () => {
            this.addressBar.select();
        });

        this.addressBar.addEventListener('contextmenu', async (e) => {
            e.preventDefault();
            try {
                await window.electronAPI.showEditContextMenu();
            } catch (error) {
                console.error('Failed to show address bar edit menu:', error);
            }
        });
        
        // Tab management
        this.newTabBtn.addEventListener('click', () => this.createNewTab());

        // Troubleshooting
        this.clearCacheBtn.addEventListener('click', () => this.clearCacheAndReload());

        this.hnsProfileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleHnsProfilePopover();
        });

        this.closeHnsProfileBtn.addEventListener('click', () => this.hideHnsProfilePopover());
        
        // Update check button
        this.updateBtn.addEventListener('click', () => this.openLatestRelease());
        
        // Menu
        this.menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showNativeMenu();
        });
        
        // Menu dropdown items
        this.menuDropdown.addEventListener('click', (e) => {
            const action = e.target.closest('.dropdown-item')?.dataset.action;
            if (action) {
                this.handleMenuAction(action);
                this.hideMenu();
            }
        });
        
        // Status bar
        this.closeStatusBtn.addEventListener('click', () => this.hideStatus());
        
        // Modal close buttons
        document.querySelectorAll('.close-modal').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const modalId = e.target.closest('.close-modal')?.dataset.modal;
                this.hideModal(modalId);
            });
        });
        
        // Settings
        document.getElementById('save-settings').addEventListener('click', () => this.saveSettings());
        document.getElementById('reset-settings').addEventListener('click', () => this.resetSettings());
        
        // Global click handler for closing dropdowns/modals
        document.addEventListener('click', (e) => {
            if (!this.menuDropdown.contains(e.target) && !this.menuBtn.contains(e.target)) {
                this.hideMenu();
            }

            if (e.target.classList.contains('modal')) {
                this.hideModal(e.target.id);
            }
        });
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey || e.metaKey) {
                switch (e.key) {
                    case 't':
                        e.preventDefault();
                        this.createNewTab();
                        break;
                    case 'w':
                        e.preventDefault();
                        if (this.activeTabId) {
                            this.closeTab(this.activeTabId);
                        }
                        break;
                    case 'r':
                        e.preventDefault();
                        this.reload();
                        break;
                    case 'l':
                        e.preventDefault();
                        this.addressBar.focus();
                        break;
                }
            }
            
            if (e.key === 'F12') {
                e.preventDefault();
                this.openDevTools();
            }
        });
    }

    setupIpcListeners() {
        // Tab management
        window.electronAPI.onTabSwitched(async (data) => {
            const tabs = await window.electronAPI.getTabs();
            this.renderTabs(tabs);
            this.updateUI(data);
        });
        
        window.electronAPI.onTabClosed((tabId) => {
            this.removeTabFromUI(tabId);
        });

        window.electronAPI.onTabUpdated((data) => {
            this.updateTabState(data);
        });
        
        window.electronAPI.onLoadingChanged((data) => {
            this.updateLoadingState(data);
        });
        
        window.electronAPI.onLoadingError((data) => {
            this.showError(`Failed to load ${data.url}: ${data.error}`);
        });
        
        window.electronAPI.onHnsFallback((data) => {
            this.showStatus(`No HNS record found for ${data.domain}, trying traditional DNS`, 'warning');
        });

        window.electronAPI.onShowStatusMessage((data) => {
            this.showStatus(data.message, data.type || 'info');
        });
        
        window.electronAPI.onShowHistory(() => {
            this.showHistory();
        });
        
        window.electronAPI.onShowSettings(() => {
            this.showSettings();
        });
    }

    async loadInitialState() {
        try {
            await this.loadAppInfo();
            const tabs = await window.electronAPI.getTabs();
            this.renderTabs(tabs);
            
            if (tabs.length > 0) {
                const activeTab = tabs.find(tab => tab.active);
                if (activeTab) {
                    this.activeTabId = activeTab.id;
                    this.updateAddressBar(activeTab.url);
                    this.updateSecurityIndicator(activeTab.url, activeTab.hostingProvider);
                    this.updateHostingIndicator(activeTab.hostingProvider);
                    this.updateHnsProfileIndicator(activeTab.hnsProfile);
                    if (activeTab.url === 'skyinclude://home') {
                        this.focusAddressBar();
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load initial state:', error);
        }
    }

    async loadAppInfo() {
        try {
            const info = await window.electronAPI.getAppInfo();
            const versionText = info?.version ? `v${info.version}` : '';
            if (this.appVersionBadge) {
                this.appVersionBadge.textContent = versionText;
                this.appVersionBadge.title = versionText ? `SkyInclude Browser ${versionText}` : 'SkyInclude Browser';
            }
            if (this.menuVersionLabel) {
                this.menuVersionLabel.textContent = versionText;
            }
        } catch (error) {
            console.error('Failed to load app info:', error);
        }
    }

    // Navigation methods
    async navigateToUrl(url) {
        if (!url.trim()) return;
        
        try {
            this.showLoading(true);
            await window.electronAPI.navigateTo({ 
                tabId: this.activeTabId, 
                url: url 
            });
            this.updateAddressBar(url);
        } catch (error) {
            this.showError(`Navigation failed: ${error.message}`);
            this.showLoading(false);
        }
    }

    async goBack() {
        try {
            await window.electronAPI.goBack(this.activeTabId);
        } catch (error) {
            console.error('Go back failed:', error);
        }
    }

    async goForward() {
        try {
            await window.electronAPI.goForward(this.activeTabId);
        } catch (error) {
            console.error('Go forward failed:', error);
        }
    }

    async reload() {
        try {
            this.showLoading(true);
            await window.electronAPI.reload(this.activeTabId);
        } catch (error) {
            console.error('Reload failed:', error);
            this.showLoading(false);
        }
    }

    // Tab management
    async createNewTab(url = '') {
        try {
            const tabId = await window.electronAPI.newTab(url);
            const tabs = await window.electronAPI.getTabs();
            this.renderTabs(tabs);
            this.focusAddressBar();
            return tabId;
        } catch (error) {
            console.error('Failed to create new tab:', error);
        }
    }

    async closeTab(tabId) {
        try {
            await window.electronAPI.closeTab(tabId);
        } catch (error) {
            console.error('Failed to close tab:', error);
        }
    }

    async switchTab(tabId) {
        try {
            await window.electronAPI.switchTab(tabId);
            this.activeTabId = tabId;
        } catch (error) {
            console.error('Failed to switch tab:', error);
        }
    }

    // UI Updates
    updateUI(data) {
        this.activeTabId = data.tabId;
        this.updateAddressBar(data.url);
        this.updateNavigationButtons(data.canGoBack, data.canGoForward);
        this.showLoading(data.loading);
        this.updateSecurityIndicator(data.url, data.hostingProvider);
        this.updateHostingIndicator(data.hostingProvider);
        this.updateHnsProfileIndicator(data.hnsProfile);
        if (data.url === 'skyinclude://home') {
            this.focusAddressBar();
        }
    }

    updateAddressBar(url) {
        this.currentUrl = url;
        this.addressBar.value = url === 'skyinclude://home' ? '' : url;
    }

    updateNavigationButtons(canGoBack, canGoForward) {
        this.backBtn.disabled = !canGoBack;
        this.forwardBtn.disabled = !canGoForward;
    }

    updateLoadingState(data) {
        if (data.tabId === this.activeTabId) {
            this.showLoading(data.loading);
            if (!data.loading && data.url) {
                this.updateAddressBar(data.url);
                this.updateNavigationButtons(data.canGoBack, data.canGoForward);
                this.updateSecurityIndicator(data.url, data.hostingProvider);
            }

            if (Object.prototype.hasOwnProperty.call(data, 'hostingProvider')) {
                this.updateHostingIndicator(data.hostingProvider);
            }

            if (Object.prototype.hasOwnProperty.call(data, 'hnsProfile')) {
                this.updateHnsProfileIndicator(data.hnsProfile);
            }
        }
        
        // Update tab loading state
        const tab = this.tabs.get(data.tabId);
        if (tab) {
            tab.loading = data.loading;
            if (Object.prototype.hasOwnProperty.call(data, 'hostingProvider')) {
                tab.hostingProvider = data.hostingProvider;
            }
            if (Object.prototype.hasOwnProperty.call(data, 'hnsProfile')) {
                tab.hnsProfile = data.hnsProfile;
            }
            if (Object.prototype.hasOwnProperty.call(data, 'favicon')) {
                tab.favicon = data.favicon;
            }
            this.updateTabLoadingUI(data.tabId, data.loading);
        }
    }

    updateSecurityIndicator(url, hostingProvider = null) {
        const icon = this.securityIndicator.querySelector('i');

        if (hostingProvider === 'github-pages') {
            icon.className = 'fas fa-github';
            this.securityIndicator.className = 'security-indicator hosting-github';
            this.securityIndicator.title = 'Hosted on GitHub Pages';
            return;
        }
        
        if (url.startsWith('https://')) {
            icon.className = 'fas fa-lock';
            this.securityIndicator.className = 'security-indicator';
        } else if (url.startsWith('http://')) {
            icon.className = 'fas fa-exclamation-triangle';
            this.securityIndicator.className = 'security-indicator warning';
        } else if (url.startsWith('skyinclude://')) {
            icon.className = 'fas fa-home';
            this.securityIndicator.className = 'security-indicator';
        } else {
            icon.className = 'fas fa-globe';
            this.securityIndicator.className = 'security-indicator';
        }

        this.securityIndicator.title = '';
    }

    updateHostingIndicator(hostingProvider) {
        this.hostingIndicator.classList.add('hidden');
    }

    showLoading(loading) {
        if (loading) {
            this.loadingIndicator.classList.add('visible');
            this.reloadBtn.querySelector('i').className = 'fas fa-times';
            this.reloadBtn.title = 'Stop loading';
        } else {
            this.loadingIndicator.classList.remove('visible');
            this.reloadBtn.querySelector('i').className = 'fas fa-redo-alt';
            this.reloadBtn.title = 'Reload';
        }
    }

    // Tab UI rendering
    renderTabs(tabs) {
        this.tabsContainer.replaceChildren();
        this.tabs.clear();
        
        tabs.forEach(tab => {
            this.tabs.set(tab.id, tab);
            this.renderTab(tab);
        });
    }

    renderTab(tab) {
        const tabElement = document.createElement('div');
        tabElement.className = `tab ${tab.active ? 'active' : ''}`;
        tabElement.dataset.tabId = tab.id;

        const favicon = document.createElement('div');
        favicon.className = 'tab-favicon';

        this.renderTabFavicon(favicon, tab);

        const title = document.createElement('div');
        title.className = 'tab-title';
        title.textContent = this.getTabTitle(tab);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.title = 'Close tab';
        closeBtn.textContent = '×';

        tabElement.append(favicon, title, closeBtn);
        
        // Tab click handler
        tabElement.addEventListener('click', (e) => {
            if (!e.target.classList.contains('tab-close')) {
                this.switchTab(tab.id);
            }
        });
        
        // Close button handler
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeTab(tab.id);
        });
        
        this.tabsContainer.appendChild(tabElement);
    }

    removeTabFromUI(tabId) {
        const tabElement = this.tabsContainer.querySelector(`[data-tab-id="${tabId}"]`);
        if (tabElement) {
            tabElement.remove();
        }
        this.tabs.delete(tabId);
    }

    updateTabLoadingUI(tabId, loading) {
        const tabElement = this.tabsContainer.querySelector(`[data-tab-id="${tabId}"]`);
        if (tabElement) {
            const favicon = tabElement.querySelector('.tab-favicon');
            if (loading) {
                favicon.replaceChildren();
                const spinner = document.createElement('i');
                spinner.className = 'fas fa-spinner fa-spin';
                favicon.appendChild(spinner);
            } else {
                this.renderTabFavicon(favicon, this.tabs.get(tabId));
            }
        }
    }

    updateTabState(data) {
        const tab = this.tabs.get(data.tabId);
        if (!tab) {
            return;
        }

        Object.assign(tab, data);

        const tabElement = this.tabsContainer.querySelector(`[data-tab-id="${data.tabId}"]`);
        if (tabElement) {
            tabElement.classList.toggle('active', data.active === true);
            const title = tabElement.querySelector('.tab-title');
            if (title) {
                title.textContent = this.getTabTitle(tab);
            }

            if (!tab.loading) {
                const favicon = tabElement.querySelector('.tab-favicon');
                if (favicon) {
                    this.renderTabFavicon(favicon, tab);
                }
            }
        }

        if (data.active === true || data.tabId === this.activeTabId) {
            this.activeTabId = data.tabId;
            this.updateAddressBar(tab.url);
            this.updateNavigationButtons(tab.canGoBack, tab.canGoForward);
            this.updateSecurityIndicator(tab.url, tab.hostingProvider);
            this.updateHostingIndicator(tab.hostingProvider);
            this.updateHnsProfileIndicator(tab.hnsProfile);
        }
    }

    updateHnsProfileIndicator(profile) {
        this.currentHnsProfile = profile && Array.isArray(profile.entries) && profile.entries.length > 0 ? profile : null;
        if (this.currentHnsProfile) {
            this.hnsProfileBtn.classList.remove('hidden');
            this.hnsProfileBtn.title = `View hns.bio records for ${this.currentHnsProfile.domain}`;
            return;
        }

        this.hnsProfileBtn.classList.add('hidden');
        this.hideHnsProfilePopover();
    }

    async toggleHnsProfilePopover() {
        if (!this.currentHnsProfile) {
            return;
        }

        const rect = this.hnsProfileBtn.getBoundingClientRect();
        await window.electronAPI.showHnsProfilePopover({
            profile: this.currentHnsProfile,
            anchor: {
                left: rect.left,
                bottom: rect.bottom
            }
        });
    }

    async hideHnsProfilePopover() {
        this.hnsProfilePopover.classList.add('hidden');
        await window.electronAPI.hideHnsProfilePopover();
    }

    getTabIconClass(tab) {
        if (tab?.loading) {
            return 'fas fa-spinner fa-spin';
        }

        if (tab?.hostingProvider === 'github-pages') {
            return 'fas fa-github';
        }

        if (tab?.url === 'skyinclude://home') {
            return 'fas fa-home';
        }

        return 'fas fa-globe';
    }

    renderTabFavicon(container, tab) {
        container.replaceChildren();

        if (!tab?.loading && tab?.favicon) {
            const image = document.createElement('img');
            image.className = 'tab-favicon-image';
            image.alt = '';
            image.src = tab.favicon;
            image.addEventListener('error', () => {
                container.replaceChildren();
                const fallbackIcon = document.createElement('i');
                fallbackIcon.className = this.getTabIconClass({ ...tab, favicon: null });
                container.appendChild(fallbackIcon);
            }, { once: true });
            container.appendChild(image);
            return;
        }

        const faviconIcon = document.createElement('i');
        faviconIcon.className = this.getTabIconClass(tab);
        container.appendChild(faviconIcon);
    }

    getTabTitle(tab) {
        if (tab.url === 'skyinclude://home' || !tab.url) {
            return 'New Tab';
        }
        
        if (tab.title && tab.title !== 'New Tab') {
            return tab.title;
        }
        
        try {
            const url = new URL(tab.url);
            return url.hostname || tab.url;
        } catch {
            return tab.url.substring(0, 30) + (tab.url.length > 30 ? '...' : '');
        }
    }

    focusAddressBar() {
        setTimeout(() => {
            this.addressBar.focus();
            this.addressBar.select();
        }, 0);
    }

    // Menu handling
    async showNativeMenu() {
        const rect = this.menuBtn.getBoundingClientRect();
        try {
            await window.electronAPI.showAppMenu({
                x: rect.left,
                y: rect.bottom
            });
        } catch (error) {
            console.error('Failed to show native menu:', error);
            this.menuDropdown.classList.toggle('hidden');
        }
    }

    hideMenu() {
        this.menuDropdown.classList.add('hidden');
    }

    async handleMenuAction(action) {
        switch (action) {
            case 'new-tab':
                await this.createNewTab();
                break;
            case 'history':
                this.showHistory();
                break;
            case 'settings':
                this.showSettings();
                break;
            case 'updates':
                await this.openLatestRelease();
                break;
            case 'dev-tools':
                this.openDevTools();
                break;
            case 'about':
                await this.showAbout();
                break;
        }
    }

    // Status and error handling
    showStatus(message, type = 'info') {
        this.statusText.textContent = message;
        this.statusBar.className = `status-bar ${type}`;
        this.statusBar.classList.remove('hidden');
        
        // Auto-hide after 5 seconds
        setTimeout(() => this.hideStatus(), 5000);
    }

    showError(message) {
        this.showStatus(message, 'error');
    }

    hideStatus() {
        this.statusBar.classList.add('hidden');
    }

    // Modal handling
    async showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            await this.setBrowserViewVisible(false);
            modal.classList.remove('hidden');
        }
    }

    async hideModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('hidden');
        }

        if (!document.querySelector('.modal:not(.hidden)')) {
            await this.setBrowserViewVisible(true);
        }
    }

    async setBrowserViewVisible(visible) {
        try {
            await window.electronAPI.setBrowserViewVisible(visible);
        } catch (error) {
            console.error('Failed to update page view visibility:', error);
        }
    }

    // History
    async showHistory() {
        try {
            const history = await window.electronAPI.getHistory();
            this.renderHistory(history);
            this.showModal('history-modal');
        } catch (error) {
            console.error('Failed to load history:', error);
            this.showError('Failed to load browsing history');
        }
    }

    renderHistory(history) {
        this.historyList.replaceChildren();

        if (!history || history.length === 0) {
            const emptyState = document.createElement('div');
            emptyState.className = 'empty-state';
            emptyState.textContent = 'No browsing history';
            this.historyList.appendChild(emptyState);
            return;
        }

        const fragment = document.createDocumentFragment();

        history.forEach(entry => {
            const entryUrl = entry.url;
            const item = document.createElement('div');
            item.className = 'history-item';
            item.dataset.url = entryUrl;

            const favicon = document.createElement('div');
            favicon.className = 'history-favicon';

            if (entry.favicon) {
                const faviconImage = document.createElement('img');
                faviconImage.className = 'tab-favicon-image';
                faviconImage.alt = '';
                faviconImage.src = entry.favicon;
                faviconImage.addEventListener('error', () => {
                    favicon.replaceChildren();
                    const fallbackIcon = document.createElement('i');
                    fallbackIcon.className = 'fas fa-globe';
                    favicon.appendChild(fallbackIcon);
                }, { once: true });
                favicon.appendChild(faviconImage);
            } else {
                const faviconIcon = document.createElement('i');
                faviconIcon.className = 'fas fa-globe';
                favicon.appendChild(faviconIcon);
            }

            const content = document.createElement('div');
            content.className = 'history-content';

            const title = document.createElement('div');
            title.className = 'history-title';
            title.textContent = entry.title || entryUrl;

            const urlElement = document.createElement('div');
            urlElement.className = 'history-url';
            urlElement.textContent = entryUrl;

            content.append(title, urlElement);

            const time = document.createElement('div');
            time.className = 'history-time';
            time.textContent = this.formatTime(entry.timestamp);

            item.append(favicon, content, time);

            item.addEventListener('click', () => {
                this.navigateToUrl(entryUrl);
                this.hideModal('history-modal');
            });

            fragment.appendChild(item);
        });

        this.historyList.appendChild(fragment);
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        const now = new Date();
        const diff = now - date;
        
        if (diff < 3600000) { // Less than 1 hour
            return Math.floor(diff / 60000) + 'm ago';
        } else if (diff < 86400000) { // Less than 1 day
            return Math.floor(diff / 3600000) + 'h ago';
        } else {
            return date.toLocaleDateString();
        }
    }

    // Settings
    async showSettings() {
        try {
            const settings = await window.electronAPI.getSettings();
            this.populateSettings(settings);
            this.showModal('settings-modal');
        } catch (error) {
            console.error('Failed to load settings:', error);
            this.showError('Failed to load settings');
        }
    }

    populateSettings(settings) {
        // HNS resolution mode
        const hnsMode = settings.hnsResolutionMode || 'doh';
        const hnsModeInput = document.querySelector(`input[name="hns-mode"][value="${hnsMode}"]`);
        (hnsModeInput || document.querySelector('input[name="hns-mode"][value="doh"]')).checked = true;
        
        // Privacy settings
        document.getElementById('block-trackers').checked = settings.blockTrackers !== false;
        document.getElementById('disable-javascript').checked = settings.enableJavaScript !== false;
        
        // Security settings
        document.getElementById('strict-ssl').checked = settings.strictSSL !== false;
    }

    async saveSettings() {
        try {
            const settings = {
                hnsResolutionMode: document.querySelector('input[name="hns-mode"]:checked').value,
                blockTrackers: document.getElementById('block-trackers').checked,
                enableJavaScript: document.getElementById('disable-javascript').checked,
                strictSSL: document.getElementById('strict-ssl').checked
            };
            
            await window.electronAPI.saveSettings(settings);
            this.showStatus('Settings saved successfully', 'success');
            this.hideModal('settings-modal');
        } catch (error) {
            console.error('Failed to save settings:', error);
            this.showError('Failed to save settings');
        }
    }

    resetSettings() {
        document.querySelector('input[name="hns-mode"][value="doh"]').checked = true;
        document.getElementById('block-trackers').checked = true;
        document.getElementById('disable-javascript').checked = true;
        document.getElementById('strict-ssl').checked = true;
    }

    // Developer tools
    openDevTools() {
        // This will be handled by the main process through menu
        console.log('Opening developer tools...');
    }

    // About dialog
    async showAbout() {
        try {
            await window.electronAPI.showAbout();
        } catch (error) {
            this.showError(`Unable to show About: ${error.message}`);
        }
    }

    async openLatestRelease() {
        try {
            await window.electronAPI.openLatestRelease();
        } catch (error) {
            this.showError(`Unable to open releases: ${error.message}`);
        }
    }

    async clearCacheAndReload() {
        try {
            const result = await window.electronAPI.clearCacheAndReload();
            this.showStatus(result?.message || 'Cache cleared and HNS reloaded', 'success');
        } catch (error) {
            this.showError(`Unable to clear cache: ${error.message}`);
        }
    }

    getRCodeText(code) {
        const rcodes = {
            0: 'NOERROR',
            1: 'FORMERR',
            2: 'SERVFAIL',
            3: 'NXDOMAIN',
            4: 'NOTIMP',
            5: 'REFUSED'
        };
        return rcodes[code] || 'UNKNOWN';
    }
}

// Initialize the renderer when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new SkyIncludeRenderer();
});
