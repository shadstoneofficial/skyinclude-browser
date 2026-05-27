const { contextBridge, ipcRenderer } = require('electron');

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
    
    // Event listeners
    onTabSwitched: (callback) => ipcRenderer.on('tab-switched', (event, data) => callback(data)),
    onTabClosed: (callback) => ipcRenderer.on('tab-closed', (event, tabId) => callback(tabId)),
    onLoadingChanged: (callback) => ipcRenderer.on('loading-changed', (event, data) => callback(data)),
    onLoadingError: (callback) => ipcRenderer.on('loading-error', (event, data) => callback(data)),
    onHnsFallback: (callback) => ipcRenderer.on('hns-fallback', (event, data) => callback(data)),
    onShowHistory: (callback) => ipcRenderer.on('show-history', () => callback()),
    onShowSettings: (callback) => ipcRenderer.on('show-settings', () => callback()),
    
    // Remove listeners
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
});
