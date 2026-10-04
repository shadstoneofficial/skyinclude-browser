const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { HNSResolver } = require('../resolver');

const primary = { id: 'primary', transport: 'doh-wire', url: 'https://primary.invalid/dns-query' };
const secondary = { id: 'secondary', transport: 'dns-json', url: 'https://secondary.invalid/' };
const record = { usage: 3, selector: 1, matchingType: 1, certificateAssociationData: 'ab'.repeat(32) };

function resolverWith(candidates = [primary, secondary]) {
    return new HNSResolver({
        getSetting(key) {
            if (key === 'hnsResolvers') return candidates;
            if (key === 'hnsDANE') return true;
            return null;
        }
    });
}

function answer(records = [record], authenticated = true, rcode = 0) {
    return { records, authenticated, rcode, rcodeName: rcode === 3 ? 'NXDOMAIN' : 'NOERROR' };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function wireAnswer(query, flags = 0x81a0, records = [record]) {
    const header = Buffer.from(query.subarray(0, 12));
    header.writeUInt16BE(flags, 2);
    header.writeUInt16BE(records.length, 6);
    header.writeUInt16BE(0, 10);
    // The query has one question followed by one 11-byte EDNS OPT record.
    const question = query.subarray(12, query.length - 11);
    const answers = records.map(value => {
        const metadata = Buffer.alloc(12);
        metadata.writeUInt16BE(0xc00c, 0);
        metadata.writeUInt16BE(52, 2);
        metadata.writeUInt16BE(1, 4);
        metadata.writeUInt32BE(20, 6);
        metadata.writeUInt16BE(35, 10);
        return Buffer.concat([metadata, Buffer.from(`030101${value.certificateAssociationData}`, 'hex')]);
    });
    return Buffer.concat([header, question, ...answers]);
}

test('wire TLSA request advertises AD and EDNS DO without disabling DNSSEC validation', async () => {
    const resolver = resolverWith([primary]);
    let requests = 0;
    resolver.fetchBuffer = async input => {
        const query = Buffer.from(new URL(input).searchParams.get('dns'), 'base64url');
        requests += 1;
        assert.equal(query.readUInt16BE(2), 0x0120, 'RD and AD set, CD clear');
        assert.equal(query.readUInt16BE(10), 1, 'one EDNS additional record');
        assert.equal(query.subarray(-11).toString('hex'), '00002904d0000080000000', 'EDNS DO set');
        return wireAnswer(query);
    };
    assert.deepEqual(await resolver.resolveTLSARecords('handshake.mercenary'), [record]);
    assert.equal(requests, 1);
    assert.equal([...resolver.tlsaCache.values()][0].authenticated, true);
});

test('wire and JSON parsers preserve strict AD/CD validation status for answers and absence', () => {
    const resolver = resolverWith();
    const name = '_443._tcp.handshake.mercenary';
    const query = resolver.buildDnsQuery(name, 52);
    for (const [flags, authenticated] of [[0x81a0, true], [0x8180, false], [0x81b0, false], [0x81a3, true]]) {
        const parsed = resolver.parseDnsResponseMessage(wireAnswer(query, flags, []), 'TLSA');
        assert.equal(parsed.authenticated, authenticated);
    }
    for (const [AD, CD, authenticated] of [[true, false, true], [false, false, false], ['true', false, false], [true, true, false]]) {
        const parsed = resolver.parseDnsJsonResponse({
            Status: 0, AD, CD, Question: [{ name, type: 52 }], Answer: []
        }, name, 'TLSA');
        assert.equal(parsed.authenticated, authenticated);
    }
});

test('DNS JSON TLSA request asks for DNSSEC and never disables validation', async () => {
    const resolver = resolverWith([secondary]);
    resolver.fetchJson = async input => {
        const params = new URL(input).searchParams;
        assert.equal(params.get('do'), 'true');
        assert.equal(params.get('cd'), 'false');
        return {
            Status: 0, AD: true, Question: [{ name: params.get('name'), type: 52 }],
            Answer: [{ name: params.get('name'), type: 52, data: `3 1 1 ${record.certificateAssociationData}` }]
        };
    };
    assert.deepEqual(await resolver.resolveTLSARecords('handshake.mercenary'), [record]);
});

test('TLSA failover preserves custom resolver order and rejects unvalidated records', async () => {
    const resolver = resolverWith();
    const calls = [];
    resolver.queryResolver = async candidate => {
        calls.push(candidate.id);
        return answer([record], candidate.id === 'secondary');
    };
    assert.deepEqual(await resolver.resolveTLSARecords('handshake.mercenary'), [record]);
    assert.deepEqual(calls, ['primary', 'secondary']);
    assert.equal(resolver.getResolverDiagnostics()[0].status, 'DNSSEC_UNAUTHENTICATED');
    assert.equal([...resolver.tlsaCache.values()][0].resolver.id, 'secondary');
});

for (const [label, records, rcode] of [['positive', [record], 0], ['NODATA', [], 0], ['NXDOMAIN', [], 3]]) {
    test(`unauthenticated ${label} TLSA results are failures, not cached answers`, async () => {
        const resolver = resolverWith([primary]);
        resolver.queryResolver = async () => answer(records, false, rcode);
        await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary'), error => (
            error.code === 'RESOLVER_FAILURE' && error.attempts[0].status === 'DNSSEC_UNAUTHENTICATED'
        ));
        assert.equal(resolver.tlsaCache.size, 0);
        resolver.queryResolver = async () => answer(records, true, rcode);
        assert.deepEqual(await resolver.resolveTLSARecords('handshake.mercenary', { force: true }), records);
    });
}

test('TLSA cannot trust an AD claim over an unencrypted custom resolver', async () => {
    const resolver = resolverWith([{ ...primary, url: 'http://local-resolver.invalid/dns-query' }]);
    let calls = 0;
    resolver.queryResolver = async () => { calls += 1; return answer(); };
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary'), error => (
        error.attempts.length === 1 && error.attempts[0].status === 'INSECURE_TLSA_TRANSPORT'
    ));
    assert.equal(calls, 0, 'must not query or append an unconfigured provider');
});

test('transient TLSA outage is non-cacheable and explicit retry can recover during cooldown', async () => {
    const resolver = resolverWith([primary]);
    let calls = 0;
    resolver.queryResolver = async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
        return answer();
    };
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary'), { code: 'RESOLVER_FAILURE' });
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary'), { code: 'RESOLVER_COOLDOWN' });
    assert.equal(resolver.tlsaCache.size, 0);
    assert.equal(calls, 1);
    assert.deepEqual(await resolver.resolveTLSARecords('handshake.mercenary', { force: true }), [record]);
    assert.deepEqual(await resolver.resolveTLSARecords('handshake.mercenary'), [record]);
    assert.equal(calls, 2);
});

test('TLSA capability failures cannot cool down working native website records', async () => {
    const resolver = resolverWith([primary]);
    resolver.queryResolver = async (candidate, domain, type) => {
        if (type === 'TLSA') throw new Error('HTTP 400: service names not supported');
        return answer(type === 'A' ? ['168.144.102.205'] : [], false);
    };
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary'));
    const website = await resolver.resolveHNSDomain('handshake.mercenary');
    assert.equal(website.address, '168.144.102.205');
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary'), { code: 'RESOLVER_COOLDOWN' });
});

test('website failure and recovery do not suppress or reset independent TLSA health', async () => {
    const resolver = resolverWith([primary]);
    resolver.markResolverFailure(primary, new Error('A lookup timeout'), 10);
    resolver.queryResolver = async () => answer();
    assert.deepEqual(await resolver.resolveTLSARecords('handshake.mercenary'), [record]);
    assert.equal(resolver.getResolverCandidates().length, 0, 'TLSA success does not clear website cooldown');
});

test('authenticated negative TLSA response is a cached absence, not a resolver outage', async () => {
    const resolver = resolverWith([primary]);
    let calls = 0;
    resolver.queryResolver = async () => { calls += 1; return answer([], true); };
    assert.equal((await resolver.verifyDANE('handshake.mercenary', null)).state, 'no_tlsa');
    assert.equal((await resolver.verifyDANE('handshake.mercenary', null)).state, 'no_tlsa');
    assert.equal(calls, 1);
});

test('TLSA service names and cached records are scoped to the actual HTTPS port', async () => {
    const resolver = resolverWith([primary]);
    const names = [];
    resolver.queryResolver = async (candidate, name) => { names.push(name); return answer(); };
    await resolver.resolveTLSARecords('handshake.mercenary');
    await resolver.resolveTLSARecords('handshake.mercenary', { port: 8443 });
    await resolver.resolveTLSARecords('handshake.mercenary', { port: 443 });
    assert.deepEqual(names, ['_443._tcp.handshake.mercenary', '_8443._tcp.handshake.mercenary']);
    assert.equal(resolver.tlsaCache.size, 2);
    for (const port of [0, -1, 65536, 'invalid', 12.5]) assert.throws(() => resolver.buildTlsaName('example.hns', port));
});

test('DANE matching uses authenticated TLSA for the requested HTTPS port', async () => {
    const resolver = resolverWith([primary]);
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    const certificateAssociationData = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
    resolver.queryResolver = async (candidate, name) => {
        assert.equal(name, '_8443._tcp.handshake.mercenary');
        return answer([{ ...record, certificateAssociationData }]);
    };
    const result = await resolver.verifyDANE('handshake.mercenary', { publicKeyDer }, { port: 8443 });
    assert.equal(result.state, 'verified');
    assert.equal(result.tlsaName, '_8443._tcp.handshake.mercenary');
});

test('cancelled TLSA consumers cannot receive a cached trust result', async () => {
    const resolver = resolverWith([primary]);
    resolver.queryResolver = async () => answer();
    await resolver.resolveTLSARecords('handshake.mercenary');
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary', {
        signal: AbortSignal.abort()
    }), { name: 'AbortError' });
});

test('failed forced TLSA refresh immediately revokes only the exact cached service', async () => {
    const resolver = resolverWith([primary]);
    resolver.queryResolver = async () => answer();
    await resolver.resolveTLSARecords('handshake.mercenary');
    await resolver.resolveTLSARecords('handshake.mercenary', { port: 8443 });
    const failure = deferred();
    resolver.queryResolver = async () => { await failure.promise; throw new Error('resolver offline'); };
    const refresh = resolver.resolveTLSARecords('handshake.mercenary', { force: true, port: 8443 });
    assert.equal(resolver.tlsaCache.size, 1, 'revoked before the failing request settles');
    assert.deepEqual(await resolver.resolveTLSARecords('handshake.mercenary'), [record]);
    failure.resolve();
    await assert.rejects(refresh, { code: 'RESOLVER_FAILURE' });
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary', { port: 8443 }), {
        code: 'RESOLVER_COOLDOWN'
    });
    assert.equal(resolver.tlsaCache.size, 1, 'failed refresh cannot restore the old record');
});

for (const [label, refreshedRecords] of [
    ['authenticated absence', []],
    ['rotated certificate', [{ ...record, certificateAssociationData: 'cd'.repeat(32) }]]
]) {
    test(`forced TLSA ${label} supersedes an older pending answer and ordinary callers join it`, async () => {
        const resolver = resolverWith([primary]);
        const oldGate = deferred();
        const refreshGate = deferred();
        let calls = 0;
        resolver.queryResolver = async () => {
            calls += 1;
            if (calls === 1) {
                await oldGate.promise; // Deliberately ignore transport cancellation.
                return answer();
            }
            await refreshGate.promise;
            return answer(refreshedRecords);
        };
        const obsolete = resolver.resolveTLSARecords('handshake.mercenary');
        const obsoleteRejected = assert.rejects(obsolete, { name: 'AbortError' });
        const refresh = resolver.resolveTLSARecords('handshake.mercenary', { force: true });
        const ordinary = resolver.resolveTLSARecords('handshake.mercenary');
        assert.equal(calls, 2, 'ordinary caller must join the forced refresh');
        refreshGate.resolve();
        assert.deepEqual(await refresh, refreshedRecords);
        assert.deepEqual(await ordinary, refreshedRecords);
        oldGate.resolve();
        await obsoleteRejected;
        assert.deepEqual(await resolver.resolveTLSARecords('handshake.mercenary'), refreshedRecords);
        assert.equal(calls, 2);
        assert.equal(resolver.pendingTLSAResolutions.size, 0);
    });
}

test('failed forced refresh cannot be repopulated by an older TLSA request completing later', async () => {
    const resolver = resolverWith([primary]);
    const oldGate = deferred();
    let calls = 0;
    resolver.queryResolver = async () => {
        calls += 1;
        if (calls === 1) { await oldGate.promise; return answer(); }
        throw new Error('resolver offline');
    };
    const obsolete = resolver.resolveTLSARecords('handshake.mercenary');
    const obsoleteRejected = assert.rejects(obsolete, { name: 'AbortError' });
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary', { force: true }), {
        code: 'RESOLVER_FAILURE'
    });
    oldGate.resolve();
    await obsoleteRejected;
    assert.equal(resolver.tlsaCache.size, 0);
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary'), { code: 'RESOLVER_COOLDOWN' });
});

test('canceling one shared TLSA consumer preserves the other consumer and its result', async () => {
    const resolver = resolverWith([primary]);
    const gate = deferred();
    const controller = new AbortController();
    let calls = 0;
    resolver.queryResolver = async () => { calls += 1; await gate.promise; return answer(); };
    const canceled = resolver.resolveTLSARecords('handshake.mercenary', { signal: controller.signal });
    const remaining = resolver.resolveTLSARecords('handshake.mercenary');
    controller.abort();
    await assert.rejects(canceled, { name: 'AbortError' });
    gate.resolve();
    assert.deepEqual(await remaining, [record]);
    assert.equal(calls, 1);
    assert.equal(resolver.pendingTLSAResolutions.size, 0);
});
