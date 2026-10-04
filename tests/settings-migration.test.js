const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { BUILT_IN_RESOLVERS, normalizeResolverList } = require('../resolver-config');

function withSettings(saved, callback) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'skyinclude-retirement-settings-'));
    const settingsPath = path.join(userData, 'settings.json');
    if (saved !== undefined) fs.writeFileSync(settingsPath, JSON.stringify(saved));
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (request === 'electron') return { app: { getPath: () => userData } };
        return originalLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve('../settings')];
        const SettingsManager = require('../settings');
        callback(new SettingsManager(), settingsPath, SettingsManager);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../settings')];
        fs.rmSync(userData, { recursive: true, force: true });
    }
}

const oldDefaults = ['https://hnsdoh.com/dns-query', 'dns-json https://api.web3dns.net/',
    'https://resolve.shakestation.io/dns-query'];

test('fresh settings use only the active binary defaults and no migration warning', () => {
    withSettings(undefined, manager => {
        assert.deepEqual(manager.getSetting('hnsResolvers'), normalizeResolverList(BUILT_IN_RESOLVERS));
        assert.equal(manager.getSetting('hnsResolverRetirementNotice'), null);
    });
});

test('untouched version 3 defaults migrate once and persist the retirement notice', () => {
    withSettings({ hnsResolvers: oldDefaults, hnsResolverDefaultsVersion: 3 }, (manager, file, Manager) => {
        assert.deepEqual(manager.getSetting('hnsResolvers'), normalizeResolverList(BUILT_IN_RESOLVERS));
        assert.equal(manager.getSetting('hnsResolverRetirementNotice').id, 'shakestation-retired');
        assert.equal(manager.getSetting('hnsResolverRetirementNotice').requiresResolverSelection, false);
        const first = fs.readFileSync(file, 'utf8');
        assert.equal(manager.migrateHnsResolverSettings(), false);
        const reloaded = new Manager();
        assert.deepEqual(reloaded.getSettings(), manager.getSettings());
        assert.equal(fs.readFileSync(file, 'utf8'), first, 'reopening does not rewrite settings');
    });
});

test('custom order and JSON transport survive retirement without adding new providers', () => {
    withSettings({ hnsResolvers: [oldDefaults[1], oldDefaults[2], 'https://custom.example/dns-query', oldDefaults[0]],
        hnsResolverDefaultsVersion: 3 }, manager => {
        assert.deepEqual(manager.getSetting('hnsResolvers').map(({ transport, url }) => ({ transport, url })), [
            { transport: 'dns-json', url: 'https://api.web3dns.net/' },
            { transport: 'doh-wire', url: 'https://custom.example/dns-query' },
            { transport: 'doh-wire', url: 'https://hnsdoh.com/dns-query' }
        ]);
        assert.equal(manager.getSetting('hnsResolverRetirementNotice').requiresResolverSelection, false);
    });
});

test('a custom override makes an otherwise default list user-managed', () => {
    withSettings({ hnsResolvers: oldDefaults, hnsResolverDefaultsVersion: 3,
        hnsCustomResolver: 'https://custom.example/dns-query' }, manager => {
        assert.equal(manager.getSetting('hnsResolvers')[1].url, 'https://api.web3dns.net/');
        assert.equal(manager.getSetting('hnsCustomResolver'), 'https://custom.example/dns-query');
    });
});

test('disabled, shortened, renamed, or id-spoofed lists are not treated as untouched defaults', () => {
    for (const saved of [
        { hnsResolverDefaultsVersion: 3, hnsResolvers: [oldDefaults[0]] },
        { hnsResolverDefaultsVersion: 0, hnsResolvers: [{ id: 'hnsdoh', url: 'https://custom.example/' }] },
        { hnsResolverDefaultsVersion: 2, hnsResolvers: [{ name: 'My primary', url: oldDefaults[0] }, oldDefaults[1]] },
        { hnsResolverDefaultsVersion: 2, hnsResolvers: [{ enabled: false, url: oldDefaults[0] }, oldDefaults[1]] }
    ]) {
        withSettings(saved, manager => {
            assert.equal(manager.getSetting('hnsResolvers').some(resolver => resolver.url === 'https://doh.web3dns.net/'), false);
            if (saved.hnsResolvers[0]?.enabled === false) {
                assert.equal(manager.getSetting('hnsResolvers')[0].enabled, false);
                assert.equal(normalizeResolverList(manager.getSetting('hnsResolvers')).length, 1);
            }
        });
    }
});

test('retired custom-only configurations remain empty with an actionable persisted warning', () => {
    for (const saved of [
        { hnsResolvers: [oldDefaults[2]], hnsCustomResolver: '' },
        { hnsResolvers: [], hnsCustomResolver: 'dns-json https://resolve.shakestation.io/custom' },
        { hnsResolvers: [{ enabled: false, url: oldDefaults[2] }], hnsCustomResolver: oldDefaults[2] }
    ]) {
        withSettings({ ...saved, hnsResolverDefaultsVersion: 3 }, (manager, file) => {
            assert.deepEqual(manager.getSetting('hnsResolvers'), []);
            assert.equal(manager.getSetting('hnsCustomResolver'), '');
            const notice = manager.getSetting('hnsResolverRetirementNotice');
            assert.equal(notice.requiresResolverSelection, true);
            assert.match(notice.message, /Choose an active HNS resolver/);
            assert.deepEqual(JSON.parse(fs.readFileSync(file)).hnsResolverRetirementNotice, notice);
        });
    }
});

test('retirement never removes arbitrary IDs or hostname-prefix lookalikes', () => {
    withSettings({ hnsResolverDefaultsVersion: 3, hnsResolvers: [
        { id: 'shakestation', url: 'https://custom.example/' },
        'https://resolve.shakestation.io.evil.example/'
    ], hnsCustomResolver: 'https://other.resolve.shakestation.io/' }, manager => {
        assert.equal(manager.getSetting('hnsResolvers').length, 2);
        assert.equal(manager.getSetting('hnsCustomResolver'), 'https://other.resolve.shakestation.io/');
        assert.equal(manager.getSetting('hnsResolverRetirementNotice'), null);
    });
});

test('settings updates cannot reactivate retired endpoints and clear the selection warning after a safe choice', () => {
    withSettings({ hnsResolverDefaultsVersion: 4, hnsResolvers: [], hnsCustomResolver: '' }, manager => {
        manager.notifySettingsChanged = () => {};
        assert.equal(manager.updateSettings({ hnsResolvers: [oldDefaults[2]], hnsCustomResolver: oldDefaults[2] }), true);
        assert.deepEqual(manager.getSetting('hnsResolvers'), []);
        assert.equal(manager.getSetting('hnsCustomResolver'), '');
        assert.equal(manager.getSetting('hnsResolverRetirementNotice').requiresResolverSelection, true);
        manager.updateSettings({ hnsCustomResolver: 'https://custom.example/' });
        assert.equal(manager.getSetting('hnsResolverRetirementNotice').requiresResolverSelection, false);
        assert.equal(manager.getSetting('hnsResolverRetirementNotice').id, 'shakestation-retired');
    });
});

test('settings import retains the retirement notice after normalization removes the retired entries', () => {
    withSettings(undefined, (manager, file) => {
        manager.notifySettingsChanged = () => {};
        assert.ok(manager.importSettings(JSON.stringify({
            hnsResolvers: [oldDefaults[2]], hnsCustomResolver: oldDefaults[2]
        })) > 0);
        assert.deepEqual(manager.getSetting('hnsResolvers'), []);
        assert.equal(manager.getSetting('hnsResolverRetirementNotice').requiresResolverSelection, true);
        assert.equal(JSON.parse(fs.readFileSync(file)).hnsResolverRetirementNotice.id, 'shakestation-retired');
    });
});

test('disabled descriptors survive reopening and do not suppress an explicitly enabled duplicate', () => {
    withSettings({ hnsResolvers: [
        { url: 'https://custom.example/dns-query', enabled: false },
        { url: 'https://custom.example/dns-query', enabled: true }
    ], hnsResolverDefaultsVersion: 3 }, (manager, _file, Manager) => {
        assert.deepEqual(manager.getSetting('hnsResolvers').map(resolver => resolver.enabled), [false, true]);
        assert.equal(normalizeResolverList(manager.getSetting('hnsResolvers')).length, 1);
        assert.deepEqual(new Manager().getSetting('hnsResolvers'), manager.getSetting('hnsResolvers'));
    });
});

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

test('SettingsManager upgrades the untouched legacy default with all current built-ins', () => {
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
        assert.deepEqual(
            manager.getSetting('hnsResolvers').map(resolver => resolver.id),
            ['hnsdoh', 'web3dns']
        );
        assert.equal(manager.getSetting('hnsResolverDefaultsVersion'), 4);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../settings')];
        fs.rmSync(userData, { recursive: true, force: true });
    }
});

test('SettingsManager upgrades the untouched version 2 pair to the current wire defaults', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'skyinclude-v2-default-settings-'));
    const settingsPath = path.join(userData, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
        hnsResolvers: [
            'https://hnsdoh.com/dns-query',
            'dns-json https://api.web3dns.net/'
        ],
        hnsResolverDefaultsVersion: 2
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
        assert.deepEqual(
            manager.getSetting('hnsResolvers').map(resolver => resolver.id),
            ['hnsdoh', 'web3dns']
        );
        assert.equal(manager.getSetting('hnsResolverDefaultsVersion'), 4);
        assert.equal(manager.getSetting('hnsResolvers')[1].url, 'https://doh.web3dns.net/');
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../settings')];
        fs.rmSync(userData, { recursive: true, force: true });
    }
});

test('SettingsManager preserves customized version 2 resolver order', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'skyinclude-v2-custom-settings-'));
    const settingsPath = path.join(userData, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
        hnsResolvers: [
            'dns-json https://api.web3dns.net/',
            'https://hnsdoh.com/dns-query'
        ],
        hnsResolverDefaultsVersion: 2
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
        assert.deepEqual(
            manager.getSetting('hnsResolvers').map(resolver => resolver.id),
            ['web3dns', 'hnsdoh']
        );
        assert.equal(manager.getSetting('hnsResolverDefaultsVersion'), 4);
    } finally {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../settings')];
        fs.rmSync(userData, { recursive: true, force: true });
    }
});
