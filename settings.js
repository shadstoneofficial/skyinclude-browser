const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const {
    BUILT_IN_RESOLVERS,
    normalizeResolverDescriptor,
    normalizeResolverList
} = require('./resolver-config.js');

const HNS_RESOLVER_DEFAULTS_VERSION = 2;

class SettingsManager {
    constructor() {
        this.settingsFile = path.join(app.getPath('userData'), 'settings.json');
        this.defaultSettings = {
            // HNS Resolution
            hnsResolutionMode: 'doh', // 'doh' (DNS-over-HTTPS) or 'p2p' (Light Client)
            hnsResolvers: normalizeResolverList(BUILT_IN_RESOLVERS),
            hnsResolverDefaultsVersion: HNS_RESOLVER_DEFAULTS_VERSION,
            hnsCustomResolver: '',
            hnsTimeout: 4000,
            hnsDANE: false,
            hnsFallbackToDNS: true,
            
            // Privacy
            blockTrackers: true,
            enableJavaScript: true,
            blockAds: false,
            doNotTrack: true,
            clearDataOnExit: false,
            
            // Security
            strictSSL: true,
            mixedContentBlocking: true,
            certificateTransparency: true,
            secureOnlyMode: false,
            
            // General
            homepage: 'skyinclude://home',
            searchEngine: 'https://duckduckgo.com/?q=',
            downloadPath: '',
            language: 'en',
            theme: 'system', // 'light', 'dark', 'system'
            
            // Advanced
            hardwareAcceleration: true,
            experimentalFeatures: false,
            developerMode: false,
            customCSS: '',
            userAgent: '',
            
            // History
            historyRetentionDays: 90,
            maxHistoryEntries: 1000,
            saveHistory: true,
            
            // Updates
            autoUpdate: true,
            betaUpdates: false,
            lastUpdateCheck: 0,
            
            // Extension settings placeholder
            extensions: {
                enabled: true,
                allowedOrigins: [],
                permissions: {}
            }
        };
        
        this.settings = {};
        this.loadSettings();
    }

    loadSettings() {
        try {
            if (fs.existsSync(this.settingsFile)) {
                const data = fs.readFileSync(this.settingsFile, 'utf8');
                const savedSettings = JSON.parse(data);
                
                // Merge with defaults to ensure all settings exist
                this.settings = { ...this.defaultSettings, ...savedSettings };
                if (!Object.prototype.hasOwnProperty.call(savedSettings, 'hnsResolverDefaultsVersion')) {
                    this.settings.hnsResolverDefaultsVersion = 0;
                }
                const migrated = this.migrateHnsResolverSettings();
                if (migrated) {
                    this.saveSettings();
                }
                
                console.log('Settings loaded successfully');
            } else {
                console.log('No existing settings file, using defaults');
                this.settings = { ...this.defaultSettings };
                this.migrateHnsResolverSettings();
                this.saveSettings();
            }
        } catch (error) {
            console.error('Failed to load settings:', error);
            this.settings = { ...this.defaultSettings };
        }
    }

    migrateHnsResolverSettings() {
        const before = JSON.stringify({
            resolvers: this.settings.hnsResolvers || [],
            version: this.settings.hnsResolverDefaultsVersion
        });
        const normalized = normalizeResolverList(this.settings.hnsResolvers || []);
        const currentVersion = Number(this.settings.hnsResolverDefaultsVersion) || 0;
        const isLegacyDefault = normalized.length === 1 && normalized[0].id === 'hnsdoh';
        this.settings.hnsResolvers = currentVersion < HNS_RESOLVER_DEFAULTS_VERSION
            && isLegacyDefault
            ? normalizeResolverList([...normalized, BUILT_IN_RESOLVERS[1]])
            : normalized;
        this.settings.hnsResolverDefaultsVersion = HNS_RESOLVER_DEFAULTS_VERSION;
        return before !== JSON.stringify({
            resolvers: this.settings.hnsResolvers,
            version: this.settings.hnsResolverDefaultsVersion
        });
    }

    saveSettings() {
        try {
            // Ensure directory exists
            const dir = path.dirname(this.settingsFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
            console.log('Settings saved successfully');
            return true;
        } catch (error) {
            console.error('Failed to save settings:', error);
            return false;
        }
    }

    getSettings() {
        return { ...this.settings };
    }

    getSetting(key) {
        return this.settings[key];
    }

    setSetting(key, value) {
        this.settings[key] = value;
        this.saveSettings();
        console.log(`Setting updated: ${key}`);
    }

    updateSettings(newSettings) {
        // Validate settings before updating
        const validatedSettings = this.validateSettings(newSettings);
        
        this.settings = { ...this.settings, ...validatedSettings };
        const success = this.saveSettings();
        
        if (success) {
            console.log('Settings updated:', Object.keys(validatedSettings));
            this.notifySettingsChanged(validatedSettings);
        }
        
        return success;
    }

    validateSettings(settings) {
        const validated = {};
        
        // Validate HNS resolution mode
        if (settings.hnsResolutionMode && ['api', 'dns', 'doh', 'p2p'].includes(settings.hnsResolutionMode)) {
            validated.hnsResolutionMode = settings.hnsResolutionMode;
        }
        
        // Validate boolean settings
        const booleanSettings = [
            'blockTrackers', 'enableJavaScript', 'blockAds', 'doNotTrack',
            'clearDataOnExit', 'strictSSL', 'mixedContentBlocking',
            'certificateTransparency', 'secureOnlyMode', 'hnsDANE',
            'hnsFallbackToDNS', 'hardwareAcceleration', 'experimentalFeatures',
            'developerMode', 'saveHistory', 'autoUpdate', 'betaUpdates'
        ];
        
        booleanSettings.forEach(key => {
            if (typeof settings[key] === 'boolean') {
                validated[key] = settings[key];
            }
        });
        
        // Validate numeric settings
        if (typeof settings.hnsTimeout === 'number' && settings.hnsTimeout > 0) {
            validated.hnsTimeout = Math.min(settings.hnsTimeout, 30000); // Max 30 seconds
        }
        
        if (typeof settings.historyRetentionDays === 'number' && settings.historyRetentionDays > 0) {
            validated.historyRetentionDays = Math.min(settings.historyRetentionDays, 365); // Max 1 year
        }
        
        if (typeof settings.maxHistoryEntries === 'number' && settings.maxHistoryEntries > 0) {
            validated.maxHistoryEntries = Math.min(settings.maxHistoryEntries, 10000); // Max 10k entries
        }
        
        // Validate string settings
        if (typeof settings.homepage === 'string' && settings.homepage.trim()) {
            validated.homepage = settings.homepage.trim();
        }
        
        if (typeof settings.searchEngine === 'string' && settings.searchEngine.trim()) {
            validated.searchEngine = settings.searchEngine.trim();
        }
        
        if (typeof settings.downloadPath === 'string') {
            validated.downloadPath = settings.downloadPath.trim();
        }
        
        if (typeof settings.language === 'string' && settings.language.trim()) {
            validated.language = settings.language.trim();
        }
        
        if (settings.theme && ['light', 'dark', 'system'].includes(settings.theme)) {
            validated.theme = settings.theme;
        }
        
        if (typeof settings.customCSS === 'string') {
            validated.customCSS = settings.customCSS;
        }
        
        if (typeof settings.userAgent === 'string') {
            validated.userAgent = settings.userAgent.trim();
        }

        if (typeof settings.hnsCustomResolver === 'string') {
            const customResolver = settings.hnsCustomResolver.trim();
            if (!customResolver || normalizeResolverDescriptor(customResolver)) {
                validated.hnsCustomResolver = customResolver;
            }
        }
        
        // Validate array settings
        if (Array.isArray(settings.hnsResolvers)) {
            validated.hnsResolvers = normalizeResolverList(settings.hnsResolvers);
        }
        
        return validated;
    }

    resetSettings() {
        this.settings = { ...this.defaultSettings };
        const success = this.saveSettings();
        
        if (success) {
            console.log('Settings reset to defaults');
            this.notifySettingsChanged(this.settings);
        }
        
        return success;
    }

    resetSetting(key) {
        if (this.defaultSettings.hasOwnProperty(key)) {
            this.settings[key] = this.defaultSettings[key];
            this.saveSettings();
            console.log(`Setting reset to default: ${key}`);
        }
    }

    exportSettings() {
        try {
            return JSON.stringify(this.settings, null, 2);
        } catch (error) {
            console.error('Failed to export settings:', error);
            return null;
        }
    }

    importSettings(settingsData) {
        try {
            const importedSettings = JSON.parse(settingsData);
            const validatedSettings = this.validateSettings(importedSettings);
            
            const success = this.updateSettings(validatedSettings);
            
            if (success) {
                console.log('Settings imported successfully');
                return Object.keys(validatedSettings).length;
            }
            
            return 0;
        } catch (error) {
            console.error('Failed to import settings:', error);
            return 0;
        }
    }

    notifySettingsChanged(changedSettings) {
        // Notify other parts of the application about settings changes
        // This could be expanded to emit events or update other components
        
        if (changedSettings.hnsResolutionMode || changedSettings.hnsResolvers ||
            changedSettings.hnsCustomResolver !== undefined || changedSettings.hnsTimeout || changedSettings.hnsDANE) {
            this.updateHNSResolver();
        }
        
        if (changedSettings.theme) {
            this.applyTheme(changedSettings.theme);
        }
    }

    updateHNSResolver() {
        try {
            console.log('HNS resolver settings changed');
        } catch (error) {
            console.error('Failed to update HNS resolver settings:', error);
        }
    }

    applyTheme(theme) {
        // Theme application logic would go here
        // For now, just log the change
        console.log('Theme changed to:', theme);
    }

    getSecuritySettings() {
        return {
            strictSSL: this.settings.strictSSL,
            mixedContentBlocking: this.settings.mixedContentBlocking,
            certificateTransparency: this.settings.certificateTransparency,
            secureOnlyMode: this.settings.secureOnlyMode,
            hnsDANE: this.settings.hnsDANE
        };
    }

    getPrivacySettings() {
        return {
            blockTrackers: this.settings.blockTrackers,
            blockAds: this.settings.blockAds,
            doNotTrack: this.settings.doNotTrack,
            clearDataOnExit: this.settings.clearDataOnExit,
            saveHistory: this.settings.saveHistory
        };
    }

    getHNSSettings() {
        return {
            hnsResolutionMode: this.settings.hnsResolutionMode,
            hnsResolvers: this.settings.hnsResolvers,
            hnsCustomResolver: this.settings.hnsCustomResolver,
            hnsTimeout: this.settings.hnsTimeout,
            hnsDANE: this.settings.hnsDANE,
            hnsFallbackToDNS: this.settings.hnsFallbackToDNS
        };
    }

    getAdvancedSettings() {
        return {
            hardwareAcceleration: this.settings.hardwareAcceleration,
            experimentalFeatures: this.settings.experimentalFeatures,
            developerMode: this.settings.developerMode,
            customCSS: this.settings.customCSS,
            userAgent: this.settings.userAgent
        };
    }
}

// Create singleton instance
module.exports = SettingsManager;
