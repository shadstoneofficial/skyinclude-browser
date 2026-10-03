const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const {
    buildNativeHnsHttpNavigation,
    buildTemporaryResolutionActions,
    isHNSDomain,
    isIPAddress,
    normalizeDnsHostname,
    safeHttpUrl
} = require('../navigation-policy');
const icannSnapshot = require('../assets/icann-tlds.json');

test('ordinary HNS and ICANN sites stay on their respective resolution paths', () => {
    assert.equal(isHNSDomain('handshake.mercenary'), true);
    assert.equal(isHNSDomain('skyinclude'), true);
    assert.equal(isHNSDomain('google.com'), false);
    assert.equal(isHNSDomain('www.example.org'), false);
});

test('all bundled IANA TLDs stay on ordinary DNS rather than HNS', () => {
    assert.ok(icannSnapshot.tlds.length >= 1000);
    for (const tld of icannSnapshot.tlds) {
        assert.equal(isHNSDomain(`example.${tld}`), false, tld);
    }
    for (const host of ['example.shop', 'example.online', 'example.finance', 'example.photography']) {
        assert.equal(isHNSDomain(host), false, host);
    }
});

test('DNS classification normalizes case, final root dots, and IDN labels', () => {
    assert.equal(normalizeDnsHostname('WWW.Example.SHOP.'), 'www.example.shop');
    assert.equal(isHNSDomain('WWW.Example.SHOP.'), false);
    assert.equal(isHNSDomain('LISA.AGENT.'), true);
    assert.equal(isHNSDomain('пример.рф'), false);
    assert.equal(isHNSDomain('пример.xn--p1ai'), false);
    assert.equal(isHNSDomain('example.中国'), false);
    assert.equal(isHNSDomain('пример.agent'), true);
    assert.equal(isHNSDomain('lisa。agent'), true);
    assert.equal(isHNSDomain('skyinclude.'), true);
});

test('single-label native roots and explicit HNS namespace hints retain their existing route', () => {
    for (const root of ['skyinclude', 'com', 'shop', 'xn--e1afmkfd']) {
        assert.equal(isHNSDomain(root), true, root);
    }
    for (const hint of ['hns', 'agent', 'chatbot', 'nb', 'sats', 'blockchain', 'crypto', 'mercenary', 'bit', 'coin', 'wallet']) {
        assert.equal(isHNSDomain(`native.${hint}`), true, hint);
    }

    // Simulate a future delegation colliding with an existing native suffix.
    // Refreshing root-zone data must not redirect that native namespace.
    const sandbox = { module: { exports: {} }, URL, require: name => (
        name === './assets/icann-tlds.json'
            ? { tlds: [...icannSnapshot.tlds, 'agent', 'crypto'] }
            : require(name)
    ) };
    vm.runInNewContext(fs.readFileSync(require.resolve('../navigation-policy'), 'utf8'), sandbox);
    assert.equal(sandbox.module.exports.isHNSDomain('lisa.agent'), true);
    assert.equal(sandbox.module.exports.isHNSDomain('native.crypto'), true);
    assert.equal(sandbox.module.exports.isHNSDomain('example.shop'), false);
});

test('IP literals and malformed hostnames cannot become native HNS domains', () => {
    for (const address of ['127.0.0.1', '134.209.111.52', '::1', '2001:db8::1', '[2001:db8::1]']) {
        assert.equal(isIPAddress(address), true, address);
        assert.equal(isHNSDomain(address), false, address);
    }
    for (const hostname of [
        '', '.', 'lisa..agent', 'lisa.agent..', '-lisa.agent', 'lisa-.agent',
        'lisa_agent', ' lisa.agent', 'lisa.agent ', 'http://lisa.agent',
        'lisa.agent/path', 'lisa.agent:80', 'user@lisa.agent', 'lisa.agent?query',
        'lisa.agent#fragment', 'lisa%2eagent', 'foo\\bar.agent', 'xn--.agent',
        '256.1.1.1', `${'a'.repeat(64)}.agent`, `${'a'.repeat(63)}.`.repeat(4) + 'agent'
    ]) {
        assert.equal(isHNSDomain(hostname), false, hostname);
    }
});

test('direct HeadlessDomains manifest navigation remains ordinary HTTPS navigation', () => {
    const url = new URL('https://headlessdomains.com/manifests/lisa.agent.json');
    assert.equal(isHNSDomain(url.hostname), false);
    assert.equal(url.toString(), 'https://headlessdomains.com/manifests/lisa.agent.json');
});

test('native HNS website navigation preserves the visible hostname and original Host header', () => {
    const navigation = buildNativeHnsHttpNavigation('http://lisa.agent/services?view=all', {
        domain: 'lisa.agent',
        address: '134.209.111.52'
    });

    assert.equal(navigation.url, 'http://lisa.agent/services?view=all');
    assert.equal(navigation.displayUrl, 'lisa.agent/services?view=all');
    assert.equal(navigation.hnsHostHeader, 'lisa.agent');
    assert.equal(navigation.proxyHost, 'lisa.agent');
    assert.equal(navigation.resolvedHost, '134.209.111.52');
});

test('temporary HeadlessDomains failure offers explicit recovery and identity choices', () => {
    const actions = buildTemporaryResolutionActions('http://lisa.agent/', {
        headlessLinks: {
            profileUrl: 'https://profiles.host.limo/lisa.agent',
            actionsUrl: 'https://headlessdomains.com/actions/lisa.agent',
            manifestUrl: 'https://headlessdomains.com/manifests/lisa.agent.json'
        }
    });

    assert.deepEqual(actions.map(action => action.label), [
        'Retry',
        'Open native HNS HTTP',
        'View public profile',
        'View actions',
        'View agent manifest'
    ]);
    assert.match(actions[1].href, /__skyinclude_native_http=1/);
    assert.equal(actions[4].href, 'https://headlessdomains.com/manifests/lisa.agent.json');
});

test('temporary status actions reject unsafe URLs from remote identity metadata', () => {
    assert.equal(safeHttpUrl('javascript:alert(1)'), null);
    assert.equal(safeHttpUrl('https://user:secret@example.com/profile'), null);
    assert.equal(safeHttpUrl('https://example.com/profile'), 'https://example.com/profile');
});
