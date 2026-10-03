const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter, once } = require('node:events');
const test = require('node:test');
const { HNSResolver } = require('../resolver');

const primary = { id: 'primary', transport: 'dns-json', url: 'https://primary.invalid/' };
const secondary = { id: 'secondary', transport: 'dns-json', url: 'https://secondary.invalid/' };

function configuredResolver() {
    const configuration = { resolvers: [primary], timeout: 1000 };
    const resolver = new HNSResolver({
        getSetting(key) {
            if (key === 'hnsResolvers') return configuration.resolvers;
            if (key === 'hnsTimeout') return configuration.timeout;
            return null;
        }
    });
    return { resolver, configuration };
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

function answer(records = [], rcode = 0) {
    return { records, rcode, rcodeName: rcode === 3 ? 'NXDOMAIN' : 'NOERROR' };
}

async function localServer(t, handler) {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}/`;
}

test('ten normalized concurrent website lookups share one four-request record set', async () => {
    const { resolver } = configuredResolver();
    const gate = deferred();
    const calls = [];
    resolver.queryResolver = async (candidate, domain, type) => {
        calls.push({ candidate: candidate.id, domain, type });
        await gate.promise;
        return answer(type === 'A' ? ['134.209.111.52'] : []);
    };
    const consumers = Array.from({ length: 10 }, (_, index) => resolver.resolveHNSDomain(
        index % 2 ? ' HTTPS://Lisa.Agent./path ' : 'lisa.agent'
    ));
    assert.equal(calls.length, 4);
    assert.equal(resolver.pendingResolutions.size, 1);
    gate.resolve();
    const results = await Promise.all(consumers);
    assert.ok(results.every(result => result === results[0]));
    assert.equal(results[0].url, 'http://lisa.agent');
    assert.equal(resolver.pendingResolutions.size, 0);
    await resolver.resolveHNSDomain('lisa.agent');
    assert.equal(calls.length, 4);
});

test('pending and cached resolutions are isolated by resolver configuration', async () => {
    const { resolver, configuration } = configuredResolver();
    const gate = deferred();
    const calls = [];
    resolver.queryResolver = async (candidate, domain, type) => {
        calls.push(candidate.id);
        await gate.promise;
        return answer(type === 'A' ? [candidate.id === 'primary' ? '203.0.113.1' : '203.0.113.2'] : []);
    };
    const first = resolver.resolveHNSDomain('example.hns');
    configuration.resolvers = [secondary];
    const second = resolver.resolveHNSDomain('example.hns');
    assert.equal(calls.length, 8);
    gate.resolve();
    assert.equal((await first).address, '203.0.113.1');
    assert.equal((await second).address, '203.0.113.2');
    assert.equal((await resolver.resolveHNSDomain('example.hns')).address, '203.0.113.2');
    assert.equal(calls.length, 8);
});

test('clear cache prevents an already pending lookup from repopulating it', async () => {
    const { resolver } = configuredResolver();
    const gate = deferred();
    resolver.queryResolver = async (candidate, domain, type) => {
        await gate.promise;
        return answer(type === 'A' ? ['203.0.113.1'] : []);
    };
    const pending = resolver.resolveHNSDomain('example.hns');
    resolver.clearCache();
    gate.resolve();
    await pending;
    assert.equal(resolver.cache.size, 0);
});

test('clear cache also prevents an already pending TLSA lookup from repopulating it', async () => {
    const { resolver } = configuredResolver();
    const gate = deferred();
    const records = [{ usage: 3, selector: 1, matchingType: 1, certificateAssociationData: 'ab'.repeat(32) }];
    resolver.queryResolver = async () => {
        await gate.promise;
        return answer(records);
    };
    const pending = resolver.resolveTLSARecords('example.hns');
    resolver.clearCache();
    gate.resolve();
    assert.deepEqual(await pending, records);
    assert.equal(resolver.tlsaCache.size, 0);
});

test('cancelling one consumer preserves another tab shared lookup', async () => {
    const { resolver } = configuredResolver();
    const gate = deferred();
    const signals = [];
    resolver.queryResolver = async (candidate, domain, type, timeout, options) => {
        signals.push(options.signal);
        await gate.promise;
        return answer(type === 'A' ? ['203.0.113.1'] : []);
    };
    const controller = new AbortController();
    const first = resolver.resolveHNSDomain('example.hns', { signal: controller.signal });
    const surviving = resolver.resolveHNSDomain('example.hns');
    controller.abort();
    await assert.rejects(first, error => error.name === 'AbortError' && error.code === 'ABORT_ERR');
    assert.ok(signals.every(signal => !signal.aborted));
    gate.resolve();
    assert.equal((await surviving).address, '203.0.113.1');
});

test('cancelling every consumer aborts transport without marking resolver unhealthy', async () => {
    const { resolver } = configuredResolver();
    const signals = [];
    resolver.queryResolver = async (candidate, domain, type, timeout, { signal }) => {
        signals.push(signal);
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => {
            reject(resolver.createAbortError());
        }, { once: true }));
    };
    const controller = new AbortController();
    const pending = resolver.resolveHNSDomain('example.hns', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(signals.every(signal => signal.aborted));
    assert.equal(resolver.resolverHealth.size, 0);
    assert.equal(resolver.pendingResolutions.size, 0);
    assert.equal(resolver.cache.size, 0);
});

test('native website returns before slow optional TXT and cache receives the later profile', async () => {
    const { resolver } = configuredResolver();
    const txtGate = deferred();
    resolver.queryResolver = async (candidate, domain, type) => {
        if (type === 'TXT') {
            await txtGate.promise;
            return answer(['x:skyinclude', 'https://headlessdomains.com/manifests/lisa.agent.json']);
        }
        return answer(type === 'A' ? ['134.209.111.52'] : []);
    };
    const result = await resolver.resolveHNSDomain('lisa.agent');
    assert.equal(result.url, 'http://lisa.agent');
    assert.equal(result.hnsProfile, null);
    assert.equal(Object.keys(result).includes('profilePromise'), false);
    txtGate.resolve();
    const profile = await result.profilePromise;
    assert.equal(profile.entries[0].key, 'x');
    assert.equal(resolver.cache.get('lisa.agent').result.hnsProfile, profile);
    assert.equal(result.url, 'http://lisa.agent');
});

test('slow TXT does not delay a CNAME website or displace its original domain', async () => {
    const { resolver } = configuredResolver();
    const txtGate = deferred();
    resolver.queryResolver = async (candidate, domain, type) => {
        if (type === 'TXT') {
            await txtGate.promise;
            return answer(['https://redirect.invalid/']);
        }
        return answer(type === 'CNAME' ? ['target.hns'] : []);
    };
    const result = await resolver.resolveHNSDomain('alias.hns');
    assert.equal(result.domain, 'alias.hns');
    assert.equal(result.canonicalName, 'target.hns');
    txtGate.resolve();
    await result.profilePromise;
    assert.equal(result.canonicalName, 'target.hns');
});

test('failed optional TXT cannot turn a valid website into outage or poison resolver health', async () => {
    const { resolver } = configuredResolver();
    resolver.queryResolver = async (candidate, domain, type) => {
        if (type === 'TXT') throw new Error('TXT transport timeout');
        return answer(type === 'A' ? ['203.0.113.1'] : []);
    };
    const result = await resolver.resolveHNSDomain('example.hns');
    assert.equal(result.address, '203.0.113.1');
    assert.equal(await result.profilePromise, null);
    assert.equal(resolver.resolverHealth.size, 0);
});

test('late TXT enrichment is taken only from the endpoint that resolved the website', async () => {
    const { resolver, configuration } = configuredResolver();
    configuration.resolvers = [primary, secondary];
    const txtGate = deferred();
    resolver.queryResolver = async (candidate, domain, type) => {
        if (candidate.id === 'primary') {
            if (type === 'A') throw new Error('primary offline');
            return answer(type === 'TXT' ? ['x:wrong-root'] : []);
        }
        if (type === 'TXT') {
            await txtGate.promise;
            return answer(['x:correct-root']);
        }
        return answer(type === 'A' ? ['203.0.113.2'] : []);
    };
    const result = await resolver.resolveHNSDomain('example.hns');
    assert.equal(result.resolver.id, 'secondary');
    assert.equal(result.hnsProfile, null);
    txtGate.resolve();
    assert.equal((await result.profilePromise).entries[0].value, 'correct-root');
});

test('authoritative Headless identity fallback retains TXT profile without waiting for it', async () => {
    const { resolver } = configuredResolver();
    const txtGate = deferred();
    resolver.queryResolver = async (candidate, domain, type) => {
        if (type === 'TXT') {
            await txtGate.promise;
            return answer(['x:identity']);
        }
        return answer([]);
    };
    resolver.fetchHeadlessMetadata = async () => ({
        manifests: { agent_json: 'https://headlessdomains.com/manifests/identity.agent.json' }
    });
    const result = await resolver.resolveHNSDomain('identity.agent');
    assert.equal(result.resolutionState, 'authoritative-absence');
    assert.equal(result.hnsProfile, null);
    txtGate.resolve();
    assert.equal((await result.profilePromise).entries[0].value, 'identity');
});

test('TXT-only redirects remain supported after same-endpoint authoritative web absence', async () => {
    const { resolver, configuration } = configuredResolver();
    configuration.resolvers = [primary, secondary];
    const calls = [];
    resolver.queryResolver = async (candidate, domain, type) => {
        calls.push(candidate.id);
        return answer(type === 'TXT' ? ['https://identity.invalid/public-profile'] : []);
    };
    const result = await resolver.resolveHNSDomain('identity.hns');
    assert.equal(result.url, 'https://identity.invalid/public-profile');
    assert.equal(result.resolver.id, 'primary');
    assert.ok(calls.every(id => id === 'primary'));
});

test('a TXT failure after authoritative web absence is temporary, not cached absence', async () => {
    const { resolver } = configuredResolver();
    resolver.queryResolver = async (candidate, domain, type) => {
        if (type === 'TXT') throw new Error('TXT timeout');
        return answer([]);
    };
    const result = await resolver.resolveHNSDomain('identity.hns');
    assert.equal(result.resolutionState, 'temporary-failure');
    assert.equal(result.url, undefined);
    assert.equal(resolver.cache.size, 0);
});

test('resolver outage returns canonical links without any manifest metadata request', async () => {
    const { resolver } = configuredResolver();
    let metadataRequests = 0;
    resolver.queryResolver = async () => { throw new Error('offline'); };
    resolver.fetchHeadlessMetadata = async () => {
        metadataRequests += 1;
        throw new Error('Metadata must not be on the outage path');
    };
    const result = await resolver.resolveHNSDomain('lisa.agent');
    assert.equal(result.resolutionState, 'temporary-failure');
    assert.equal(metadataRequests, 0);
    assert.equal(result.url, undefined);
    assert.equal(result.headlessLinks.profileUrl, 'https://profiles.host.limo/lisa.agent');
    assert.equal(result.headlessLinks.actionsUrl, 'https://headlessdomains.com/actions/lisa.agent');
    assert.equal(result.headlessLinks.manifestUrl, 'https://headlessdomains.com/manifests/lisa.agent.json');
});

test('absolute HTTP deadline terminates a continuously trickling response', async t => {
    const closed = deferred();
    const url = await localServer(t, (request, response) => {
        response.writeHead(200);
        response.write('start');
        const interval = setInterval(() => response.write('.'), 10);
        response.on('close', () => { closed.resolve(); clearInterval(interval); });
    });
    const resolver = new HNSResolver();
    const startedAt = Date.now();
    await assert.rejects(resolver.fetchBuffer(url, 80), error => error.code === 'REQUEST_TIMEOUT');
    assert.ok(Date.now() - startedAt < 1000, 'trickle activity must not extend the deadline');
    await closed.promise;
});

test('absolute HTTP deadline also applies before connection or response headers', async t => {
    let destroyed = false;
    const request = new EventEmitter();
    request.destroy = () => { destroyed = true; };
    t.mock.method(http, 'get', () => request);
    const resolver = new HNSResolver();
    await assert.rejects(resolver.fetchBuffer('http://pending.invalid/', 20), { code: 'REQUEST_TIMEOUT' });
    assert.equal(destroyed, true);
});

test('response byte limit rejects declared and chunked oversized bodies', async t => {
    const url = await localServer(t, (request, response) => {
        if (request.url === '/declared') response.setHeader('Content-Length', 1024);
        response.write(Buffer.alloc(40));
        response.end(Buffer.alloc(40));
    });
    const resolver = new HNSResolver();
    for (const path of ['declared', 'chunked']) {
        await assert.rejects(resolver.fetchBuffer(`${url}${path}`, 1000, {}, { maxBytes: 64 }),
            error => error.code === 'RESPONSE_TOO_LARGE');
    }
});

test('incomplete HTTP responses reject immediately rather than hanging to their deadline', async t => {
    const url = await localServer(t, (request, response) => {
        response.setHeader('Content-Length', 1000);
        response.write('short');
        response.flushHeaders();
        setImmediate(() => response.destroy());
    });
    const resolver = new HNSResolver();
    await assert.rejects(resolver.fetchBuffer(url, 1000), error =>
        ['RESPONSE_ABORTED', 'ECONNRESET'].includes(error.code));
});

test('explicit fetch cancellation aborts the request with AbortError', async t => {
    const received = deferred();
    const url = await localServer(t, (request, response) => {
        response.writeHead(200);
        response.write('pending');
        received.resolve();
    });
    const resolver = new HNSResolver();
    const controller = new AbortController();
    const pending = resolver.fetchBuffer(url, 1000, {}, { signal: controller.signal });
    await received.promise;
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
});

test('HTTP rate limits retain their transient error code', async t => {
    const url = await localServer(t, (request, response) => {
        response.writeHead(429);
        response.end('Too many requests');
    });
    const resolver = new HNSResolver();
    await assert.rejects(resolver.fetchBuffer(url, 1000), { code: 'HTTP_429' });
});
