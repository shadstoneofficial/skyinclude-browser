const assert = require('node:assert/strict');
const test = require('node:test');
const { HNSResolver } = require('../resolver');

const primary = { id: 'primary', name: 'Primary', transport: 'doh-wire', url: 'https://primary.invalid/dns-query' };
const secondary = { id: 'secondary', name: 'Secondary', transport: 'dns-json', url: 'https://secondary.invalid/' };
const tlsa = { usage: 3, selector: 1, matchingType: 1, certificateAssociationData: 'ab'.repeat(32) };

function configured(resolvers = [primary, secondary], customResolver = '') {
    return new HNSResolver({
        getSetting(key) {
            if (key === 'hnsResolvers') return resolvers;
            if (key === 'hnsCustomResolver') return customResolver;
            return null;
        }
    });
}

function answer(records = [], authenticated = true, rcode = 0) {
    return { records, authenticated, rcode, rcodeName: rcode === 3 ? 'NXDOMAIN' : 'NOERROR' };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('website provenance identifies its provider and fallback, and cache hits do not mutate live results', async () => {
    const resolver = configured();
    resolver.queryResolver = async (candidate, name, type) => {
        if (candidate.id === 'primary') throw Object.assign(new Error('timeout'), { code: 'REQUEST_TIMEOUT' });
        return answer(type === 'A' ? ['168.144.102.205'] : []);
    };
    const live = await resolver.resolveHNSDomain('handshake.mercenary');
    const cached = await resolver.resolveHNSDomain('handshake.mercenary');
    assert.equal(live.resolver.id, 'secondary');
    assert.equal(live.resolver.transport, 'dns-json');
    assert.equal(live.resolverFallbackCount, 1);
    assert.equal(live.queryName, 'handshake.mercenary');
    assert.deepEqual(live.recordTypes, ['A', 'AAAA', 'CNAME']);
    assert.deepEqual(live.resolverAttempts.map(attempt => attempt.status), ['REQUEST_TIMEOUT', 'NOERROR']);
    assert.equal(live.resolverResolutionState, 'resolved');
    assert.equal(live.cacheHit, false);
    assert.equal(cached.cacheHit, true);
    assert.notEqual(cached, live);
    assert.deepEqual(cached.resolverAttempts, live.resolverAttempts);
    cached.resolverAttempts[0].status = 'changed in caller';
    assert.equal(live.resolverAttempts[0].status, 'REQUEST_TIMEOUT');
});

test('concurrent websites retain the resolver used for each exact request', async () => {
    const resolver = configured();
    const first = deferred();
    resolver.queryResolver = async (candidate, name, type) => {
        if (candidate.id === 'primary' && name === 'first.hns') {
            await first.promise;
            throw new Error('first request unavailable');
        }
        return answer(type === 'A' ? [name === 'first.hns' ? '203.0.113.1' : '203.0.113.2'] : []);
    };
    const firstResult = resolver.resolveHNSDomain('first.hns');
    const secondResult = await resolver.resolveHNSDomain('second.hns');
    first.resolve();
    const resolvedFirst = await firstResult;
    assert.equal(secondResult.resolver.id, 'primary');
    assert.equal(secondResult.queryName, 'second.hns');
    assert.equal(resolvedFirst.resolver.id, 'secondary');
    assert.equal(resolvedFirst.queryName, 'first.hns');
    assert.equal((await resolver.resolveHNSDomain('second.hns')).resolver.id, 'primary');
});

test('website outage and cooldown report their own attempts without claiming an active provider', async () => {
    const resolver = configured([primary]);
    resolver.queryResolver = async () => { throw new Error('offline'); };
    const failed = await resolver.resolveHNSDomain('first.hns');
    const cooling = await resolver.resolveHNSDomain('second.hns');
    for (const result of [failed, cooling]) {
        assert.equal(result.resolver, null);
        assert.equal(result.cacheHit, false);
        assert.equal(result.authenticated, false);
        assert.equal(result.resolverResolutionState, 'temporary-failure');
        assert.equal(result.resolverAttempts.length, 1);
    }
    assert.equal(failed.queryName, 'first.hns');
    assert.equal(cooling.queryName, 'second.hns');
    assert.equal(cooling.resolverAttempts[0].status, 'COOLDOWN');
    assert.equal(failed.resolverAttempts[0].status, 'ERROR');
});

test('Headless identity fallback preserves the DNS provider which proved website absence', async () => {
    const resolver = configured([secondary]);
    resolver.queryResolver = async () => answer([]);
    resolver.fetchHeadlessMetadata = async () => ({
        manifests: { agent_json: 'https://headlessdomains.com/manifests/identity.agent.json' }
    });
    const identity = await resolver.resolveHNSDomain('identity.agent');
    assert.equal(identity.source, 'headlessdomains');
    assert.equal(identity.resolutionState, 'authoritative-absence');
    assert.equal(identity.resolverResolutionState, 'authoritative-absence');
    assert.equal(identity.resolver.id, 'secondary');
    assert.equal(identity.queryName, 'identity.agent');
    assert.equal(identity.resolverAttempts[0].status, 'NOERROR');
    assert.equal((await resolver.resolveHNSDomain('identity.agent')).cacheHit, true);
});

test('website cache provenance clones still receive deferred optional TXT profile enrichment', async () => {
    const resolver = configured([primary]);
    const txt = deferred();
    resolver.queryResolver = async (candidate, name, type) => {
        if (type === 'TXT') { await txt.promise; return answer(['x:skyinclude']); }
        return answer(type === 'A' ? ['203.0.113.8'] : []);
    };
    const live = await resolver.resolveHNSDomain('profile.hns');
    const cached = await resolver.resolveHNSDomain('profile.hns');
    assert.equal(cached.hnsProfile, null);
    txt.resolve();
    const profile = await cached.profilePromise;
    assert.deepEqual(cached.hnsProfile, profile);
    assert.deepEqual(live.hnsProfile, profile);
    assert.equal(live.cacheHit, false);
    assert.equal(cached.cacheHit, true);
    assert.equal(Object.keys(cached).includes('profilePromise'), false);
});

test('TLSA array and metadata consumers share one request while keeping their return contracts', async () => {
    const resolver = configured([primary]);
    const gate = deferred();
    let calls = 0;
    resolver.queryResolver = async () => { calls += 1; await gate.promise; return answer([tlsa]); };
    const array = resolver.resolveTLSARecords('handshake.mercenary');
    const metadata = resolver.resolveTLSARecords('handshake.mercenary', { includeMetadata: true });
    gate.resolve();
    const records = await array;
    const live = await metadata;
    const cached = await resolver.resolveTLSARecords('handshake.mercenary', { includeMetadata: true });
    assert.deepEqual(records, [tlsa]);
    assert.equal(Array.isArray(records), true);
    assert.equal(live.records, records);
    assert.equal(live.queryName, '_443._tcp.handshake.mercenary');
    assert.deepEqual(live.recordTypes, ['TLSA']);
    assert.equal(live.resolver.id, 'primary');
    assert.equal(live.authenticated, true);
    assert.equal(live.cacheHit, false);
    assert.equal(cached.cacheHit, true);
    assert.deepEqual(cached.resolverAttempts, live.resolverAttempts);
    assert.equal(calls, 1);
});

test('TLSA provenance and cached data remain separate for hosts and HTTPS ports', async () => {
    const resolver = configured([primary]);
    resolver.queryResolver = async (candidate, name) => answer([{
        ...tlsa, certificateAssociationData: name.includes('8443') ? 'cd'.repeat(32) : tlsa.certificateAssociationData
    }]);
    const [first, alternatePort, otherHost] = await Promise.all([
        resolver.resolveTLSARecords('first.hns', { includeMetadata: true }),
        resolver.resolveTLSARecords('first.hns', { port: 8443, includeMetadata: true }),
        resolver.resolveTLSARecords('other.hns', { includeMetadata: true })
    ]);
    assert.equal(first.queryName, '_443._tcp.first.hns');
    assert.equal(alternatePort.queryName, '_8443._tcp.first.hns');
    assert.equal(otherHost.queryName, '_443._tcp.other.hns');
    assert.notDeepEqual(first.records, alternatePort.records);
    assert.equal((await resolver.resolveTLSARecords('first.hns', { includeMetadata: true })).queryName, first.queryName);
});

test('unauthenticated Web3DNS TLSA is a failed attempt, never authenticated metadata or cache', async () => {
    const web3dns = { id: 'web3dns', transport: 'doh-wire', url: 'https://doh.web3dns.net/' };
    const resolver = configured([web3dns]);
    resolver.queryResolver = async () => answer([tlsa], false);
    await assert.rejects(resolver.resolveTLSARecords('handshake.mercenary', { includeMetadata: true }), error => {
        assert.equal(error.resolver, null);
        assert.equal(error.authenticated, false);
        assert.equal(error.cacheHit, false);
        assert.equal(error.queryName, '_443._tcp.handshake.mercenary');
        assert.equal(error.resolverAttempts[0].resolver.id, 'web3dns');
        assert.equal(error.resolverAttempts[0].status, 'DNSSEC_UNAUTHENTICATED');
        return true;
    });
    assert.equal(resolver.tlsaCache.size, 0);
    assert.equal((await resolver.verifyDANE('handshake.mercenary', null, { force: true })).state, 'resolver_failure');
});

test('authenticated TLSA absence retains its actual provider on live and cached responses', async () => {
    const resolver = configured([primary]);
    resolver.queryResolver = async () => answer([], true, 3);
    const live = await resolver.resolveTLSARecords('missing.hns', { includeMetadata: true });
    const cached = await resolver.resolveTLSARecords('missing.hns', { includeMetadata: true });
    assert.deepEqual(live.records, []);
    assert.equal(live.resolutionState, 'authoritative-absence');
    assert.equal(live.rcodeName, 'NXDOMAIN');
    assert.equal(live.authenticated, true);
    assert.equal(live.resolver.id, 'primary');
    assert.equal(live.cacheHit, false);
    assert.equal(cached.cacheHit, true);
    assert.equal(cached.resolver.id, 'primary');
});

test('forced TLSA failure cannot display provenance from a previously cached success', async () => {
    const resolver = configured([primary]);
    resolver.queryResolver = async () => answer([tlsa]);
    const live = await resolver.resolveTLSARecords('first.hns', { includeMetadata: true });
    resolver.queryResolver = async () => { throw new Error('provider offline'); };
    await assert.rejects(resolver.resolveTLSARecords('first.hns', { force: true, includeMetadata: true }), error => {
        assert.equal(error.resolver, null);
        assert.equal(error.authenticated, false);
        assert.equal(error.resolverResolutionState, 'temporary-failure');
        assert.equal(error.resolverAttempts[0].status, 'ERROR');
        return true;
    });
    assert.equal(live.resolver.id, 'primary');
    assert.equal(live.authenticated, true);
    assert.equal(resolver.tlsaCache.size, 0);
});

test('late superseded TLSA request cannot return stale metadata after a forced absence result', async () => {
    const resolver = configured([primary]);
    const oldGate = deferred();
    let calls = 0;
    resolver.queryResolver = async () => {
        calls += 1;
        if (calls === 1) { await oldGate.promise; return answer([tlsa]); }
        return answer([]);
    };
    const old = resolver.resolveTLSARecords('first.hns', { includeMetadata: true });
    const oldRejected = assert.rejects(old, { name: 'AbortError' });
    const refreshed = await resolver.resolveTLSARecords('first.hns', { force: true, includeMetadata: true });
    assert.equal(refreshed.resolutionState, 'authoritative-absence');
    assert.equal(refreshed.cacheHit, false);
    oldGate.resolve();
    await oldRejected;
    const cached = await resolver.resolveTLSARecords('first.hns', { includeMetadata: true });
    assert.equal(cached.resolutionState, 'authoritative-absence');
    assert.equal(cached.cacheHit, true);
    assert.deepEqual(cached.records, []);
});

test('canceling a metadata TLSA consumer does not change a shared array consumer contract', async () => {
    const resolver = configured([primary]);
    const controller = new AbortController();
    const gate = deferred();
    resolver.queryResolver = async () => { await gate.promise; return answer([tlsa]); };
    const metadata = resolver.resolveTLSARecords('first.hns', { includeMetadata: true, signal: controller.signal });
    const records = resolver.resolveTLSARecords('first.hns');
    controller.abort();
    await assert.rejects(metadata, { name: 'AbortError' });
    gate.resolve();
    assert.deepEqual(await records, [tlsa]);
});

test('public provenance and diagnostics redact endpoint secrets while requests retain required query parameters', async () => {
    const secretResolver = { ...primary, url: 'https://primary.invalid/dns-query?key=PrivateToken#PrivateFragment' };
    const resolver = configured([secretResolver]);
    resolver.queryResolver = async candidate => {
        assert.equal(new URL(candidate.url).searchParams.get('key'), 'PrivateToken');
        throw new Error(`fetch ${candidate.url} failed, echoed PrivateToken`);
    };
    const failed = await resolver.resolveHNSDomain('first.hns');
    const published = JSON.stringify({ failed, diagnostics: resolver.getResolverDiagnostics() });
    assert.equal(published.includes('PrivateToken'), false);
    assert.equal(published.includes('PrivateFragment'), false);
    assert.equal(failed.resolverAttempts[0].resolver.url, 'https://primary.invalid/dns-query');
    assert.equal(resolver.getPublicResolverInfo({ ...primary, url: 'https://user:password@primary.invalid/dns-query?key=secret#fragment' }).url,
        'https://primary.invalid/dns-query');
});

test('optional TXT failure after website absence redacts echoed tokens and retains TXT provider provenance', async () => {
    const resolver = configured([{ ...primary, url: 'https://primary.invalid/dns-query?key=PrivateToken' }]);
    resolver.queryResolver = async (candidate, name, type) => {
        if (type === 'TXT') throw new Error('provider echoed PrivateToken');
        return answer([]);
    };
    const failure = await resolver.resolveHNSDomain('no-web.hns');
    assert.equal(failure.resolutionState, 'temporary-failure');
    assert.equal(JSON.stringify(failure).includes('PrivateToken'), false);
    assert.match(failure.error.message, /\[redacted\]/);
    assert.equal(failure.queryName, 'no-web.hns');
    assert.deepEqual(failure.recordTypes, ['TXT']);
    assert.equal(failure.resolverAttempts[0].resolver.id, 'primary');
    assert.equal(failure.resolverAttempts[0].resolver.url, 'https://primary.invalid/dns-query');
    assert.equal(failure.resolverAttempts[0].status, 'ERROR');
    assert.equal(resolver.resolverHealth.size, 0, 'optional TXT failure must not poison website health');
});

test('empty configured resolver list reports an honest outage without adding an unconfigured provider', async () => {
    const resolver = configured([]);
    resolver.queryResolver = async () => assert.fail('must not append a provider after retirement');
    const result = await resolver.resolveHNSDomain('first.hns');
    assert.equal(result.error.code, 'NO_HNS_RESOLVERS');
    assert.equal(result.resolver, null);
    assert.deepEqual(result.resolverAttempts, []);
    assert.equal(result.resolverResolutionState, 'temporary-failure');
    const customOnly = configured([], primary.url);
    assert.deepEqual(customOnly.getResolverSettings().resolvers.map(candidate => candidate.url), [primary.url]);
});
