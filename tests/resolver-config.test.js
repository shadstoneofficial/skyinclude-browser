const assert = require('node:assert/strict');
const test = require('node:test');
const {
    formatResolverSetting,
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

test('infers Web3DNS JSON transport and DoH paths', () => {
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
