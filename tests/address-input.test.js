const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSearchUrl, resolveAddressInput } = require('../address-input');

test('single-label HNS roots and dotted hostnames stay navigation inputs', () => {
    for (const input of ['skyinclude', 'lisa.agent', 'example.com', 'example.shop', 'setup.skyinclude/path?q=one']) {
        assert.equal(resolveAddressInput(input), input);
    }
    assert.equal(resolveAddressInput('  lisa.agent  '), 'lisa.agent');
    assert.equal(resolveAddressInput('skyinclude://home'), 'skyinclude://home');
    assert.equal(resolveAddressInput(''), '');
});

test('multiword inputs search and an explicit question-mark searches a single word', () => {
    assert.equal(resolveAddressInput('handshake browser'), 'https://duckduckgo.com/?q=handshake%20browser');
    assert.equal(resolveAddressInput('? skyinclude'), 'https://duckduckgo.com/?q=skyinclude');
    assert.equal(resolveAddressInput('?  hns domains  '), 'https://duckduckgo.com/?q=hns%20domains');
    assert.throws(() => resolveAddressInput('?'), /search term/);
    assert.throws(() => resolveAddressInput('?   '), /search term/);
});

test('search templates and legacy URL prefixes encode terms without adding query parameters', () => {
    const query = 'cats & dogs/#? café';
    for (const engine of ['https://search.example/?q=%s', 'https://search.example/?q=']) {
        const result = new URL(buildSearchUrl(query, engine));
        assert.equal(result.hostname, 'search.example');
        assert.equal(result.searchParams.get('q'), query);
        assert.deepEqual([...result.searchParams.keys()], ['q']);
        assert.equal(result.hash, '');
    }
    const repeated = new URL(buildSearchUrl('a & b', 'https://search.example/?q=%s&text=%s'));
    assert.equal(repeated.searchParams.get('q'), 'a & b');
    assert.equal(repeated.searchParams.get('text'), 'a & b');
});

test('unsafe and malformed search engines fall back to the default HTTPS engine', () => {
    for (const engine of [
        'javascript:alert(%s)',
        'data:text/html,%s',
        'file:///tmp/%s',
        'http://search.example/?q=%s',
        'https://user:password@search.example/?q=%s',
        'https://',
        'not a URL',
        ''
    ]) {
        assert.equal(buildSearchUrl('a & b', engine), 'https://duckduckgo.com/?q=a%20%26%20b');
    }
});

test('explicit manifest URLs and canonical HTTP scheme navigation never become searches', () => {
    const manifest = 'https://headlessdomains.com/manifests/lisa.agent.json';
    assert.equal(resolveAddressInput(manifest), manifest);
    assert.equal(resolveAddressInput('HTTPS://EXAMPLE.COM/path?q=one'), 'https://example.com/path?q=one');
    assert.equal(resolveAddressInput('HTTP://LISA.AGENT:8080/path'), 'http://lisa.agent:8080/path');
});

test('host-and-port inputs remain navigation while unsupported protocols reject', () => {
    for (const input of ['skyinclude:8080', 'lisa.agent:8080/path', 'localhost:3000?q=one', '[::1]:8080/path']) {
        assert.equal(resolveAddressInput(input), input);
    }
    for (const input of ['javascript:alert(1)', 'data:text/html,hello', 'mailto:user@example.com', 'ftp://example.com', 'custom://example.com']) {
        assert.throws(() => resolveAddressInput(input), /Unsupported navigation protocol/);
    }
});
