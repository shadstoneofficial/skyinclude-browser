const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ARCHIVED_RESOLVERS,
    BUILT_IN_RESOLVERS,
    formatResolverSetting,
    isRetiredResolver,
    normalizeResolverDescriptor,
    normalizeResolverList
} = require('../resolver-config');

test('migrates legacy resolver strings into ordered transport descriptors', () => {
    const resolvers = normalizeResolverList([
        'https://hnsdoh.com/dns-query',
        'dns-json https://api.web3dns.net/',
        'https://query.hdns.io/dns-query'
    ]);

    assert.deepEqual(resolvers.map(resolver => ({
        id: resolver.id,
        transport: resolver.transport,
        url: resolver.url
    })), [
        { id: 'hnsdoh', transport: 'doh-wire', url: 'https://hnsdoh.com/dns-query' },
        { id: 'web3dns', transport: 'dns-json', url: 'https://api.web3dns.net/' },
        { id: 'hdns', transport: 'doh-wire', url: 'https://query.hdns.io/dns-query' }
    ]);
});

test('preserves explicit descriptor order and removes exact duplicates', () => {
    const resolvers = normalizeResolverList([
        { id: 'second', name: 'Second', transport: 'dns-json', url: 'https://second.example/' },
        { id: 'first', name: 'First', transport: 'doh-wire', url: 'https://first.example/dns-query' },
        'doh-wire https://first.example/dns-query'
    ]);

    assert.deepEqual(resolvers.map(resolver => resolver.id), ['second', 'first']);
    assert.equal(formatResolverSetting(resolvers[0]), 'dns-json https://second.example/');
});

test('infers known resolver transports and DoH paths', () => {
    assert.deepEqual(
        normalizeResolverDescriptor('https://api.web3dns.net/'),
        {
            id: 'web3dns',
            name: 'Web3DNS',
            transport: 'dns-json',
            url: 'https://api.web3dns.net/',
            enabled: true
        }
    );
    assert.equal(
        normalizeResolverDescriptor('custom.example').url,
        'https://custom.example/dns-query'
    );
    assert.equal(normalizeResolverDescriptor('https://resolve.shakestation.io/dns-query'), null);
});

test('active defaults use the Web3DNS binary root while retired metadata remains archival only', () => {
    assert.deepEqual(normalizeResolverList(BUILT_IN_RESOLVERS).map(({ transport, url }) => ({ transport, url })), [
        { transport: 'doh-wire', url: 'https://hnsdoh.com/dns-query' },
        { transport: 'doh-wire', url: 'https://doh.web3dns.net/' }
    ]);
    assert.equal(ARCHIVED_RESOLVERS[0].status, 'retired');
    assert.deepEqual(normalizeResolverList(ARCHIVED_RESOLVERS), []);
});

test('Web3DNS known binary root is not rewritten; explicit paths and legacy JSON remain intact', () => {
    for (const url of ['https://doh.web3dns.net', 'https://doh.web3dns.net/', 'doh.web3dns.net']) {
        const resolver = normalizeResolverDescriptor(url);
        assert.equal(resolver.transport, 'doh-wire');
        assert.equal(resolver.url, 'https://doh.web3dns.net/');
    }
    assert.equal(normalizeResolverDescriptor('https://doh.web3dns.net/custom?q=1').url,
        'https://doh.web3dns.net/custom?q=1');
    assert.equal(normalizeResolverDescriptor('https://doh.web3dns.net/dns-query').url,
        'https://doh.web3dns.net/dns-query');
    assert.equal(normalizeResolverDescriptor('https://doh.web3dns.net.evil.example/').url,
        'https://doh.web3dns.net.evil.example/dns-query');
    assert.equal(normalizeResolverDescriptor('https://api.web3dns.net/').transport, 'dns-json');
    assert.equal(normalizeResolverDescriptor('dns-json https://doh.web3dns.net/').transport, 'dns-json');
});

test('retirement matches the exact hostname, never a custom id or spoofed prefix', () => {
    for (const value of ['https://resolve.shakestation.io/dns-query', 'dns-json https://RESOLVE.SHAKESTATION.IO/custom',
        'resolve.shakestation.io', 'http://resolve.shakestation.io.:8080/custom',
        { id: 'other', endpoint: 'https://resolve.shakestation.io/', enabled: false }]) {
        assert.equal(isRetiredResolver(value), true);
        assert.equal(normalizeResolverDescriptor(value), null);
    }
    for (const value of [{ id: 'shakestation', url: 'https://custom.example/dns-query' },
        'https://resolve.shakestation.io.evil.example/', 'https://other.resolve.shakestation.io/',
        'https://safe.example/resolve.shakestation.io']) {
        assert.equal(isRetiredResolver(value), false);
        assert.ok(normalizeResolverDescriptor(value));
    }
});

test('never treats native DNS IP addresses as DoH URLs', () => {
    assert.equal(normalizeResolverDescriptor('82.68.70.162'), null);
    assert.equal(normalizeResolverDescriptor('doh-wire https://82.68.70.163/dns-query'), null);
    assert.equal(normalizeResolverDescriptor({
        transport: 'dns-json',
        url: 'https://[2001:db8::1]/'
    }), null);
});

test('rejects disabled, unsupported, and non-HTTP resolver entries', () => {
    assert.equal(normalizeResolverDescriptor({ enabled: false, url: 'https://disabled.example/' }), null);
    assert.equal(normalizeResolverDescriptor({ transport: 'native-dns', url: 'https://resolver.example/' }), null);
    assert.equal(normalizeResolverDescriptor('https://user:secret@resolver.example/dns-query'), null);
    assert.equal(normalizeResolverDescriptor('file:///tmp/resolver'), null);
});
