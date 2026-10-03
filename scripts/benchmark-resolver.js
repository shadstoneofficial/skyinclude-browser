#!/usr/bin/env node
// Synthetic, offline probes: these are not full-browser page-paint benchmarks.
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const { HNSResolver } = require('../resolver');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function simulatedResolver({ webDelayMs = 20, txtDelayMs = 20 } = {}) {
    const resolver = new HNSResolver();
    resolver.settings.resolvers = [{ transport: 'dns-json', url: 'https://benchmark.invalid/' }];
    let requests = 0;
    resolver.queryResolver = async (endpoint, domain, type) => {
        requests += 1;
        await delay(type === 'TXT' ? txtDelayMs : webDelayMs);
        return { rcode: 0, rcodeName: 'NOERROR', records: type === 'A' ? ['203.0.113.1'] : [] };
    };
    return { resolver, requestCount: () => requests };
}

async function benchmark() {
    const concurrent = simulatedResolver();
    let started = performance.now();
    const results = await Promise.all(Array.from({ length: 10 }, () => concurrent.resolver.resolveHNSDomain('benchmark.agent')));
    const sharedElapsedMs = Math.round(performance.now() - started);
    assert.equal(concurrent.requestCount(), 4);
    assert.ok(results.every(result => result.address === '203.0.113.1'));
    await results[0].profilePromise;

    const optional = simulatedResolver({ webDelayMs: 20, txtDelayMs: 180 });
    started = performance.now();
    const website = await optional.resolver.resolveHNSDomain('benchmark.agent');
    const websiteReadyMs = Math.round(performance.now() - started);
    await website.profilePromise;
    const enrichmentReadyMs = Math.round(performance.now() - started);

    const server = http.createServer((req, res) => {
        res.write('first');
        const interval = setInterval(() => res.write('more'), 20);
        res.once('close', () => clearInterval(interval));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    let deadlineElapsedMs;
    try {
        started = performance.now();
        await assert.rejects(new HNSResolver().fetchBuffer(`http://127.0.0.1:${server.address().port}/`, 60),
            error => error.code === 'REQUEST_TIMEOUT');
        deadlineElapsedMs = Math.round(performance.now() - started);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }

    console.log(JSON.stringify({
        scope: 'synthetic offline resolver probes; elapsed times vary by machine',
        concurrentLookup: { consumers: 10, dnsRequests: concurrent.requestCount(), elapsedMs: sharedElapsedMs },
        optionalTxt: { configuredWebDelayMs: 20, configuredTxtDelayMs: 180, websiteReadyMs, enrichmentReadyMs },
        tricklingResponse: { configuredDeadlineMs: 60, rejectedAfterMs: deadlineElapsedMs }
    }, null, 2));
}

benchmark().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
