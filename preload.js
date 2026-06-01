const { contextBridge, ipcRenderer } = require('electron');

const allowedEventChannels = new Set([
    'tab-switched',
    'tab-closed',
    'tab-updated',
    'loading-changed',
    'loading-error',
    'hns-fallback',
    'show-history',
    'show-settings',
    'show-status-message'
]);

function onAllowedChannel(channel, callback, mapArgs = (...args) => args[0]) {
    if (!allowedEventChannels.has(channel)) {
        throw new Error('Unsupported event channel');
    }

    if (typeof callback !== 'function') {
        throw new Error('Callback must be a function');
    }

    ipcRenderer.on(channel, (event, ...args) => callback(mapArgs(...args)));
}

function removeAllowedListeners(channel) {
    if (!allowedEventChannels.has(channel)) {
        throw new Error('Unsupported event channel');
    }

    ipcRenderer.removeAllListeners(channel);
}

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
    // Navigation
    navigateTo: (data) => ipcRenderer.invoke('navigate-to', data),
    goBack: (tabId) => ipcRenderer.invoke('go-back', tabId),
    goForward: (tabId) => ipcRenderer.invoke('go-forward', tabId),
    reload: (tabId) => ipcRenderer.invoke('reload', tabId),
    
    // Tab management
    newTab: (url) => ipcRenderer.invoke('new-tab', url),
    closeTab: (tabId) => ipcRenderer.invoke('close-tab', tabId),
    switchTab: (tabId) => ipcRenderer.invoke('switch-tab', tabId),
    getTabs: () => ipcRenderer.invoke('get-tabs'),
    
    // History
    getHistory: () => ipcRenderer.invoke('get-history'),
    
    // Settings
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    updateSetting: (key, value) => ipcRenderer.invoke('update-setting', key, value),

    // App info
    getAppInfo: () => ipcRenderer.invoke('get-app-info'),
    showAbout: () => ipcRenderer.invoke('show-about'),
    openLatestRelease: () => ipcRenderer.invoke('open-latest-release'),
    showAppMenu: (anchor) => ipcRenderer.invoke('show-app-menu', anchor),
    showHnsProfilePopover: (payload) => ipcRenderer.invoke('show-hns-profile-popover', payload),
    hideHnsProfilePopover: () => ipcRenderer.invoke('hide-hns-profile-popover'),
    setBrowserViewVisible: (visible) => ipcRenderer.invoke('set-browser-view-visible', visible),
    clearCacheAndReload: () => ipcRenderer.invoke('clear-cache-and-reload'),
    openDebugLog: () => ipcRenderer.invoke('open-debug-log'),
    
    // Event listeners
    onTabSwitched: (callback) => onAllowedChannel('tab-switched', callback),
    onTabClosed: (callback) => onAllowedChannel('tab-closed', callback),
    onTabUpdated: (callback) => onAllowedChannel('tab-updated', callback),
    onLoadingChanged: (callback) => onAllowedChannel('loading-changed', callback),
    onLoadingError: (callback) => onAllowedChannel('loading-error', callback),
    onHnsFallback: (callback) => onAllowedChannel('hns-fallback', callback),
    onShowHistory: (callback) => onAllowedChannel('show-history', callback, () => undefined),
    onShowSettings: (callback) => onAllowedChannel('show-settings', callback, () => undefined),
    onShowStatusMessage: (callback) => onAllowedChannel('show-status-message', callback),
    
    // Remove listeners
    removeAllListeners: (channel) => removeAllowedListeners(channel)
});
