const DEFAULT_SEARCH_ENGINE = 'https://duckduckgo.com/?q=';

function buildSearchUrl(query, searchEngine = DEFAULT_SEARCH_ENGINE) {
    const encoded = encodeURIComponent(query);
    const template = typeof searchEngine === 'string' ? searchEngine.trim() : '';
    const candidate = template.includes('%s') ? template.replace(/%s/g, encoded) : template + encoded;
    try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('Unsafe search URL');
        return parsed.toString();
    } catch {
        return DEFAULT_SEARCH_ENGINE + encoded;
    }
}

function resolveAddressInput(input, searchEngine) {
    const value = String(input || '').trim();
    if (!value || value === 'skyinclude://home') return value;
    // Single words remain native HNS roots. Use "? term" to explicitly search one word.
    if (value.startsWith('?')) {
        const query = value.slice(1).trim();
        if (!query) throw new Error('Enter a search term');
        return buildSearchUrl(query, searchEngine);
    }
    const scheme = value.match(/^([a-z][a-z\d+.-]*):\/\//i);
    if (scheme) {
        if (!['http', 'https', 'file'].includes(scheme[1].toLowerCase())) {
            throw new Error('Unsupported navigation protocol');
        }
        return new URL(value).toString();
    }
    // A host:port is navigation, not a scheme or a search term.
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[^\s/:]+:\d+(?:[/?#]|$)/.test(value)) {
        throw new Error('Unsupported navigation protocol');
    }
    return /\s/.test(value) ? buildSearchUrl(value, searchEngine) : value;
}

module.exports = { buildSearchUrl, resolveAddressInput };
