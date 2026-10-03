const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const { AsyncLogWriter } = require('../async-log');

const singletonDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'skyinclude-history-singleton-'));
const originalLoad = Module._load;
let HistoryManager;
try {
    Module._load = function(request, parent, isMain) {
        if (request === 'electron') return { app: { getPath: () => singletonDirectory } };
        return originalLoad.call(this, request, parent, isMain);
    };
    ({ HistoryManager } = require('../history'));
} finally {
    Module._load = originalLoad;
}
test.after(() => {
    delete require.cache[require.resolve('../history')];
    fs.rmSync(singletonDirectory, { recursive: true, force: true });
});

function temporaryDirectory(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skyinclude-persistence-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

function gate() {
    let notify;
    let release;
    return {
        reached: new Promise(resolve => { notify = resolve; }),
        blocked: new Promise(resolve => { release = resolve; }),
        notify: () => notify(),
        release: () => release()
    };
}

test('history bursts are debounced and flush atomically persists the latest snapshot', async t => {
    const directory = temporaryDirectory(t);
    const historyFile = path.join(directory, 'history.json');
    let writes = 0;
    const manager = new HistoryManager({
        historyFile,
        debounceMs: 60000,
        fileSystem: {
            ...fs.promises,
            writeFile: async (...args) => {
                writes += 1;
                return fs.promises.writeFile(...args);
            }
        }
    });
    for (let index = 0; index < 8; index += 1) {
        manager.addEntry(`https://site-${index}.com`, `Site ${index}`, index, 'https://icon.com/favicon.ico');
    }
    assert.equal(writes, 0, 'navigation must not synchronously write history');
    assert.equal(await manager.flush(), true);
    assert.equal(writes, 1);
    const persisted = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    assert.deepEqual(persisted.map(entry => entry.timestamp), [7, 6, 5, 4, 3, 2, 1, 0]);
    assert.equal(persisted[0].favicon, 'https://icon.com/favicon.ico');
    assert.deepEqual(fs.readdirSync(directory), ['history.json']);
    assert.equal(await manager.flush(), true);
    assert.equal(writes, 1, 'an unchanged flush must not write again');
    const reloaded = new HistoryManager({ historyFile });
    assert.deepEqual(reloaded.getHistory(), persisted);
});

test('clear and remove during a pending history write cannot resurrect deleted entries', async t => {
    const directory = temporaryDirectory(t);
    const historyFile = path.join(directory, 'history.json');
    const firstWrite = gate();
    let writes = 0;
    const manager = new HistoryManager({
        historyFile,
        debounceMs: 60000,
        fileSystem: {
            ...fs.promises,
            writeFile: async (...args) => {
                writes += 1;
                if (writes === 1) {
                    firstWrite.notify();
                    await firstWrite.blocked;
                }
                return fs.promises.writeFile(...args);
            }
        }
    });
    manager.addEntry('https://old.com', 'Old');
    const flushing = manager.flush();
    await firstWrite.reached;
    manager.clearHistory();
    manager.addEntry('https://removed.com', 'Removed');
    assert.equal(manager.removeEntry('https://removed.com'), true);
    firstWrite.release();
    assert.equal(await flushing, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(historyFile, 'utf8')), []);
    assert.equal(writes, 2);
    await manager.flush();
    assert.equal(writes, 2);
});

test('history write errors preserve the last complete file and a later flush can recover', async t => {
    const directory = temporaryDirectory(t);
    const historyFile = path.join(directory, 'history.json');
    fs.writeFileSync(historyFile, '[]');
    let shouldFail = true;
    const errors = [];
    const manager = new HistoryManager({
        historyFile,
        debounceMs: 60000,
        onError: error => errors.push(error.message),
        fileSystem: {
            ...fs.promises,
            rename: async (...args) => {
                if (shouldFail) throw new Error('simulated storage error');
                return fs.promises.rename(...args);
            }
        }
    });
    manager.addEntry('https://saved.com', 'Saved');
    assert.equal(await manager.flush(), false);
    assert.equal(fs.readFileSync(historyFile, 'utf8'), '[]');
    assert.deepEqual(fs.readdirSync(directory), ['history.json']);
    assert.deepEqual(errors, ['simulated storage error']);
    shouldFail = false;
    assert.equal(await manager.flush(), true);
    assert.equal(JSON.parse(fs.readFileSync(historyFile, 'utf8'))[0].url, 'https://saved.com');
});

test('async log batches retain append order and flush makes all accepted entries readable', async t => {
    const directory = temporaryDirectory(t);
    const filePath = path.join(directory, 'nested', 'debug.log');
    let writes = 0;
    const writer = new AsyncLogWriter({
        filePath,
        fileSystem: {
            ...fs.promises,
            appendFile: async (...args) => {
                writes += 1;
                return fs.promises.appendFile(...args);
            }
        }
    });
    const lines = Array.from({ length: 8 }, (_, index) => `event-${index}\n`);
    for (const line of lines) assert.equal(writer.append(line), true);
    assert.equal(writes, 0);
    assert.equal(await writer.flush(), true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), lines.join(''));
    assert.equal(writes, 1);
    assert.equal(writer.pendingBytes, 0);
});

test('async log rotates within the configured file limit and retains one bounded backup', async t => {
    const directory = temporaryDirectory(t);
    const filePath = path.join(directory, 'debug.log');
    const writer = new AsyncLogWriter({ filePath, maxFileBytes: 12, batchBytes: 6 });
    for (const line of ['first\n', 'other\n', 'third\n', 'four!\n', 'fifth\n']) writer.append(line);
    assert.equal(await writer.flush(), true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'fifth\n');
    assert.equal(fs.readFileSync(`${filePath}.1`, 'utf8'), 'third\nfour!\n');
    assert.ok(fs.statSync(filePath).size <= 12);
    assert.ok(fs.statSync(`${filePath}.1`).size <= 12);
    assert.deepEqual(fs.readdirSync(directory).sort(), ['debug.log', 'debug.log.1']);
});

test('async log bounds queued data while storage is stalled and reports dropped lines', async t => {
    const directory = temporaryDirectory(t);
    const filePath = path.join(directory, 'debug.log');
    const firstAppend = gate();
    let writes = 0;
    const writer = new AsyncLogWriter({
        filePath,
        maxFileBytes: 24,
        maxPendingBytes: 12,
        batchBytes: 6,
        fileSystem: {
            ...fs.promises,
            appendFile: async (...args) => {
                writes += 1;
                if (writes === 1) {
                    firstAppend.notify();
                    await firstAppend.blocked;
                }
                return fs.promises.appendFile(...args);
            }
        }
    });
    assert.equal(writer.append('first\n'), true);
    await firstAppend.reached;
    assert.equal(writer.append('other\n'), true);
    assert.equal(writer.append('third\n'), false);
    assert.equal(writer.pendingBytes, 12);
    assert.equal(writer.droppedLines, 1);
    firstAppend.release();
    assert.equal(await writer.flush(), true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'first\nother\n');
});

test('async log safely retains a failed batch for recovery without rejecting append', async t => {
    const directory = temporaryDirectory(t);
    const filePath = path.join(directory, 'debug.log');
    let shouldFail = true;
    const errors = [];
    const writer = new AsyncLogWriter({
        filePath,
        onError: error => errors.push(error.message),
        fileSystem: {
            ...fs.promises,
            appendFile: async (...args) => {
                if (shouldFail) throw new Error('simulated append error');
                return fs.promises.appendFile(...args);
            }
        }
    });
    assert.equal(writer.append('one\n'), true);
    assert.equal(await writer.flush(), false);
    assert.equal(writer.pendingBytes, 4);
    assert.deepEqual(errors, ['simulated append error']);
    shouldFail = false;
    assert.equal(writer.append('two\n'), true);
    assert.equal(await writer.flush(), true);
    assert.equal(fs.readFileSync(filePath, 'utf8'), 'one\ntwo\n');
});
