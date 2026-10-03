const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const readSource = filename => fs.readFileSync(path.join(root, filename), 'utf8');
const main = readSource('main.js');
const renderer = readSource('renderer.js');
const index = readSource('index.html');
const settingsUi = readSource('settings-ui.html');
const packageJson = JSON.parse(readSource('package.json'));

function settingLabel(html, id) {
    const labels = html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) || [];
    const label = labels.find(value => value.includes(`id="${id}"`));
    assert.ok(label, `setting label for ${id} must exist`);
    assert.match(label, /<input\b[^>]*\bdisabled\b[^>]*>/, `${id} must not imply a working toggle`);
    return label;
}

test('unimplemented tracker and traditional-DNS fallback settings accurately describe their behavior', () => {
    assert.match(settingLabel(index, 'block-trackers'), /Tracker blocking \(not implemented yet\)/);
    assert.match(settingLabel(settingsUi, 'blockTrackers'), /Tracker blocking \(not implemented yet\)/);
    assert.match(settingsUi, /No tracker filter is active/);
    assert.match(settingLabel(settingsUi, 'hnsFallbackToDNS'), /Traditional DNS fallback \(not used for HNS\)/);
    assert.match(settingsUi, /resolver outages do not fall back to traditional DNS/);
});

test('certificate verification remains enforced rather than offering an ineffective disable switch', () => {
    const label = settingLabel(index, 'strict-ssl');
    assert.match(label, /\bchecked\b/);
    assert.match(label, /Certificate verification \(always enforced\)/);
    assert.match(main, /setCertificateVerifyProc/);
    assert.doesNotMatch(main, /ignore-certificate-errors/);
});

test('settings expose DoH without presenting an unavailable P2P light client as implemented', () => {
    for (const html of [index, settingsUi]) {
        assert.doesNotMatch(html, /<(?:input|option)\b[^>]*value="p2p"/i);
        assert.match(html, /A bundled P2P light client is not available yet/);
        assert.match(html, /Resolver operators can observe requested names/);
    }
    assert.match(settingsUi, /<option value="doh">/);
    assert.match(index, /name="hns-mode" value="doh"/);
});

test('new-tab entry points defer to the configured homepage and address input uses the search preference', () => {
    assert.match(main, /async createNewTab\(url\)\s*\{\s*url = this\.validateNavigationInput\(url, this\.settingsManager\.getSetting\('homepage'\)/);
    assert.match(main, /ipcMain\.handle\('new-tab',[\s\S]*?getSetting\('homepage'\)/);
    assert.match(renderer, /async createNewTab\(url = ''\)/);
    assert.match(renderer, /window\.electronAPI\.newTab\(url\)/);
    assert.match(main, /resolveAddressInput\(input, this\.settingsManager\.getSetting\('searchEngine'\)\)/);
    assert.match(settingsUi, /id="homepage"/);
    assert.match(settingsUi, /id="searchEngine"/);
});

test('packaging includes address input, queued logs, and the bundled IANA snapshot', () => {
    for (const moduleName of ['address-input.js', 'async-log.js']) {
        assert.ok(packageJson.build.files.includes(moduleName), `${moduleName} must ship in the app`);
        assert.ok(packageJson.scripts.check.includes(`node --check ${moduleName}`));
        assert.ok(fs.existsSync(path.join(root, moduleName)));
    }
    assert.ok(packageJson.build.files.includes('assets/**/*'));
    assert.ok(fs.existsSync(path.join(root, 'assets/icann-tlds.json')));
    assert.match(readSource('navigation-policy.js'), /require\('\.\/assets\/icann-tlds\.json'\)/);
});

test('quit waits for history and log queues and debug-log opening flushes the pending log', () => {
    const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf('app.whenReady()'));
    assert.match(beforeQuit, /event\.preventDefault\(\)/);
    assert.match(beforeQuit, /if \(persistenceFlushInProgress\) return/);
    assert.match(beforeQuit, /require\('\.\/history\.js'\)\.flush\(\)/);
    assert.match(beforeQuit, /activeBrowser\?\.logWriter\.flush\(\)/);
    assert.match(beforeQuit, /finally\([\s\S]*?persistenceFlushedForQuit = true;\s*app\.quit\(\)/);
    const openLog = main.slice(main.indexOf('async openDebugLog()'), main.indexOf('async clearCacheAndReload()'));
    assert.match(openLog, /await this\.logWriter\.flush\(\)/);
});

test('quit lifecycle flushes once, waits for both queues, and permits the final quit', async () => {
    const shutdown = main.slice(main.indexOf('let persistenceFlushedForQuit'), main.indexOf('app.whenReady()'));
    const handlers = new Map();
    let releaseHistory;
    let releaseLog;
    let historyFlushes = 0;
    let logFlushes = 0;
    let quits = 0;
    let aborts = 0;
    let stops = 0;
    const historyPending = new Promise(resolve => { releaseHistory = resolve; });
    const logPending = new Promise(resolve => { releaseLog = resolve; });
    vm.runInNewContext(shutdown, {
        app: {
            on: (event, callback) => handlers.set(event, callback),
            quit: () => { quits += 1; }
        },
        activeBrowser: {
            tabs: new Map([[1, {
                navigationAbortController: { abort: () => { aborts += 1; } },
                view: { webContents: { isDestroyed: () => false, stop: () => { stops += 1; } } }
            }]]),
            logWriter: { flush: () => { logFlushes += 1; return logPending; } }
        },
        require: request => {
            assert.equal(request, './history.js');
            return { flush: () => { historyFlushes += 1; return historyPending; } };
        },
        console: { error: error => { throw error; } }
    });
    let prevented = 0;
    const event = { preventDefault: () => { prevented += 1; } };
    const beforeQuit = handlers.get('before-quit');
    beforeQuit(event);
    beforeQuit(event);
    assert.equal(prevented, 2);
    assert.equal(historyFlushes, 1);
    assert.equal(logFlushes, 1);
    assert.equal(aborts, 1);
    assert.equal(stops, 1);
    releaseHistory(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(quits, 0, 'logs must finish before allowing quit');
    releaseLog(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(quits, 1);
    beforeQuit(event);
    assert.equal(prevented, 2, 'the final quit must no longer be prevented');
    assert.equal(historyFlushes, 1);
});
