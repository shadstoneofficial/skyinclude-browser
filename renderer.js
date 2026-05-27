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
        
        // HNS Test Modal elements
        this.hnsTestBtn = document.getElementById('hns-test-btn');
        this.hnsTestModal = document.getElementById('hns-test-modal');
        this.testDomainInput = document.getElementById('test-domain');
        this.testResolverInput = document.getElementById('test-resolver');
        this.queryBtn = document.getElementById('query-btn');
        this.clearBtn = document.getElementById('clear-btn');
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
        
        // Tab management
        this.newTabBtn.addEventListener('click', () => this.createNewTab());
        
        // HNS Test button
        this.hnsTestBtn.addEventListener('click', () => this.openHnsTestModal());
        
        // Menu
        this.menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleMenu();
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
                const modalId = e.target.dataset.modal;
                this.hideModal(modalId);
            });
        });
        
        // Settings
        document.getElementById('save-settings').addEventListener('click', () => this.saveSettings());
        document.getElementById('reset-settings').addEventListener('click', () => this.resetSettings());
        
        // HNS Test modal
        this.queryBtn.addEventListener('click', () => this.performDnsQuery());
        this.clearBtn.addEventListener('click', () => this.clearTestResults());
        
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
        
        window.electronAPI.onLoadingChanged((data) => {
            this.updateLoadingState(data);
        });
        
        window.electronAPI.onLoadingError((data) => {
            this.showError(`Failed to load ${data.url}: ${data.error}`);
        });
        
        window.electronAPI.onHnsFallback((data) => {
            this.showStatus(`No HNS record found for ${data.domain}, trying traditional DNS`, 'warning');
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
            const tabs = await window.electronAPI.getTabs();
            this.renderTabs(tabs);
            
            if (tabs.length > 0) {
                const activeTab = tabs.find(tab => tab.active);
                if (activeTab) {
                    this.activeTabId = activeTab.id;
                    this.updateAddressBar(activeTab.url);
                }
            }
        } catch (error) {
            console.error('Failed to load initial state:', error);
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
        this.updateSecurityIndicator(data.url);
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
            }
        }
        
        // Update tab loading state
        const tab = this.tabs.get(data.tabId);
        if (tab) {
            tab.loading = data.loading;
            this.updateTabLoadingUI(data.tabId, data.loading);
        }
    }

    updateSecurityIndicator(url) {
        const icon = this.securityIndicator.querySelector('i');
        
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
        this.tabsContainer.innerHTML = '';
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
        
        tabElement.innerHTML = `
            <div class="tab-favicon">
                <i class="fas fa-globe"></i>
            </div>
            <div class="tab-title">${this.getTabTitle(tab)}</div>
            <button class="tab-close" title="Close tab">×</button>
        `;
        
        // Tab click handler
        tabElement.addEventListener('click', (e) => {
            if (!e.target.classList.contains('tab-close')) {
                this.switchTab(tab.id);
            }
        });
        
        // Close button handler
        const closeBtn = tabElement.querySelector('.tab-close');
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
            const favicon = tabElement.querySelector('.tab-favicon i');
            if (loading) {
                favicon.className = 'fas fa-spinner fa-spin';
            } else {
                favicon.className = 'fas fa-globe';
            }
        }
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

    // Menu handling
    toggleMenu() {
        this.menuDropdown.classList.toggle('hidden');
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
            case 'dev-tools':
                this.openDevTools();
                break;
            case 'about':
                this.showAbout();
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
    showModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.remove('hidden');
        }
    }

    hideModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.classList.add('hidden');
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
        if (!history || history.length === 0) {
            this.historyList.innerHTML = '<div class="empty-state">No browsing history</div>';
            return;
        }
        
        this.historyList.innerHTML = history.map(entry => `
            <div class="history-item" data-url="${entry.url}">
                <div class="history-favicon">
                    <i class="fas fa-globe"></i>
                </div>
                <div class="history-content">
                    <div class="history-title">${entry.title || entry.url}</div>
                    <div class="history-url">${entry.url}</div>
                </div>
                <div class="history-time">${this.formatTime(entry.timestamp)}</div>
            </div>
        `).join('');
        
        // Add click handlers
        this.historyList.querySelectorAll('.history-item').forEach(item => {
            item.addEventListener('click', () => {
                const url = item.dataset.url;
                this.navigateToUrl(url);
                this.hideModal('history-modal');
            });
        });
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
        document.getElementById('hns-dane').checked = settings.hnsDANE === true;
    }

    async saveSettings() {
        try {
            const settings = {
                hnsResolutionMode: document.querySelector('input[name="hns-mode"]:checked').value,
                blockTrackers: document.getElementById('block-trackers').checked,
                enableJavaScript: document.getElementById('disable-javascript').checked,
                strictSSL: document.getElementById('strict-ssl').checked,
                hnsDANE: document.getElementById('hns-dane').checked
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
        document.getElementById('hns-dane').checked = false;
    }

    // Developer tools
    openDevTools() {
        // This will be handled by the main process through menu
        console.log('Opening developer tools...');
    }

    // About dialog
    showAbout() {
        this.showStatus('SkyInclude Browser v1.0.0 - Decentralized Web Explorer', 'info');
    }

    // HNS Test Modal Methods
    openHnsTestModal() {
        // Set default values
        this.testDomainInput.value = 'setup.skyinclude';
        this.testResolverInput.value = 'https://hnsdoh.com/dns-query';
        this.clearTestResults();
        this.showModal('hns-test-modal');
    }

    clearTestResults() {
        // Clear result display
        document.getElementById('result-status').textContent = 'Ready';
        document.getElementById('result-time').textContent = '0 ms';
        document.getElementById('result-rcode').textContent = 'NOQUERY';
        document.getElementById('result-size').textContent = '0';
        document.getElementById('result-asize').textContent = '0';
        
        // Clear flags
        document.querySelectorAll('.flag-label input[type="checkbox"]').forEach(cb => {
            cb.checked = false;
        });
        
        // Clear sections
        document.getElementById('answer-section').innerHTML = '';
        document.getElementById('authority-section').innerHTML = '';
        document.getElementById('additional-section').innerHTML = '';
    }

    async performDnsQuery() {
        const domain = this.testDomainInput.value.trim();
        const resolver = this.testResolverInput.value.trim();
        const qtype = document.getElementById('test-qtype').value;
        const qclass = document.getElementById('test-class').value;
        
        if (!domain) {
            this.showError('Please enter a domain name');
            return;
        }
        
        if (!resolver) {
            this.showError('Please enter a DNS resolver');
            return;
        }

        // Disable query button and show loading
        this.queryBtn.disabled = true;
        this.queryBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> QUERYING...';
        
        document.getElementById('result-status').textContent = 'Querying...';

        const startTime = Date.now();

        try {
            // Perform DNS query using DoH
            const result = await this.dohQuery(domain, qtype, resolver);
            const queryTime = Date.now() - startTime;
            
            this.displayDnsResult(result, queryTime);
            
        } catch (error) {
            console.error('DNS Query Error:', error);
            
            const queryTime = Date.now() - startTime;
            document.getElementById('result-status').textContent = 'Error';
            document.getElementById('result-time').textContent = queryTime + ' ms';
            document.getElementById('result-rcode').textContent = 'SERVFAIL';
            
            // Show error in answer section
            document.getElementById('answer-section').innerHTML = 
                `<div class="dns-record" style="color: #ef4444;">Error: ${error.message}</div>`;
            
        } finally {
            // Re-enable query button
            this.queryBtn.disabled = false;
            this.queryBtn.innerHTML = '<i class="fas fa-search"></i> QUERY';
        }
    }

    async dohQuery(domain, qtype, resolver) {
        // Build DoH query URL
        const dohUrl = new URL(resolver);
        dohUrl.searchParams.set('name', domain);
        dohUrl.searchParams.set('type', qtype);
        
        const response = await fetch(dohUrl.toString(), {
            method: 'GET',
            headers: {
                'Accept': 'application/dns-json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        return await response.json();
    }

    displayDnsResult(result, queryTime) {
        // Update status
        document.getElementById('result-status').textContent = result.Status === 0 ? 'NOERROR' : 'ERROR';
        document.getElementById('result-time').textContent = queryTime + ' ms';
        document.getElementById('result-rcode').textContent = this.getRCodeText(result.Status);
        document.getElementById('result-size').textContent = JSON.stringify(result).length;
        document.getElementById('result-asize').textContent = result.Answer ? result.Answer.length : 0;

        // Update flags (simplified - not all flags are available in DoH JSON response)
        document.getElementById('flag-rd').checked = result.RD || false;
        document.getElementById('flag-ra').checked = result.RA || false;
        document.getElementById('flag-ad').checked = result.AD || false;
        document.getElementById('flag-cd').checked = result.CD || false;

        // Display answer section
        this.displayDnsSection('answer-section', result.Answer, 'answer');
        
        // Display authority section
        this.displayDnsSection('authority-section', result.Authority, 'authority');
        
        // Display additional section
        this.displayDnsSection('additional-section', result.Additional, 'additional');
    }

    displayDnsSection(elementId, records, type) {
        const element = document.getElementById(elementId);
        
        if (!records || records.length === 0) {
            element.innerHTML = '';
            return;
        }

        element.innerHTML = records.map(record => {
            const isHighlighted = type === 'answer' && record.data && 
                                  (record.data.includes('34.234.248.146') || 
                                   record.data.includes('setup.skyinclude'));
            
            const recordClass = isHighlighted ? 'dns-record ' + type + ' record-highlight' : 'dns-record ' + type;
            
            return `<div class="${recordClass}">
                ${record.name}. ${record.TTL} ${record.type} ${record.data}
            </div>`;
        }).join('');
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
