const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildNativeHnsHttpNavigation,
    buildTemporaryResolutionActions,
    isHNSDomain,
    safeHttpUrl
} = require('../navigation-policy');

test('ordinary HNS and ICANN sites stay on their respective resolution paths', () => {
    assert.equal(isHNSDomain('handshake.mercenary'), true);
    assert.equal(isHNSDomain('skyinclude'), true);
    assert.equal(isHNSDomain('google.com'), false);
    assert.equal(isHNSDomain('www.example.org'), false);
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
