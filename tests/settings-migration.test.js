const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

test('SettingsManager persists legacy resolver strings as ordered descriptors', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'skyinclude-settings-'));
    const settingsPath = path.join(userData, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
        hnsResolvers: [
            'https://query.hdns.io/dns-query',
            'dns-json https://api.web3dns.net/',
            'https://hnsdoh.com/dns-query'
        ],
        hnsCustomResolver: 'https://custom.example/dns-query'
    }));

    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'electron') {
            return { app: { getPath: () => userData } };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        delete require.cache[require.resolve('../settings')];
        const SettingsManager = require('../settings');
        const manager = new SettingsManager();
        const resolvers = manager.getSetting('hnsResolvers');

        assert.deepEqual(resolvers.map(resolver => resolver.id), ['hdns', 'web3dns', 'hnsdoh']);
        assert.deepEqual(resolvers.map(resolver => resolver.transport), ['doh-wire', 'dns-json', 'doh-wire']);
        assert.equal(manager.getSetting('hnsCustomResolver'), 'https://custom.example/dns-query');

        const persisted = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        assert.deepEqual(persisted.hnsResolvers, resolvers);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../settings')];
        fs.rmSync(userData, { recursive: true, force: true });
    }
});

test('SettingsManager upgrades only the untouched legacy default with built-in Web3DNS', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'skyinclude-default-settings-'));
    const settingsPath = path.join(userData, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
        hnsResolvers: ['https://hnsdoh.com/dns-query']
    }));

    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'electron') {
            return { app: { getPath: () => userData } };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        delete require.cache[require.resolve('../settings')];
        const SettingsManager = require('../settings');
        const manager = new SettingsManager();
        assert.deepEqual(manager.getSetting('hnsResolvers').map(resolver => resolver.id), ['hnsdoh', 'web3dns']);
        assert.equal(manager.getSetting('hnsResolverDefaultsVersion'), 2);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../settings')];
        fs.rmSync(userData, { recursive: true, force: true });
    }
});
