const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildSafeProfileUrl,
    classifyProfileEntry,
    normalizeProfileImageUrl,
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

test('accepts only credential-free HTTPS profile images', () => {
    assert.equal(
        normalizeProfileImageUrl('pbs.twimg.com/profile_images/example.jpg'),
        'https://pbs.twimg.com/profile_images/example.jpg'
    );
    assert.equal(normalizeProfileImageUrl('https://example.com/avatar.png'), 'https://example.com/avatar.png');
    assert.equal(normalizeProfileImageUrl('http://example.com/avatar.png'), null);
    assert.equal(normalizeProfileImageUrl('data:image/png;base64,test'), null);
    assert.equal(normalizeProfileImageUrl('https://user:pass@example.com/avatar.png'), null);
});

test('promotes pfp to a safe image instead of an ordinary record', () => {
    const profile = sanitizeHnsProfile({
        domain: 'hnsbroker.chatbot',
        entries: [
            { key: 'pfp', label: 'Profile image', value: 'pbs.twimg.com/profile_images/avatar.jpg' },
            { key: 'x', label: 'X', value: 'hnsbroker' }
        ]
    });

    assert.equal(profile.imageUrl, 'https://pbs.twimg.com/profile_images/avatar.jpg');
    assert.equal(profile.entries.length, 1);
    assert.equal(profile.entries[0].key, 'x');
});
