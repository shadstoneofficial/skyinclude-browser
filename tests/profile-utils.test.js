const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildSafeProfileUrl,
    classifyProfileEntry,
    sanitizeHnsProfile
} = require('../profile-utils.js');

test('categorizes profile records', () => {
    assert.equal(classifyProfileEntry('btc'), 'wallet');
    assert.equal(classifyProfileEntry('manifest'), 'agent');
    assert.equal(classifyProfileEntry('x'), 'social');
    assert.equal(classifyProfileEntry('custom'), 'other');
});

test('generates only allowlisted profile links', () => {
    assert.equal(buildSafeProfileUrl('x', '@skyinclude'), 'https://x.com/skyinclude');
    assert.equal(buildSafeProfileUrl('link', 'example.com'), 'https://example.com/');
    assert.equal(buildSafeProfileUrl('link', 'javascript:alert(1)'), null);
    assert.equal(buildSafeProfileUrl('link', 'file:///etc/passwd'), null);
    assert.equal(buildSafeProfileUrl('btc', 'wallet-address'), null);
});

test('sanitizes, categorizes, and limits profile data', () => {
    const profile = sanitizeHnsProfile({
        domain: 'example/',
        entries: [
            { key: 'btc', label: 'Bitcoin', value: ' bc1-test ' },
            { key: 'link', label: 'Website', value: 'https://example.com/path' }
        ]
    });

    assert.deepEqual(profile, {
        domain: 'example/',
        entries: [
            { key: 'btc', label: 'Bitcoin', value: 'bc1-test', category: 'wallet', url: null },
            {
                key: 'link',
                label: 'Website',
                value: 'https://example.com/path',
                category: 'social',
                url: 'https://example.com/path'
            }
        ]
    });
});

test('rejects control characters and unsafe protocols', () => {
    assert.equal(buildSafeProfileUrl('link', 'https://example.com/\nattack'), null);
    assert.equal(buildSafeProfileUrl('manifest', 'data:text/html,test'), null);
});
