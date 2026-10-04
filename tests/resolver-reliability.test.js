const assert = require('node:assert/strict');
const test = require('node:test');
const { HNSResolver } = require('../resolver');

function settings(resolvers, timeout = 1000) {
    return {
        getSetting(key) {
            if (key === 'hnsResolvers') return resolvers;
            if (key === 'hnsTimeout') return timeout;
            return null;
        }
    };
}

function response(records = [], rcode = 0) {
    return {
        records,
        rcode,
        rcodeName: rcode === 3 ? 'NXDOMAIN' : 'NOERROR'
    };
}

const primary = { id: 'primary', name: 'Primary', transport: 'doh-wire', url: 'https://primary.invalid/dns-query' };
const secondary = { id: 'secondary', name: 'Secondary', transport: 'dns-json', url: 'https://secondary.invalid/' };

test('uses HNS DoH, Web3DNS, then Shakestation and puts a custom resolver first', () => {
    const defaultResolver = new HNSResolver();
    assert.deepEqual(
        defaultResolver.getResolverSettings().resolvers.map(resolver => resolver.id),
        ['hnsdoh', 'web3dns', 'shakestation']
    );

    const configured = new HNSResolver({
        getSetting(key) {
            if (key === 'hnsCustomResolver') return 'dns-json https://api.web3dns.net/';
            if (key === 'hnsResolvers') return [primary];
            return null;
        }
    });
    assert.deepEqual(configured.getResolverCandidates().map(resolver => resolver.id), ['web3dns', 'primary']);
});

test('parses and validates Web3DNS-style JSON records', () => {
    const resolver = new HNSResolver();
    const a = resolver.parseDnsJsonResponse({
        Status: 0,
        Question: [{ name: 'example.hns.', type: 1 }],
        Answer: [{ name: 'example.hns.', type: 1, data: '203.0.113.8' }]
    }, 'example.hns', 'A');
    assert.deepEqual(a.records, ['203.0.113.8']);

    const aaaa = resolver.parseDnsJsonResponse({
        Status: 0,
        Question: [{ name: 'example.hns.', type: 28 }],
        Answer: [{ name: 'example.hns.', type: 28, data: '2001:db8::8' }]
    }, 'example.hns', 'AAAA');
    assert.deepEqual(aaaa.records, ['2001:db8::8']);

    const cname = resolver.parseDnsJsonResponse({
        Status: 0,
        Question: [{ name: 'alias.hns.', type: 5 }],
        Answer: [{ name: 'alias.hns.', type: 5, data: 'target.example.' }]
    }, 'alias.hns', 'CNAME');
    assert.deepEqual(cname.records, ['target.example']);

    const base = {
        Status: 0,
        Question: [{ name: 'example.hns.', type: 16 }]
    };

    const txt = resolver.parseDnsJsonResponse({
        ...base,
        Answer: [{ name: 'example.hns.', type: 16, data: '"first " "second"' }]
    }, 'example.hns', 'TXT');
    assert.deepEqual(txt.records, ['first second']);

    const tlsa = resolver.parseDnsJsonResponse({
        Status: 0,
        Question: [{ name: '_443._tcp.example.hns.', type: 52 }],
        Answer: [{
            name: '_443._tcp.example.hns.',
            type: 52,
            data: `3 1 1 ${'ab'.repeat(32)}`
        }]
    }, '_443._tcp.example.hns', 'TLSA');
    assert.equal(tlsa.records[0].certificateAssociationData, 'ab'.repeat(32));
});

test('rejects mismatched questions and malformed expected records', () => {
    const resolver = new HNSResolver();
    assert.throws(() => resolver.parseDnsJsonResponse({
        Status: 0,
        Question: [{ name: 'other.hns.', type: 1 }],
        Answer: []
    }, 'example.hns', 'A'), /Question does not match/);

    assert.throws(() => resolver.parseDnsJsonResponse({
        Status: 0,
        Question: [{ name: 'example.hns.', type: 1 }],
        Answer: [{ name: 'example.hns.', type: 1, data: '999.1.1.1' }]
    }, 'example.hns', 'A'), /Malformed A record/);
});

test('distinguishes SERVFAIL, NXDOMAIN, and NOERROR NODATA', () => {
    const resolver = new HNSResolver();
    assert.throws(() => resolver.parseDnsJsonResponse({
        Status: 2,
        Question: [{ name: 'example.hns.', type: 1 }]
    }, 'example.hns', 'A'), error => error.rcodeName === 'SERVFAIL');

    assert.deepEqual(resolver.parseDnsJsonResponse({
        Status: 3,
        Question: [{ name: 'missing.hns.', type: 1 }]
    }, 'missing.hns', 'A'), {
        records: [],
        rcode: 3,
        rcodeName: 'NXDOMAIN',
        authenticated: false
    });

    assert.deepEqual(resolver.parseDnsJsonResponse({
        Status: 0,
        Question: [{ name: 'empty.hns.', type: 1 }]
    }, 'empty.hns', 'A'), {
        records: [],
        rcode: 0,
        rcodeName: 'NOERROR',
        authenticated: false
    });
});

test('wire-format parser validates DNS status and the echoed question', () => {
    const resolver = new HNSResolver();
    const query = resolver.buildDnsQuery('example.hns', 1);
    const servfail = Buffer.from(query);
    servfail.writeUInt16BE(0x8182, 2);

    assert.throws(() => resolver.parseDnsResponseMessage(servfail, 'A', {
        id: query.readUInt16BE(0),
        domain: 'example.hns',
        qtype: 1
    }), error => error.rcodeName === 'SERVFAIL');

    const nxdomain = Buffer.from(query);
    nxdomain.writeUInt16BE(0x8183, 2);
    assert.equal(resolver.parseDnsResponseMessage(nxdomain, 'A', {
        id: query.readUInt16BE(0),
        domain: 'example.hns',
        qtype: 1
    }).rcodeName, 'NXDOMAIN');

    const success = Buffer.from(query);
    success.writeUInt16BE(0x8180, 2);
    assert.throws(() => resolver.parseDnsResponseMessage(success, 'A', {
        id: query.readUInt16BE(0),
        domain: 'other.hns',
        qtype: 1
    }), /Question does not match/);
});

test('uses one endpoint record set and falls back after a resolver failure', async () => {
    const resolver = new HNSResolver(settings([primary, secondary]));
    const calls = [];
    resolver.queryResolver = async (candidate, domain, type) => {
        calls.push(`${candidate.id}:${type}`);
        if (candidate.id === 'primary') {
            const error = new Error('HTTP 502');
            error.code = 'HTTP_502';
            throw error;
        }
        return response(type === 'A' ? ['203.0.113.10'] : [`${type.toLowerCase()}-secondary`]);
    };

    const result = await resolver.queryRecordSet('example.hns', ['A', 'TXT']);

    assert.equal(result.resolver.id, 'secondary');
    assert.equal(result.fallbackCount, 1);
    assert.deepEqual(result.records, {
        A: ['203.0.113.10'],
        TXT: ['txt-secondary']
    });
    assert.deepEqual(calls, ['primary:A', 'primary:TXT', 'secondary:A', 'secondary:TXT']);
    assert.equal(resolver.getResolverDiagnostics().at(-1).fallbackCount, 1);
});

test('circuit breaker skips a failed endpoint without another timeout', async () => {
    const resolver = new HNSResolver(settings([primary, secondary]));
    let primaryAttempts = 0;
    resolver.queryResolver = async (candidate) => {
        if (candidate.id === 'primary') {
            primaryAttempts += 1;
            throw new Error('Request timeout');
        }
        return response(['203.0.113.10']);
    };

    await resolver.queryRecordSet('first.hns', ['A']);
    const second = await resolver.queryRecordSet('second.hns', ['A']);

    assert.equal(primaryAttempts, 1);
    assert.equal(resolver.getCacheStats().unhealthyResolvers, 1);
    assert.equal(second.fallbackCount, 1);
    assert.equal(second.attempts[0].status, 'COOLDOWN');
});

test('does not fall back or merge another root after NXDOMAIN or NODATA', async () => {
    for (const firstResponse of [response([], 3), response([], 0)]) {
        const resolver = new HNSResolver(settings([primary, secondary]));
        let secondaryAttempts = 0;
        resolver.queryResolver = async candidate => {
            if (candidate.id === 'secondary') secondaryAttempts += 1;
            return candidate.id === 'primary' ? firstResponse : response(['203.0.113.20']);
        };

        const result = await resolver.queryRecordSet('empty.hns', ['A']);
        assert.equal(result.resolver.id, 'primary');
        assert.deepEqual(result.records.A, []);
        assert.equal(secondaryAttempts, 0);
    }
});

test('fails over when one endpoint gives conflicting record-type status', async () => {
    const resolver = new HNSResolver(settings([primary, secondary]));
    resolver.queryResolver = async (candidate, domain, type) => {
        if (candidate.id === 'primary') {
            return type === 'A' ? response([], 3) : response([], 0);
        }
        return response(type === 'A' ? ['203.0.113.30'] : ['profile:value']);
    };

    const result = await resolver.queryRecordSet('conflict.hns', ['A', 'TXT']);
    assert.equal(result.resolver.id, 'secondary');
    assert.equal(result.fallbackCount, 1);
});

test('ordinary, HeadlessDomains web, and hns.bio lookups share resolver failover', async () => {
    const resolver = new HNSResolver(settings([primary, secondary]));
    resolver.queryResolver = async (candidate, domain, type) => {
        if (candidate.id === 'primary') throw new Error('offline');
        if (type === 'A') return response(['203.0.113.40']);
        if (type === 'TXT') return response(['x:skyinclude']);
        return response([]);
    };

    const ordinary = await resolver.resolveViaDoh('example.hns');
    assert.equal(ordinary.resolver.id, 'secondary');
    assert.equal(ordinary.address, '203.0.113.40');
    assert.equal(ordinary.hnsProfile.entries[0].key, 'x');

    resolver.resolverHealth.clear();
    const headless = await resolver.resolveWebRecordsOnly('mike.agent');
    assert.equal(headless.resolver.id, 'secondary');
    assert.equal(headless.address, '203.0.113.40');
});

test('TLSA lookup can fall back from wire DoH to DNS JSON', async () => {
    const resolver = new HNSResolver(settings([primary, secondary]));
    const expected = {
        usage: 3,
        selector: 1,
        matchingType: 1,
        certificateAssociationData: 'ab'.repeat(32)
    };
    resolver.queryResolver = async candidate => {
        if (candidate.id === 'primary') throw new Error('wire resolver offline');
        assert.equal(candidate.transport, 'dns-json');
        return { ...response([expected]), authenticated: true };
    };

    assert.deepEqual(await resolver.resolveTLSARecords('secure.hns', { force: true }), [expected]);
});

test('a lisa.agent-style A record wins even when its manifest publishes actions', async () => {
    const resolver = new HNSResolver(settings([primary]));
    let identityLookups = 0;
    resolver.queryResolver = async (candidate, domain, type) => response(
        type === 'A' ? ['134.209.111.52'] : []
    );
    resolver.lookupHeadlessDomain = async () => {
        identityLookups += 1;
        return {
            url: 'https://headlessdomains.com/manifests/lisa.agent.json',
            records: { metadata: { actions: [{ id: 'action-manager.published' }] } }
        };
    };

    const result = await resolver.resolveHNSDomain('lisa.agent');

    assert.equal(result.address, '134.209.111.52');
    assert.equal(result.url, 'http://lisa.agent');
    assert.equal(result.source, 'hns:primary');
    assert.equal(result.resolutionState, undefined);
    assert.equal(identityLookups, 0);
});

test('authoritative NOERROR without web records permits HeadlessDomains fallback', async () => {
    const resolver = new HNSResolver(settings([primary]));
    resolver.queryResolver = async () => response([]);
    resolver.fetchJson = async () => ({
        manifests: { agent_json: 'https://headlessdomains.com/manifests/identity.agent.json' },
        profile: { web_presence: { fallback_url: 'https://profiles.host.limo/identity.agent' } },
        integrations: {}
    });

    const result = await resolver.resolveHNSDomain('identity.agent');

    assert.equal(result.resolutionState, 'authoritative-absence');
    assert.equal(result.url, 'https://headlessdomains.com/manifests/identity.agent.json');
    assert.equal(result.headlessLinks.profileUrl, 'https://profiles.host.limo/identity.agent');
    assert.equal(result.headlessLinks.actionsUrl, 'https://headlessdomains.com/actions/identity.agent');
});

test('legacy HeadlessDomains lookup payload uses the canonical public actions page', () => {
    const resolver = new HNSResolver(settings([primary]));
    const links = resolver.getHeadlessLinks('lisa.agent', {
        manifests: { agent_json: 'https://headlessdomains.com/manifests/lisa.agent.json' },
        profile: { web_presence: { fallback_url: 'https://profiles.host.limo/lisa.agent' } },
        integrations: { arp_chat: { enabled: false, url: null } }
    });

    assert.equal(links.actionsUrl, 'https://headlessdomains.com/actions/lisa.agent');
    assert.equal(resolver.getHeadlessLinks('lisa.agent', {
        actions_url: 'https://headlessdomains.com/actions/lisa.agent?view=compact'
    }).actionsUrl, 'https://headlessdomains.com/actions/lisa.agent?view=compact');
});

test('all temporarily unavailable resolvers produce a non-cacheable status result', async () => {
    const resolver = new HNSResolver(settings([primary]));
    resolver.queryResolver = async () => {
        const error = new Error('resolver rate limited');
        error.code = 'HTTP_429';
        throw error;
    };
    resolver.fetchJson = async () => ({
        manifests: { agent_json: 'https://headlessdomains.com/manifests/lisa.agent.json' },
        profile: { web_presence: { fallback_url: 'https://profiles.host.limo/lisa.agent' } },
        integrations: {}
    });

    const result = await resolver.resolveHNSDomain('lisa.agent');

    assert.equal(result.resolutionState, 'temporary-failure');
    assert.equal(result.temporaryFailure, true);
    assert.equal(result.url, undefined);
    assert.equal(result.error.code, 'RESOLVER_FAILURE');
    assert.equal(result.headlessLinks.manifestUrl, 'https://headlessdomains.com/manifests/lisa.agent.json');
    assert.equal(resolver.cache.has('lisa.agent'), false);

    const cooldownResult = await resolver.resolveHNSDomain('lisa.agent');
    assert.equal(cooldownResult.resolutionState, 'temporary-failure');
    assert.equal(cooldownResult.url, undefined);
    assert.equal(cooldownResult.error.code, 'RESOLVER_COOLDOWN');
    assert.equal(resolver.cache.has('lisa.agent'), false);
});

test('resolver recovery after a transient failure returns and caches the native website', async () => {
    const resolver = new HNSResolver(settings([primary]));
    resolver.resolverCooldownMs = 0;
    let attempts = 0;
    resolver.queryResolver = async (candidate, domain, type) => {
        attempts += 1;
        if (attempts <= 4) {
            const error = new Error('temporary transport error');
            error.code = 'ECONNRESET';
            throw error;
        }
        return response(type === 'A' ? ['134.209.111.52'] : []);
    };
    resolver.fetchJson = async () => ({ manifests: {}, profile: {}, integrations: {} });

    const unavailable = await resolver.resolveHNSDomain('lisa.agent');
    const recovered = await resolver.resolveHNSDomain('lisa.agent');

    assert.equal(unavailable.resolutionState, 'temporary-failure');
    assert.equal(recovered.address, '134.209.111.52');
    assert.equal(resolver.cache.get('lisa.agent').result.address, '134.209.111.52');
});
