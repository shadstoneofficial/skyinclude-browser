const assert = require('node:assert/strict');
const nodeTest = require('node:test');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { makeBrowser, deferred } = require('./helpers/browser-harness');
const test = (name, fn) => nodeTest(name, { timeout: 5000 }, fn);

async function listen(t, server) {
    const sockets = new Set();
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return server.address().port;
}

async function proxy(t, options = {}) {
    const { browser } = makeBrowser();
    // These tests exercise raw transport/echo servers. Actual DANE admission
    // and TLS are covered separately by hns-https-redirect.test.js.
    browser.ensureHnsHttpsAdmission = async () => ({ state: 'verified' });
    browser.hnsProxyHosts = new Map([['lisa.agent', '127.0.0.1']]);
    browser.proxyConnectionTimeoutMs = options.connectionTimeoutMs || 500;
    browser.proxyIdleTimeoutMs = options.idleTimeoutMs || 1000;
    browser.hnsProxyServer = null;
    browser.hnsProxyPort = null;
    await browser.startHnsProxy();
    const sockets = new Set();
    browser.hnsProxyServer.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
    });
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => browser.hnsProxyServer.close(resolve));
    });
    return browser;
}

function request(port, url, options = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: url, ...options }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('native HTTP proxy preserves hostname, non-default Host port, path and normal cache headers', async t => {
    let seen;
    const upstreamPort = await listen(t, http.createServer((req, res) => {
        seen = { host: req.headers.host, path: req.url, cache: req.headers['cache-control'], pragma: req.headers.pragma };
        res.writeHead(200, { 'Cache-Control': 'public, max-age=300' });
        res.end('native website');
    }));
    const browser = await proxy(t);
    const result = await request(browser.hnsProxyPort, `http://lisa.agent:${upstreamPort}/services?view=all`);
    assert.equal(result.status, 200);
    assert.equal(result.body, 'native website');
    assert.deepEqual(seen, { host: `lisa.agent:${upstreamPort}`, path: '/services?view=all', cache: undefined, pragma: undefined });
    assert.equal(result.headers['cache-control'], 'public, max-age=300');
});

test('ordinary IP/ICANN proxy path does not attempt HNS resolution', async t => {
    const upstreamPort = await listen(t, http.createServer((req, res) => res.end('ordinary site')));
    const browser = await proxy(t);
    browser.resolveHNS = () => { throw new Error('Should not use HNS'); };
    const result = await request(browser.hnsProxyPort, `http://127.0.0.1:${upstreamPort}/`);
    assert.equal(result.status, 200);
    assert.equal(result.body, 'ordinary site');
});

test('HTTP first-header deadline closes a stalled upstream with a retryable timeout', async t => {
    const upstreamClosed = deferred();
    const upstreamPort = await listen(t, http.createServer((req, res) => {
        res.once('close', upstreamClosed.resolve);
    }));
    const browser = await proxy(t, { connectionTimeoutMs: 60 });
    const result = await request(browser.hnsProxyPort, `http://lisa.agent:${upstreamPort}/`);
    assert.equal(result.status, 504);
    assert.match(result.body, /timed out.*retry/i);
    await upstreamClosed.promise;
});

test('active uploads can exceed the connection deadline without being interrupted', async t => {
    const upstreamPort = await listen(t, http.createServer((req, res) => {
        let bytes = 0;
        req.on('data', chunk => { bytes += chunk.length; });
        req.on('end', () => res.end(String(bytes)));
    }));
    const browser = await proxy(t, { connectionTimeoutMs: 60, idleTimeoutMs: 500 });
    const result = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: browser.hnsProxyPort,
            path: `http://lisa.agent:${upstreamPort}/upload`, method: 'POST' }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.write('a');
        let remaining = 5;
        const interval = setInterval(() => {
            req.write('a');
            if (--remaining === 0) {
                clearInterval(interval);
                req.end();
            }
        }, 25);
        t.after(() => clearInterval(interval));
    });
    assert.deepEqual(result, { status: 200, body: '6' });
});

test('closing an HTTP client tears down the unfinished upstream response', async t => {
    const upstreamClosed = deferred();
    const upstreamPort = await listen(t, http.createServer((req, res) => {
        res.once('close', upstreamClosed.resolve);
        res.write('first chunk');
    }));
    const browser = await proxy(t);
    await new Promise((resolve, reject) => {
        const req = http.get({ hostname: '127.0.0.1', port: browser.hnsProxyPort,
            path: `http://lisa.agent:${upstreamPort}/stream` }, res => {
            res.once('data', () => {
                res.destroy();
                req.destroy();
                resolve();
            });
        });
        req.on('error', reject);
    });
    await upstreamClosed.promise;
});

test('CONNECT is a transparent native-host tunnel and survives past its connection deadline', async t => {
    const upstreamPort = await listen(t, net.createServer(socket => socket.pipe(socket)));
    const browser = await proxy(t, { connectionTimeoutMs: 60 });
    const client = net.connect(browser.hnsProxyPort, '127.0.0.1');
    t.after(() => client.destroy());
    await once(client, 'connect');
    client.write(`CONNECT lisa.agent:${upstreamPort} HTTP/1.1\r\nHost: lisa.agent:${upstreamPort}\r\n\r\n`);
    const [headers] = await once(client, 'data');
    assert.equal(headers.toString(), 'HTTP/1.1 200 Connection Established\r\n\r\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    const bytes = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0xff, 0x00, 0x7f]);
    client.write(bytes);
    const [echo] = await once(client, 'data');
    assert.deepEqual(echo, bytes);
});

test('closing a pending CONNECT client cancels its shared-resolution consumer', async t => {
    const browser = await proxy(t, { connectionTimeoutMs: 4000 });
    browser.hnsProxyHosts.clear();
    const resolving = deferred();
    const cancelled = deferred();
    browser.resolveHNS = (domain, { signal }) => new Promise((resolve, reject) => {
        resolving.resolve();
        signal.addEventListener('abort', () => {
            cancelled.resolve();
            reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        }, { once: true });
    });
    const client = net.connect(browser.hnsProxyPort, '127.0.0.1');
    t.after(() => client.destroy());
    await once(client, 'connect');
    client.write('CONNECT lisa.agent:443 HTTP/1.1\r\nHost: lisa.agent\r\n\r\n');
    await resolving.promise;
    client.destroy();
    await Promise.race([
        cancelled.promise,
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Disconnect was not cancelled promptly')), 250);
            t.after(() => clearTimeout(timer));
        })
    ]);
});

test('CONNECT preserves early TLS bytes sent while native resolution is pending', async t => {
    const upstreamPort = await listen(t, net.createServer(socket => socket.pipe(socket)));
    const browser = await proxy(t);
    browser.hnsProxyHosts.clear();
    const resolving = deferred();
    const answer = deferred();
    browser.resolveHNS = () => { resolving.resolve(); return answer.promise; };
    const client = net.connect(browser.hnsProxyPort, '127.0.0.1');
    t.after(() => client.destroy());
    await once(client, 'connect');
    let received = Buffer.alloc(0);
    const complete = deferred();
    client.on('data', chunk => {
        received = Buffer.concat([received, chunk]);
        if (received.includes(Buffer.from('early-hello'))) complete.resolve();
    });
    client.write(`CONNECT lisa.agent:${upstreamPort} HTTP/1.1\r\nHost: lisa.agent\r\n\r\n`);
    await resolving.promise;
    client.write('early-hello');
    answer.resolve({ address: '127.0.0.1' });
    await complete.promise;
    assert.equal(received.toString(), 'HTTP/1.1 200 Connection Established\r\n\r\nearly-hello');
});

test('malformed CONNECT authorities and port zero never start an upstream connection', async t => {
    const browser = await proxy(t);
    browser.resolveHNS = () => { throw new Error('Should not resolve an invalid target'); };
    for (const target of ['lisa.agent:0', 'user@lisa.agent:443', 'lisa.agent:443/private']) {
        const client = net.connect(browser.hnsProxyPort, '127.0.0.1');
        t.after(() => client.destroy());
        await once(client, 'connect');
        client.write(`CONNECT ${target} HTTP/1.1\r\nHost: lisa.agent\r\n\r\n`);
        const [reply] = await once(client, 'data');
        assert.match(reply.toString(), /HTTP\/1\.1 500/);
        client.destroy();
    }
});
