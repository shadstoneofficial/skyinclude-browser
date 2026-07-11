const WALLET_KEYS = new Set([
    'btc', 'hns', 'eth', 'sol', 'doge', 'ltc', 'xmr', 'zec', 'dash'
]);

const AGENT_KEYS = new Set(['bmos', 'manifest', 'skill']);
const SOCIAL_KEYS = new Set([
    'mail', 'tel', 'matrix', 'sn', 'wa', 'tg', 'x', 'nostr', 'gh',
    'bsky', 'ig', 'fb', 'yt', 'rumble', 'link', 'ens', 'onion', 'ipfs'
]);

const CATEGORY_META = {
    social: { label: 'Links & contact', icon: '↗' },
    wallet: { label: 'Wallets', icon: '◈' },
    agent: { label: 'Agents', icon: '⚙' },
    other: { label: 'Other records', icon: '•' }
};

function normalizeKey(value) {
    return String(value || '').trim().toLowerCase().slice(0, 40);
}

function classifyProfileEntry(key) {
    const normalized = normalizeKey(key);
    if (WALLET_KEYS.has(normalized)) return 'wallet';
    if (AGENT_KEYS.has(normalized)) return 'agent';
    if (SOCIAL_KEYS.has(normalized)) return 'social';
    return 'other';
}

function normalizeWebUrl(value, { allowHttp = true } = {}) {
    const text = String(value || '').trim();
    if (!text || /[\u0000-\u001f\u007f]/.test(text)) return null;

    const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
    try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) return null;
        if (!parsed.hostname) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

function buildSafeProfileUrl(key, value) {
    const normalizedKey = normalizeKey(key);
    const text = String(value || '').trim();
    if (!text) return null;

    const handles = {
        x: value => `https://x.com/${encodeURIComponent(value.replace(/^@/, ''))}`,
        tg: value => `https://t.me/${encodeURIComponent(value.replace(/^@/, ''))}`,
        gh: value => `https://github.com/${encodeURIComponent(value.replace(/^@/, ''))}`,
        ig: value => `https://www.instagram.com/${encodeURIComponent(value.replace(/^@/, ''))}`,
        fb: value => `https://www.facebook.com/${encodeURIComponent(value)}`,
        yt: value => `https://www.youtube.com/@${encodeURIComponent(value.replace(/^@/, ''))}`,
        rumble: value => `https://rumble.com/${encodeURIComponent(value)}`,
        bsky: value => `https://bsky.app/profile/${encodeURIComponent(value.replace(/^@/, ''))}`
    };

    if (handles[normalizedKey]) return handles[normalizedKey](text);
    if (normalizedKey === 'link' || AGENT_KEYS.has(normalizedKey)) return normalizeWebUrl(text);
    if (normalizedKey === 'ipfs' && /^[a-zA-Z0-9]+$/.test(text)) {
        return `https://ipfs.io/ipfs/${encodeURIComponent(text)}`;
    }
    if (normalizedKey === 'ens' && /^[a-z0-9.-]+\.eth$/i.test(text)) {
        return `https://${text.toLowerCase()}.limo/`;
    }
    return null;
}

function sanitizeHnsProfile(profile) {
    if (!profile || !Array.isArray(profile.entries) || !profile.entries.length) return null;

    const entries = profile.entries.slice(0, 24).map(entry => {
        const key = normalizeKey(entry.key || entry.label);
        const value = String(entry.value || '').trim().slice(0, 500);
        return {
            key,
            label: String(entry.label || entry.key || 'Record').trim().slice(0, 40),
            value,
            category: classifyProfileEntry(key),
            url: buildSafeProfileUrl(key, value)
        };
    }).filter(entry => entry.value);

    return entries.length ? {
        domain: String(profile.domain || 'HNS profile').trim().slice(0, 120),
        entries
    } : null;
}

module.exports = {
    CATEGORY_META,
    buildSafeProfileUrl,
    classifyProfileEntry,
    sanitizeHnsProfile
};
