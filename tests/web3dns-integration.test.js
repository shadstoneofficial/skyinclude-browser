const assert = require('node:assert/strict');
const test = require('node:test');
const { HNSResolver } = require('../resolver');

// Exercise the real descriptor -> wire-query -> DNS-parser path without
// depending on a public provider's availability or claiming live AD support.
function wireResponse(query, authenticated, data = null) {
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(authenticated ? 0x81a0 : 0x8180, 2);
    header.writeUInt16BE(data ? 1 : 0, 6);
    header.writeUInt16BE(0, 10);
    const question = query.subarray(12, query.length - 11);
    if (!data) return Buffer.concat([header, question]);
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(question.readUInt16BE(question.length - 4), 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(20, 6);
    record.writeUInt16BE(data.length, 10);
    return Buffer.concat([header, question, record, data]);
}

function requestQuery(input, headers) {
    const url = new URL(input);
    assert.equal(url.origin, 'https://doh.web3dns.net');
    assert.equal(url.pathname, '/', 'documented root path must survive both normalization layers');
    assert.equal(headers.Accept, 'application/dns-message');
    const query = Buffer.from(url.searchParams.get('dns'), 'base64url');
    assert.equal(query.readUInt16BE(2), 0x0120, 'RD/AD requested with CD clear');
    assert.equal(query.subarray(-11).toString('hex'), '00002904d0000080000000');
    return query;
}

test('default website fallback reaches Web3DNS binary root and reports the actual provider', async () => {
    const resolver = new HNSResolver();
    const calledHosts = [];
    resolver.fetchBuffer = async (input, timeout, headers) => {
        const url = new URL(input);
        calledHosts.push(url.hostname);
        if (url.hostname === 'hnsdoh.com') throw Object.assign(new Error('temporary 503'), { code: 'HTTP_503' });
        const query = requestQuery(input, headers);
        const type = query.readUInt16BE(query.length - 15);
        return wireResponse(query, false, type === 1 ? Buffer.from([168, 144, 102, 205]) : null);
    };
    const result = await resolver.resolveHNSDomain('handshake.mercenary');
    assert.equal(result.address, '168.144.102.205');
    assert.equal(result.resolver.id, 'web3dns');
    assert.equal(result.resolver.transport, 'doh-wire');
    assert.equal(result.resolver.url, 'https://doh.web3dns.net/');
    assert.equal(result.authenticated, false);
    assert.equal(result.resolverFallbackCount, 1);
    assert.ok(calledHosts.includes('hnsdoh.com'));
    assert.ok(calledHosts.includes('doh.web3dns.net'));
    assert.ok(!calledHosts.includes('resolve.shakestation.io'));
});

test('Web3DNS wire TLSA integration rejects AD=false and can recover with authenticated data', async () => {
    const resolver = new HNSResolver({ getSetting(key) {
        return key === 'hnsResolvers' ? ['https://doh.web3dns.net/'] : null;
    } });
    const data = Buffer.from(`030101${'ab'.repeat(32)}`, 'hex');
    let authenticated = false;
    resolver.fetchBuffer = async (input, timeout, headers) => {
        const query = requestQuery(input, headers);
        assert.equal(query.readUInt16BE(query.length - 15), 52);
        assert.ok(query.includes(Buffer.from('_443')));
        assert.ok(query.includes(Buffer.from('_tcp')));
        return wireResponse(query, authenticated, data);
    };
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary', { includeMetadata: true }), error =>
        error.resolverAttempts[0].status === 'DNSSEC_UNAUTHENTICATED');
    assert.equal(resolver.tlsaCache.size, 0);
    authenticated = true;
    const result = await resolver.resolveTLSARecords('handshake.mercenary', { force: true, includeMetadata: true });
    assert.equal(result.authenticated, true);
    assert.equal(result.resolver.url, 'https://doh.web3dns.net/');
    assert.equal(result.records[0].certificateAssociationData, 'ab'.repeat(32));
});
