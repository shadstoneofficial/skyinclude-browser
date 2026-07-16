const net = require('net');
const { URL } = require('url');

const RESOLVER_TRANSPORTS = new Set(['doh-wire', 'dns-json']);

const KNOWN_RESOLVERS = {
    'hnsdoh.com': { id: 'hnsdoh', name: 'HNS DoH', transport: 'doh-wire' },
    'query.hdns.io': { id: 'hdns', name: 'HDNS', transport: 'doh-wire' },
    'api.web3dns.net': { id: 'web3dns', name: 'Web3DNS', transport: 'dns-json' }
};

const BUILT_IN_RESOLVERS = [
    {
        id: 'hnsdoh',
        name: 'HNS DoH',
        transport: 'doh-wire',
        url: 'https://hnsdoh.com/dns-query',
        enabled: true
    },
    {
        id: 'web3dns',
        name: 'Web3DNS',
        transport: 'dns-json',
        url: 'https://api.web3dns.net/',
        enabled: true
    }
];

function slugify(value, fallback = 'custom-resolver') {
    const slug = String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug || fallback;
}

function parseResolverString(input) {
    const value = String(input || '').trim();
    if (!value) {
        return null;
    }

    const match = value.match(/^(doh-wire|dns-json)\s+(.+)$/i);
    return {
        transport: match ? match[1].toLowerCase() : null,
        url: (match ? match[2] : value).trim()
    };
}

function normalizeResolverUrl(value, transport) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
        return null;
    }
    const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    let url;

    try {
        url = new URL(withScheme);
    } catch (error) {
        return null;
    }

    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || net.isIP(hostname)) {
        return null;
    }

    url.hash = '';
    if (transport === 'doh-wire' && (!url.pathname || url.pathname === '/')) {
        url.pathname = '/dns-query';
    }

    return url.toString();
}

function normalizeResolverDescriptor(input, index = 0) {
    if (input === null || input === undefined) {
        return null;
    }

    const raw = typeof input === 'string'
        ? parseResolverString(input)
        : (typeof input === 'object' && !Array.isArray(input) ? { ...input } : null);

    if (!raw || raw.enabled === false) {
        return null;
    }

    const candidateUrl = String(raw.url || raw.endpoint || '').trim();
    if (!candidateUrl || candidateUrl.length > 2048) {
        return null;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidateUrl) && !/^https?:\/\//i.test(candidateUrl)) {
        return null;
    }

    let parsed;
    try {
        parsed = new URL(/^https?:\/\//i.test(candidateUrl) ? candidateUrl : `https://${candidateUrl}`);
    } catch (error) {
        return null;
    }

    const known = KNOWN_RESOLVERS[parsed.hostname.toLowerCase()] || null;
    const transport = String(raw.transport || known?.transport || 'doh-wire').toLowerCase();
    if (!RESOLVER_TRANSPORTS.has(transport)) {
        return null;
    }

    const url = normalizeResolverUrl(candidateUrl, transport);
    if (!url) {
        return null;
    }

    const hostname = new URL(url).hostname.toLowerCase();
    const fallbackId = `${slugify(hostname)}-${index + 1}`;

    return {
        id: slugify(raw.id || known?.id || hostname, fallbackId),
        name: String(raw.name || known?.name || hostname).trim().slice(0, 80),
        transport,
        url,
        enabled: true
    };
}

function normalizeResolverList(inputs) {
    if (!Array.isArray(inputs)) {
        return [];
    }

    const seen = new Set();
    return inputs
        .map((input, index) => normalizeResolverDescriptor(input, index))
        .filter(Boolean)
        .filter(resolver => {
            const key = `${resolver.transport}|${resolver.url}`.toLowerCase();
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

function formatResolverSetting(resolver) {
    const normalized = normalizeResolverDescriptor(resolver);
    return normalized ? `${normalized.transport} ${normalized.url}` : '';
}

module.exports = {
    BUILT_IN_RESOLVERS,
    RESOLVER_TRANSPORTS,
    formatResolverSetting,
    normalizeResolverDescriptor,
    normalizeResolverList,
    normalizeResolverUrl,
    parseResolverString
};
