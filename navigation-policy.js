const net = require('node:net');
const { domainToASCII } = require('node:url');
const icannSnapshot = require('./assets/icann-tlds.json');

// Bundled data keeps navigation classification offline and deterministic. Refresh
// it with `node scripts/update-icann-tlds.js`, then review the snapshot changes.
const ICANN_TLDS = new Set(icannSnapshot.tlds);

// Explicit compatibility overrides: a future ICANN delegation of one of these
// suffixes must not silently move existing native HNS sites to ordinary DNS.
// Single-label names also remain native HNS roots, including collision names.
const HNS_HINTS = new Set([
    'hns', 'agent', 'chatbot', 'nb', 'sats', 'blockchain', 'crypto',
    'mercenary', 'bit', 'coin', 'wallet'
]);

function isIPAddress(hostname) {
    const value = String(hostname || '');
    const unbracketed = value.startsWith('[') && value.endsWith(']')
        ? value.slice(1, -1)
        : value;
    return net.isIP(unbracketed) !== 0;
}

function normalizeDnsHostname(hostname) {
    const value = String(hostname || '');
    // Reject URL delimiters, escaped hostnames, and whitespace before IDNA
    // conversion, which would otherwise accept or truncate some invalid input.
    if (!value || /[\s\/%\\:@?#\[\]]/.test(value) || isIPAddress(value)) return null;

    const ascii = domainToASCII(value).toLowerCase();
    const normalized = ascii.endsWith('.') ? ascii.slice(0, -1) : ascii;
    if (!normalized || normalized.length > 253 || isIPAddress(normalized)) return null;

    const labels = normalized.split('.');
    if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    return normalized;
}

function isHNSDomain(hostname) {
    const normalized = normalizeDnsHostname(hostname);
    if (!normalized) return false;

    const parts = normalized.split('.');
    if (parts.length === 1) return true;

    const tld = parts[parts.length - 1];
    return HNS_HINTS.has(tld) || !ICANN_TLDS.has(tld);
}

function buildNativeHnsHttpNavigation(originalUrl, resolution) {
    const parsedUrl = new URL(originalUrl);
    parsedUrl.protocol = 'http:';

    return {
        url: parsedUrl.toString(),
        displayUrl: `${resolution.domain}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`,
        hnsHostHeader: resolution.domain,
        proxyHost: resolution.domain,
        resolvedHost: resolution.address
    };
}

function safeHttpUrl(value) {
    try {
        const parsedUrl = new URL(value);
        if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
            return null;
        }
        return parsedUrl.toString();
    } catch (error) {
        return null;
    }
}

function buildTemporaryResolutionActions(originalUrl, resolution) {
    const nativeHttpUrl = new URL(originalUrl);
    nativeHttpUrl.protocol = 'http:';
    nativeHttpUrl.searchParams.set('__skyinclude_native_http', '1');
    const links = resolution.headlessLinks || {};
    const actions = [
        { label: 'Retry', href: originalUrl, primary: true },
        { label: 'Open native HNS HTTP', href: nativeHttpUrl.toString() }
    ];

    const profileUrl = safeHttpUrl(links.profileUrl);
    const actionsUrl = safeHttpUrl(links.actionsUrl);
    const manifestUrl = safeHttpUrl(links.manifestUrl);
    if (profileUrl) actions.push({ label: 'View public profile', href: profileUrl });
    if (actionsUrl) actions.push({ label: 'View actions', href: actionsUrl });
    if (manifestUrl) actions.push({ label: 'View agent manifest', href: manifestUrl });
    return actions;
}

module.exports = {
    buildNativeHnsHttpNavigation,
    buildTemporaryResolutionActions,
    isHNSDomain,
    isIPAddress,
    normalizeDnsHostname,
    safeHttpUrl
};
