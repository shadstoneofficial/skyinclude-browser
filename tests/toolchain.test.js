const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { BuilderFetchDownloader, shouldRetryDownloadError } = require('app-builder-lib/out/util/skyincludeFetchDownload');
const { downloadElectronArtifactZip } = require('app-builder-lib/out/util/electronGet');
const { applyToolchainPatch } = require('../scripts/apply-toolchain-patch');
const manifest = require('../package.json');
const lock = require('../package-lock.json');
const execFileAsync = promisify(execFile);
const fixture = Buffer.from('SkyInclude verified build-download fixture\n');
const checksum = createHash('sha256').update(fixture).digest('hex');

// Keep fixture downloads offline; proxy behavior is tested in isolated children.
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[name];

async function tempDirectory(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'skyinclude-toolchain-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

async function serve(t, handler) {
    const server = http.createServer(handler);
    const sockets = new Set();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function artifactOptions(directory, url, extra = {}) {
    return {
        version: '9.9.9', artifactName: 'fixture.bin',
        cacheDir: path.join(directory, 'cache'),
        electronDownload: {
            isGeneric: true,
            checksums: { 'fixture.bin': checksum },
            mirrorOptions: { resolveAssetURL: async () => url },
            downloadOptions: { quiet: true, timeout: { request: 1000 } },
            ...extra,
        },
    };
}

test('locked stable toolchain uses fetch without the vulnerable shared-cache dependency chain', () => {
    assert.equal(manifest.engines.node, '>=22.12.0');
    for (const [name, version] of Object.entries(manifest.devDependencies)) {
        assert.match(version, /^\d+\.\d+\.\d+$/);
        assert.equal(lock.packages[`node_modules/${name}`].version, version);
    }
    assert.equal(manifest.devDependencies.electron, '42.11.3');
    assert.equal(manifest.devDependencies['electron-builder'], '26.15.3');
    assert.equal(manifest.overrides['@electron/get'], '$@electron/get');
    assert.equal(lock.packages['node_modules/app-builder-lib'].version, '26.15.3');
    assert.equal(lock.packages['node_modules/@electron/get'].version, '5.1.0');
    for (const name of Object.keys(lock.packages)) {
        assert.doesNotMatch(name, /node_modules\/(?:got|cacheable-request|http-cache-semantics|patch-package)$/);
        if (name.endsWith('/brace-expansion')) {
            const version = lock.packages[name].version;
            const [major, minor, patch] = version.split('.').map(Number);
            const minimum = { 1: [1, 21], 2: [1, 7], 5: [0, 12] }[major];
            assert.ok(minimum && (minor > minimum[0] || minor === minimum[0] && patch >= minimum[1]), version);
        }
    }
    assert.equal(lock.packages['node_modules/fast-uri'].version, '3.1.8');
    assert.equal(applyToolchainPatch(), 'already applied');
});

test('download patch refuses unexpected versions or file contents without overwriting them', async t => {
    const directory = await tempDirectory(t);
    const builder = path.join(directory, 'node_modules', 'app-builder-lib');
    await fs.mkdir(path.join(builder, 'out', 'util'), { recursive: true });
    const packageFile = path.join(builder, 'package.json');
    await fs.writeFile(packageFile, JSON.stringify({ version: '26.16.0' }));
    assert.throws(() => applyToolchainPatch(directory), /Re-review/);
    await fs.writeFile(packageFile, JSON.stringify({ version: '26.15.3' }));
    const target = path.join(builder, 'out', 'util', 'electronGet.js');
    await fs.writeFile(target, 'unexpected local contents');
    assert.throws(() => applyToolchainPatch(directory), /refusing to overwrite/);
    assert.equal(await fs.readFile(target, 'utf8'), 'unexpected local contents');
});

test('packager fetch download preserves request headers, progress, and checksum verification', async t => {
    const directory = await tempDirectory(t);
    const requests = [];
    const { url } = await serve(t, (req, res) => {
        requests.push(req.headers);
        res.writeHead(200, { 'content-length': fixture.length });
        res.end(fixture);
    });
    const progress = [];
    const target = path.join(directory, 'download.bin');
    await new BuilderFetchDownloader().download(`${url}/fixture.bin`, target, {
        quiet: true, headers: { 'x-build-fixture': 'preserved' },
        getProgressCallback: info => progress.push(info), timeout: { request: 1000 },
    });
    assert.deepEqual(await fs.readFile(target), fixture);
    assert.equal(requests[0]['x-build-fixture'], 'preserved');
    assert.equal(progress.at(-1).transferred, fixture.length);
    const artifact = await downloadElectronArtifactZip(artifactOptions(directory, `${url}/fixture.bin`));
    assert.deepEqual(await fs.readFile(artifact), fixture);
    await assert.rejects(downloadElectronArtifactZip(artifactOptions(directory, `${url}/bad-checksum/fixture.bin`, {
        checksums: { 'fixture.bin': '0'.repeat(64) },
    })), /checksum|digest|SHA256/i);
});

test('transient fetch statuses and nested transport errors remain retryable, not cancellation or integrity failures', () => {
    for (const error of [
        { response: { status: 503 } }, { response: { status: 429 } },
        { response: { statusCode: 500 } }, { code: 'ETIMEDOUT' },
        { cause: { code: 'ECONNRESET' } }, { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } },
    ]) assert.equal(shouldRetryDownloadError(error), true);
    for (const error of [
        null, { response: { status: 404 } }, { response: { status: 401 } },
        { name: 'AbortError', code: 'ECONNRESET' }, { code: 'EINTEGRITY' },
        { cause: { code: 'CERT_HAS_EXPIRED' } }, new Error('invalid checksum'),
    ]) assert.equal(shouldRetryDownloadError(error), false);
});

test('actual packager retries a 503 response and downloads the verified artifact', async t => {
    const directory = await tempDirectory(t);
    let requests = 0;
    const { url } = await serve(t, (_req, res) => {
        requests += 1;
        if (requests === 1) { res.writeHead(503); res.end('temporary'); }
        else res.end(fixture);
    });
    const artifact = await downloadElectronArtifactZip(artifactOptions(directory, `${url}/fixture.bin`));
    assert.deepEqual(await fs.readFile(artifact), fixture);
    assert.equal(requests, 2);
});

test('full-body timeout aborts a stalled download and recovery receives a fresh deadline', async t => {
    const directory = await tempDirectory(t);
    let requests = 0;
    const { url } = await serve(t, (_req, res) => {
        requests += 1;
        if (requests === 1) { res.writeHead(200); res.flushHeaders(); res.write('partial'); }
        else res.end(fixture);
    });
    const artifact = await downloadElectronArtifactZip(artifactOptions(directory, `${url}/fixture.bin`, {
        downloadOptions: { quiet: true, timeout: { request: 250 } },
    }));
    assert.deepEqual(await fs.readFile(artifact), fixture);
    assert.equal(requests, 2);
});

test('build downloader respects cancellation and refuses unsupported insecure options', async t => {
    const directory = await tempDirectory(t);
    const downloader = new BuilderFetchDownloader();
    const target = path.join(directory, 'download.bin');
    await assert.rejects(downloader.download('http://127.0.0.1:1/', target, {
        quiet: true, signal: AbortSignal.abort(),
    }), { name: 'AbortError' });
    await assert.rejects(downloader.download('http://127.0.0.1:1/', target, {
        https: { rejectUnauthorized: false },
    }), /insecure TLS/);
    await assert.rejects(downloader.download('http://127.0.0.1:1/', target, {
        agent: { https: {} },
    }), /custom download agents/);
    await assert.rejects(downloader.download('http://127.0.0.1:1/', target, {
        timeout: { request: 0 },
    }), /positive integer/);
});

test('actual packager honors uppercase/lowercase HTTP proxies and NO_PROXY bypass', async t => {
    const directory = await tempDirectory(t);
    const upstream = await serve(t, (_req, res) => res.end(fixture));
    let tunnels = 0;
    const proxy = await serve(t, (_req, res) => { res.writeHead(502); res.end(); });
    const tunnelSockets = new Set();
    t.after(() => { for (const socket of tunnelSockets) socket.destroy(); });
    proxy.server.on('connect', (_req, client, head) => {
        tunnels += 1;
        const remote = net.connect(upstream.server.address().port, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) remote.write(head);
            client.pipe(remote); remote.pipe(client);
        });
        tunnelSockets.add(remote);
        remote.on('close', () => tunnelSockets.delete(remote));
        remote.on('error', () => client.destroy());
        client.on('close', () => remote.destroy());
    });
    const probe = path.join(__dirname, 'helpers', 'toolchain-proxy-probe.js');
    for (const [index, proxyVariable, bypass] of [[0, 'HTTP_PROXY', false], [1, 'http_proxy', false], [2, 'HTTP_PROXY', true]]) {
        const env = { ...process.env, [proxyVariable]: proxy.url, NO_PROXY: bypass ? '127.0.0.1' : '' };
        await execFileAsync(process.execPath, [probe, `${upstream.url}/fixture.bin`, path.join(directory, `cache-${index}`), checksum], {
            env, timeout: 15000, maxBuffer: 64 * 1024,
        });
        assert.equal(tunnels, bypass ? 2 : index + 1);
    }
});
