const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const test = require('node:test');
const { inspectHnsHttpsCertificate } = require('../hns-tls');

function createSocket(certificate = { raw: Buffer.from('not-a-real-cert') }) {
    const socket = new EventEmitter();
    socket.getPeerCertificate = () => certificate;
    socket.setTimeout = () => {};
    socket.end = () => {};
    socket.destroy = error => {
        socket.destroyed = true;
        if (error) socket.emit('error', error);
        socket.emit('close');
    };
    return socket;
}

test('passes HNS hostname as SNI servername', async () => {
    let optionsSeen = null;
    const socket = createSocket({ raw: Buffer.from('not-a-real-cert') });
    const tlsModule = {
        connect(options, callback) {
            optionsSeen = options;
            process.nextTick(callback);
            return socket;
        }
    };

    const result = await inspectHnsHttpsCertificate({
        domain: 'janice.agent',
        address: '203.0.113.10',
        tlsModule
    });

    assert.equal(optionsSeen.host, '203.0.113.10');
    assert.equal(optionsSeen.servername, 'janice.agent');
    assert.equal(optionsSeen.rejectUnauthorized, false);
    assert.equal(result.ok, true);
    assert.equal(socket.destroyed, true);
});

test('returns connection_failure for TLS errors', async () => {
    const socket = createSocket();
    const tlsModule = {
        connect() {
            process.nextTick(() => socket.emit('error', new Error('connect failed')));
            return socket;
        }
    };

    const result = await inspectHnsHttpsCertificate({
        domain: 'janice.agent',
        address: '203.0.113.10',
        tlsModule
    });

    assert.equal(result.ok, false);
    assert.equal(result.state, 'connection_failure');
    assert.equal(result.error, 'connect failed');
});

test('an already-aborted certificate probe opens no connection', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(inspectHnsHttpsCertificate({
        domain: 'janice.agent', address: '203.0.113.10', signal: controller.signal,
        tlsModule: { connect() { assert.fail('aborted probe must not connect'); } }
    }), { name: 'AbortError' });
});

test('aborting an in-flight probe destroys its socket', async () => {
    const controller = new AbortController();
    const socket = createSocket();
    const result = inspectHnsHttpsCertificate({
        domain: 'janice.agent', address: '203.0.113.10', signal: controller.signal,
        tlsModule: { connect() { return socket; } }
    });
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(socket.destroyed, true);
});

test('deadline covers a real TCP peer that never completes TLS', async t => {
    const peers = new Set();
    const server = net.createServer(socket => {
        peers.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => peers.delete(socket));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const peer of peers) peer.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    const result = await inspectHnsHttpsCertificate({
        domain: 'janice.agent', address: '127.0.0.1', port: server.address().port, timeout: 60
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'TLS connection timeout');
});

test('socket activity cannot extend the absolute certificate-probe deadline', async t => {
    const socket = createSocket();
    const activity = setInterval(() => socket.emit('data', Buffer.from('x')), 5);
    t.after(() => clearInterval(activity));
    const result = await inspectHnsHttpsCertificate({
        domain: 'janice.agent', address: '203.0.113.10', timeout: 30,
        tlsModule: { connect() { return socket; } }
    });
    assert.equal(result.error, 'TLS connection timeout');
    assert.equal(socket.destroyed, true);
});
