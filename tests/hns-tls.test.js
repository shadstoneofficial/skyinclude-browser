const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { inspectHnsHttpsCertificate } = require('../hns-tls');

function createSocket(certificate = { raw: Buffer.from('not-a-real-cert') }) {
    const socket = new EventEmitter();
    socket.getPeerCertificate = () => certificate;
    socket.setTimeout = () => {};
    socket.end = () => {};
    socket.destroy = error => socket.emit('error', error);
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
