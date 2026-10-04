const assert = require('node:assert/strict');
const test = require('node:test');
const { makeBrowser, deferred } = require('./helpers/browser-harness');

test('only a silent reload offers recovery; normal navigation removes the watchdog', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = makeBrowser();
    let recoveries = 0;
    f.browser.confirmReloadRecovery = () => { recoveries++; };
    f.browser.reloadTab(f.tab.id);
    t.mock.timers.tick(1500);
    assert.equal(recoveries, 0);
    assert.equal(f.webContents.listenerCount('did-start-navigation'), 0);
    f.webContents.reload = () => {};
    f.browser.reloadTab(f.tab.id);
    t.mock.timers.tick(1500);
    assert.equal(recoveries, 1);
    assert.equal(f.webContents.listenerCount('did-start-navigation'), 0);
});

test('Stop and destruction cancel the recovery watchdog', t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = makeBrowser();
    let recoveries = 0;
    f.browser.confirmReloadRecovery = () => { recoveries++; };
    f.webContents.reload = () => {};
    f.browser.reloadTab(f.tab.id);
    f.browser.stopTabLoading(f.tab.id);
    t.mock.timers.tick(1500);
    f.browser.reloadTab(f.tab.id);
    f.webContents.emit('destroyed');
    t.mock.timers.tick(1500);
    assert.equal(recoveries, 0);
});

function fixture() {
    const f = makeBrowser();
    const commands = [];
    const prompts = [];
    let attached = false;
    f.webContents.debugger = {
        isAttached: () => attached,
        attach: () => { attached = true; },
        detach: () => { attached = false; },
        sendCommand: async (name, params) => {
            commands.push({ name, params });
            return { frameTree: { frame: { loaderId: 'original-document' } } };
        }
    };
    f.electron.dialog.showMessageBox = async (_window, options) => {
        prompts.push(options);
        return { response: 1 };
    };
    return { ...f, commands, prompts,
        recover: () => f.browser.confirmReloadRecovery(f.tab.id, f.tab.navigationToken, f.webContents.getURL()) };
}

test('explicit confirmation reloads Chromium document without extracting or rebuilding POST data', async () => {
    const f = fixture();
    await f.recover();
    assert.equal(f.prompts[0].defaultId, 0);
    assert.equal(f.prompts[0].cancelId, 0);
    assert.match(f.prompts[0].detail, /repeat an action/);
    assert.equal(f.commands[1].name, 'Page.reload');
    assert.equal(f.commands[1].params.loaderId, 'original-document');
    assert.equal(f.webContents.calls.loadURL.length, 0);
    assert.equal(f.webContents.debugger.isAttached(), false);
});

test('Cancel never resends', async () => {
    const f = fixture();
    f.electron.dialog.showMessageBox = async () => ({ response: 0 });
    await f.recover();
    assert.equal(f.commands.length, 1);
    assert.equal(f.webContents.debugger.isAttached(), false);
});

for (const [name, change] of [
    ['navigation', f => { f.tab.navigationToken = Symbol('new-navigation'); }],
    ['Stop', f => f.tab.navigationAbortController.abort()],
    ['closed tab', f => f.browser.tabs.delete(f.tab.id)],
    ['switched tab', f => { f.browser.activeTabId = 2; }],
    ['changed URL', f => { f.webContents.currentUrl = 'https://elsewhere.test/'; }]
]) test(`${name} while confirmation is open prevents replay`, async () => {
    const f = fixture();
    f.electron.dialog.showMessageBox = async () => { change(f); return { response: 1 }; };
    await f.recover();
    assert.equal(f.commands.length, 1);
});

test('an existing debugger is never detached or reused', async () => {
    const f = fixture();
    f.webContents.debugger.attach();
    await f.recover();
    assert.equal(f.commands.length, 0);
    assert.equal(f.prompts.length, 0);
    assert.equal(f.webContents.debugger.isAttached(), true);
    assert.equal(f.statuses.length, 1);
});

test('concurrent recovery cannot open a second dialog or submit twice', async () => {
    const f = fixture();
    const answer = deferred();
    f.electron.dialog.showMessageBox = () => answer.promise;
    const first = f.recover();
    await f.recover();
    answer.resolve({ response: 1 });
    await first;
    assert.equal(f.commands.filter(c => c.name === 'Page.reload').length, 1);
});

test('a rejected loader guard never falls back to loadURL or a second reload', async () => {
    const f = fixture();
    const command = f.webContents.debugger.sendCommand;
    f.webContents.debugger.sendCommand = async (name, params) => {
        if (name === 'Page.reload') throw new Error('loader changed');
        return command(name, params);
    };
    await f.recover();
    assert.equal(f.webContents.calls.loadURL.length, 0);
    assert.equal(f.webContents.calls.reload, 0);
    assert.equal(f.webContents.debugger.isAttached(), false);
    assert.equal(f.statuses.length, 1);
});
