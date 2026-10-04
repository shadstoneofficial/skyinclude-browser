const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const {
    BUILT_IN_RESOLVERS,
    ARCHIVED_RESOLVERS,
    isRetiredResolver,
    normalizeResolverDescriptor,
    normalizeResolverList,
    normalizeResolverUrl,
    parseResolverString
} = require('./resolver-config.js');

const HNS_RESOLVER_DEFAULTS_VERSION = 4;
const LEGACY_HNSDOH = { id: 'hnsdoh', name: 'HNS DoH', transport: 'doh-wire', url: 'https://hnsdoh.com/dns-query' };
const LEGACY_WEB3DNS = { id: 'web3dns', name: 'Web3DNS', transport: 'dns-json', url: 'https://api.web3dns.net/' };
const LEGACY_DEFAULTS = {
    0: [LEGACY_HNSDOH],
    1: [LEGACY_HNSDOH],
    2: [LEGACY_HNSDOH, LEGACY_WEB3DNS],
    3: [LEGACY_HNSDOH, LEGACY_WEB3DNS, ARCHIVED_RESOLVERS[0]]
};

function isUntouchedLegacyList(inputs, version) {
    const expected = LEGACY_DEFAULTS[version];
    return Boolean(expected && Array.isArray(inputs) && inputs.length === expected.length &&
        inputs.every((input, index) => {
            const raw = typeof input === 'string' ? parseResolverString(input) : input;
            const entry = expected[index];
            if (!raw || raw.enabled === false || (raw.id && raw.id !== entry.id) ||
                (raw.name && raw.name !== entry.name)) return false;
            const transport = raw.transport || entry.transport;
            return transport === entry.transport &&
                normalizeResolverUrl(String(raw.url || raw.endpoint || '').trim(), transport) === entry.url;
        }));
}

function normalizeSavedResolvers(inputs) {
    const seen = new Set();
    return (Array.isArray(inputs) ? inputs : []).flatMap((input, index) => {
        const disabled = input && typeof input === 'object' && input.enabled === false;
        const resolver = normalizeResolverDescriptor(disabled ? { ...input, enabled: true } : input, index);
        if (!resolver) return [];
        const key = `${resolver.transport}|${resolver.url}|${disabled ? 'disabled' : 'enabled'}`.toLowerCase();
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ ...resolver, enabled: !disabled }];
    });
}

function retirementNotice(resolvers, customResolver) {
    const requiresResolverSelection = !normalizeResolverList([customResolver, ...resolvers]).length;
    return {
        id: 'shakestation-retired',
        title: 'Shakestation retired',
        message: 'Shakestation has permanently retired its public HNS resolver and was removed from your active configuration.' +
            (requiresResolverSelection ? ' Choose an active HNS resolver to resume native name resolution.' : ''),
        requiresResolverSelection
    };
}

class SettingsManager {
    constructor() {
        this.settingsFile = path.join(app.getPath('userData'), 'settings.json');
        this.defaultSettings = {
            // HNS Resolution
            hnsResolutionMode: 'doh', // DNS-over-HTTPS; no bundled P2P client yet.
            hnsResolvers: normalizeResolverList(BUILT_IN_RESOLVERS),
            hnsResolverDefaultsVersion: HNS_RESOLVER_DEFAULTS_VERSION,
            hnsResolverRetirementNotice: null,
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
            version: this.settings.hnsResolverDefaultsVersion,
            customResolver: this.settings.hnsCustomResolver,
            notice: this.settings.hnsResolverRetirementNotice
        });
        const inputs = Array.isArray(this.settings.hnsResolvers) ? this.settings.hnsResolvers : [];
        const currentVersion = Number(this.settings.hnsResolverDefaultsVersion) || 0;
        const retired = inputs.some(isRetiredResolver) || isRetiredResolver(this.settings.hnsCustomResolver);
        const untouched = !String(this.settings.hnsCustomResolver || '').trim() &&
            isUntouchedLegacyList(inputs, currentVersion);
        this.settings.hnsResolvers = untouched
            ? normalizeResolverList(BUILT_IN_RESOLVERS)
            : normalizeSavedResolvers(inputs);
        if (isRetiredResolver(this.settings.hnsCustomResolver)) this.settings.hnsCustomResolver = '';
        if (retired || this.settings.hnsResolverRetirementNotice?.id === 'shakestation-retired') {
            this.settings.hnsResolverRetirementNotice = retirementNotice(
                this.settings.hnsResolvers, this.settings.hnsCustomResolver);
        }
        this.settings.hnsResolverDefaultsVersion = HNS_RESOLVER_DEFAULTS_VERSION;
        return before !== JSON.stringify({
            resolvers: this.settings.hnsResolvers,
            version: this.settings.hnsResolverDefaultsVersion,
            customResolver: this.settings.hnsCustomResolver,
            notice: this.settings.hnsResolverRetirementNotice
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
            validated.hnsResolutionMode = 'doh';
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
            if (isRetiredResolver(customResolver)) {
                validated.hnsCustomResolver = '';
            } else if (!customResolver || normalizeResolverDescriptor(customResolver)) {
                validated.hnsCustomResolver = customResolver;
            }
        }
        
        // Validate array settings
        if (Array.isArray(settings.hnsResolvers)) {
            validated.hnsResolvers = normalizeSavedResolvers(settings.hnsResolvers);
        }
        if (isRetiredResolver(settings.hnsCustomResolver) ||
            (Array.isArray(settings.hnsResolvers) && settings.hnsResolvers.some(isRetiredResolver)) ||
            this.settings.hnsResolverRetirementNotice?.id === 'shakestation-retired') {
            validated.hnsResolverRetirementNotice = retirementNotice(
                validated.hnsResolvers ?? this.settings.hnsResolvers ?? [],
                validated.hnsCustomResolver ?? this.settings.hnsCustomResolver ?? '');
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
            
            // Validate from the original import when applying it so retirement
            // detection is not lost after an earlier normalization removed it.
            const success = this.updateSettings(importedSettings);
            
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
