const ICANN_TLDS = new Set([
    'com', 'org', 'net', 'edu', 'gov', 'mil', 'int', 'io', 'co',
    'ai', 'app', 'dev', 'xyz', 'info', 'biz', 'us', 'uk', 'ca',
    'de', 'fr', 'jp', 'cn', 'au', 'in', 'br', 'ru', 'ch', 'nl'
]);

const HNS_HINTS = new Set([
    'hns', 'agent', 'chatbot', 'nb', 'sats', 'blockchain', 'crypto',
    'mercenary', 'bit', 'coin', 'wallet'
]);

function isIPAddress(hostname) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

function isHNSDomain(hostname) {
    const normalized = String(hostname || '').toLowerCase();
    if (isIPAddress(normalized)) {
        return false;
    }

    const parts = normalized.split('.').filter(Boolean);
    if (parts.length === 1) {
        return /^[a-z0-9-]+$/.test(parts[0]);
    }

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
    safeHttpUrl
};
