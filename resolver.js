const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const crypto = require('crypto');
const net = require('net');
const { URL } = require('url');
const {
    BUILT_IN_RESOLVERS,
    normalizeResolverDescriptor,
    normalizeResolverList,
    normalizeResolverUrl
} = require('./resolver-config.js');

const DNS_TYPES = {
    A: 1,
    CNAME: 5,
    TXT: 16,
    AAAA: 28,
    TLSA: 52
};

const SUPPORTED_TLSA = {
    usage: 3,
    selector: 1,
    matchingType: 1
};

const DNS_RCODE_NAMES = {
    0: 'NOERROR',
    1: 'FORMERR',
    2: 'SERVFAIL',
    3: 'NXDOMAIN',
    4: 'NOTIMP',
    5: 'REFUSED'
};

const HNS_BIO_PREFIXES = new Set([
    'pfp', 'bgcolor', 'bg', 'mail', 'tel', 'tb', 'sx', 'matrix', 'sn',
    'wa', 'tg', 'link', 'ens', 'onion', 'ipfs', 'pk', 'x', 'nostr',
    'gh', 'bsky', 'ig', 'fb', 'yt', 'rumble', 'btc', 'hns', 'eth',
    'sol', 'doge', 'ltc', 'xmr', 'zec', 'dash', 'ext'
]);

const HNS_BIO_LABELS = {
    pfp: 'Profile image',
    bgcolor: 'Background color',
    bg: 'Background image',
    mail: 'Email',
    tel: 'Phone',
    tb: 'Thunderbird',
    sx: 'Handshake SLD',
    matrix: 'Matrix',
    sn: 'Signal',
    wa: 'WhatsApp',
    tg: 'Telegram',
    link: 'Link',
    ens: 'ENS',
    onion: 'Onion',
    ipfs: 'IPFS',
    pk: 'Public key',
    x: 'X',
    nostr: 'Nostr',
    gh: 'GitHub',
    bsky: 'Bluesky',
    ig: 'Instagram',
    fb: 'Facebook',
    yt: 'YouTube',
    rumble: 'Rumble',
    btc: 'Bitcoin',
    hns: 'Handshake',
    eth: 'Ethereum',
    sol: 'Solana',
    doge: 'Dogecoin',
    ltc: 'Litecoin',
    xmr: 'Monero',
    zec: 'Zcash',
    dash: 'Dash',
    ext: 'Extension'
};

class HNSResolver {
    constructor(settingsManager = null) {
        this.settingsManager = settingsManager;
        this.settings = {
            resolutionMode: 'doh',
            resolvers: BUILT_IN_RESOLVERS,
            dohResolver: BUILT_IN_RESOLVERS[0].url,
            headlessLookupBase: 'https://headlessdomains.com/api/v1/lookup/',
            timeout: 4000,
            enableDANE: false
        };

        this.cache = new Map();
        this.cacheTimeout = 300000;
        this.pendingResolutions = new Map();
        this.cacheGeneration = 0;
        this.tlsaCache = new Map();
        this.pendingTLSAResolutions = new Map();
        this.tlsaRevisions = new Map();
        this.tlsaCacheTimeout = 300000;
        this.resolverHealth = new Map();
        this.resolverDiagnostics = [];
        this.maxResolverDiagnostics = 100;
        this.resolverCooldownMs = 30000;
    }

    getResolverSettings() {
        if (!this.settingsManager) {
            return {
                ...this.settings,
                resolvers: normalizeResolverList(this.settings.resolvers)
            };
        }

        const resolvers = normalizeResolverList(this.settingsManager.getSetting('hnsResolvers') || []);
        const customResolver = this.settingsManager.getSetting('hnsCustomResolver');
        const candidates = normalizeResolverList([
            customResolver,
            ...resolvers
        ]);

        const configuredTimeout = Number(this.settingsManager.getSetting('hnsTimeout') || this.settings.timeout);
        const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? Math.min(configuredTimeout, 30000)
            : this.settings.timeout;

        return {
            resolutionMode: this.settingsManager.getSetting('hnsResolutionMode') || 'doh',
            resolvers: candidates.length ? candidates : normalizeResolverList(this.settings.resolvers),
            dohResolver: candidates.find(resolver => resolver.transport === 'doh-wire')?.url || this.settings.dohResolver,
            headlessLookupBase: this.settings.headlessLookupBase,
            timeout,
            enableDANE: this.settingsManager.getSetting('hnsDANE') === true
        };
    }

    normalizeDohResolver(resolverUrl) {
        return normalizeResolverUrl(String(resolverUrl || '').replace(/^doh-wire\s+/i, '').trim(), 'doh-wire');
    }

    getConfiguredResolverCandidates(options = {}) {
        const settings = this.getResolverSettings();
        return normalizeResolverList([
            options.resolver,
            options.dohResolver,
            ...settings.resolvers
        ]);
    }

    getResolverCandidateState(options = {}) {
        const candidates = this.getConfiguredResolverCandidates(options);
        const now = Date.now();
        const available = [];
        const cooling = [];
        candidates.forEach((resolver, configuredIndex) => {
            const health = this.resolverHealth.get(this.getResolverHealthKey(resolver, options.healthScope));
            if (!options.ignoreCooldown && health && health.retryAt > now) {
                cooling.push({ resolver, configuredIndex, retryAt: health.retryAt });
            } else {
                available.push({ resolver, configuredIndex });
            }
        });
        return { candidates, available, cooling };
    }

    getResolverCandidates(options = {}) {
        return this.getResolverCandidateState(options).available.map(candidate => candidate.resolver);
    }

    getDohResolverCandidates(options = {}) {
        return this.getResolverCandidates(options)
            .filter(resolver => resolver.transport === 'doh-wire')
            .map(resolver => resolver.url);
    }

    getResolverKey(resolver) {
        return `${resolver.transport}|${resolver.url}`.toLowerCase();
    }

    getResolverHealthKey(resolver, scope = '') {
        return `${this.getResolverKey(resolver)}${scope ? `|${scope}` : ''}`;
    }

    getPublicResolverInfo(resolver) {
        return resolver ? {
            id: resolver.id,
            name: resolver.name,
            transport: resolver.transport,
            url: resolver.url
        } : null;
    }

    recordResolverDiagnostic(event) {
        this.resolverDiagnostics.push({
            timestamp: new Date().toISOString(),
            ...event
        });
        if (this.resolverDiagnostics.length > this.maxResolverDiagnostics) {
            this.resolverDiagnostics.splice(0, this.resolverDiagnostics.length - this.maxResolverDiagnostics);
        }
    }

    markResolverFailure(resolver, error, elapsedMs, healthScope = '') {
        const key = this.getResolverHealthKey(resolver, healthScope);
        this.resolverHealth.set(key, {
            retryAt: Date.now() + this.resolverCooldownMs,
            error: error.message
        });
        this.recordResolverDiagnostic({
            event: 'failure',
            recordScope: healthScope || 'website',
            resolver: this.getPublicResolverInfo(resolver),
            elapsedMs,
            status: error.rcodeName || error.code || 'ERROR',
            message: error.message
        });
    }

    markResolverSuccess(resolver, elapsedMs, rcodeName, fallbackCount, healthScope = '') {
        this.resolverHealth.delete(this.getResolverHealthKey(resolver, healthScope));
        this.recordResolverDiagnostic({
            event: 'success',
            recordScope: healthScope || 'website',
            resolver: this.getPublicResolverInfo(resolver),
            elapsedMs,
            status: rcodeName,
            fallbackCount
        });
    }

    createAbortError() {
        const error = new Error('Resolution cancelled');
        error.name = 'AbortError';
        error.code = 'ABORT_ERR';
        return error;
    }

    throwIfAborted(signal) {
        if (signal?.aborted) throw this.createAbortError();
    }

    getResolutionConfigurationKey() {
        const settings = this.getResolverSettings();
        return JSON.stringify([
            this.cacheGeneration,
            settings.resolutionMode,
            settings.timeout,
            settings.headlessLookupBase,
            settings.resolvers.map(resolver => this.getResolverKey(resolver))
        ]);
    }

    async resolveHNSDomain(domain, options = {}) {
        const cleanDomain = this.normalizeDomain(domain);
        const cacheKey = cleanDomain.toLowerCase();
        this.throwIfAborted(options.signal);
        const configurationKey = this.getResolutionConfigurationKey();
        const cached = this.cache.get(cacheKey);

        if (cached && cached.configurationKey === configurationKey
            && Date.now() - cached.timestamp < this.cacheTimeout) {
            console.log('HNS resolution cache hit');
            return cached.result;
        }

        const pendingKey = `${configurationKey}|${cacheKey}`;
        let pending = this.pendingResolutions.get(pendingKey);
        if (!pending) {
            const controller = new AbortController();
            pending = { controller, consumers: 0, settled: false };
            const generation = this.cacheGeneration;
            pending.promise = this.resolveUncachedDomain(cleanDomain, { signal: controller.signal })
                .then(result => {
                    if (result && result.resolutionState !== 'temporary-failure'
                        && !controller.signal.aborted && generation === this.cacheGeneration) {
                        this.cache.set(cacheKey, { result, configurationKey, timestamp: Date.now() });
                    }
                    return result;
                }).finally(() => {
                    pending.settled = true;
                    if (this.pendingResolutions.get(pendingKey) === pending) {
                        this.pendingResolutions.delete(pendingKey);
                    }
                });
            this.pendingResolutions.set(pendingKey, pending);
        }

        return this.joinPendingResolution(pendingKey, pending, options.signal);
    }

    joinPendingResolution(pendingKey, pending, signal, pendingStore = this.pendingResolutions) {
        pending.consumers += 1;
        return new Promise((resolve, reject) => {
            let completed = false;
            const finish = (error, result) => {
                if (completed) return;
                completed = true;
                signal?.removeEventListener('abort', abort);
                pending.consumers -= 1;
                if (error) reject(error);
                else resolve(result);
            };
            const abort = () => {
                finish(this.createAbortError());
                // A superseded tab must not cancel another tab's shared lookup.
                if (!pending.settled && pending.consumers === 0) {
                    if (pendingStore.get(pendingKey) === pending) {
                        pendingStore.delete(pendingKey);
                    }
                    pending.controller.abort();
                }
            };
            signal?.addEventListener('abort', abort, { once: true });
            pending.promise.then(result => finish(null, result), error => finish(error));
            if (signal?.aborted) abort();
        });
    }

    async resolveUncachedDomain(cleanDomain, options = {}) {
        try {
            let result = null;
            const settings = this.getResolverSettings();

            if (this.isHeadlessDomain(cleanDomain)) {
                let websiteResponse = null;
                try {
                    result = await this.resolveHeadlessWebRecords(cleanDomain, {
                        ...options, onWebAbsence: response => { websiteResponse = response; }
                    });
                } catch (error) {
                    if (error.name === 'AbortError') throw error;
                    result = this.buildTemporaryResolutionResult(cleanDomain, error);
                }
                if (!result) {
                    result = await this.lookupHeadlessDomain(cleanDomain, {
                        ...options, websiteAbsent: true, websiteResponse
                    });
                }
                if (!result && settings.resolutionMode === 'p2p') {
                    result = await this.resolveP2P(cleanDomain, options);
                }
            } else if (settings.resolutionMode === 'p2p') {
                result = await this.resolveP2P(cleanDomain, options);
            }

            if (!result) {
                result = await this.resolveViaDoh(cleanDomain, options);
            }

            this.throwIfAborted(options.signal);
            return result;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.error('HNS resolution failed:', error.message);
            return this.buildTemporaryResolutionResult(cleanDomain, error);
        }
    }

    async resolveHeadlessWebRecords(domain, options = {}) {
        return this.resolveWebRecordsOnly(domain, options);
    }

    async resolveWebRecordsOnly(domain, options = {}) {
        const response = await this.queryRecordSet(domain, ['A', 'AAAA', 'CNAME'], {
            ...options, optionalTypes: ['TXT']
        });
        if (response.rcode === 3) {
            options.onWebAbsence?.(response);
            return null;
        }
        const records = response.records;
        const hnsProfile = this.parseHnsBioProfile(domain, records.TXT);

        const result = this.buildAddressResult(domain, records, hnsProfile, response)
            || this.buildCnameResult(domain, records, hnsProfile, response);
        if (!result) options.onWebAbsence?.(response);
        return this.attachOptionalProfile(result, domain, response);
    }

    attachOptionalProfile(result, domain, response) {
        if (!result || !response.optionalRecordsPromise) return result;
        const profilePromise = response.optionalRecordsPromise.then(optional => {
            if (optional.error || optional.rcode !== response.rcode) return result.hnsProfile;
            result.records.TXT = optional.records.TXT || [];
            result.hnsProfile = this.parseHnsBioProfile(domain, result.records.TXT);
            return result.hnsProfile;
        }).catch(() => result.hnsProfile);
        // Promises are process-local enrichment, not serializable IPC metadata.
        Object.defineProperty(result, 'profilePromise', { value: profilePromise, enumerable: false });
        return result;
    }

    normalizeDomain(domain) {
        return String(domain || '')
            .trim()
            .replace(/^https?:\/\//i, '')
            .replace(/\/.*$/, '')
            .replace(/\.$/, '')
            .toLowerCase();
    }

    isHeadlessDomain(domain) {
        return domain.endsWith('.agent') || domain.endsWith('.chatbot');
    }

    getHeadlessLinks(domain, data = {}) {
        const manifests = data.manifests || {};
        const profile = data.profile || {};
        const integrations = data.integrations || {};
        const profileUrl = profile.url
            || profile.web_presence?.fallback_url
            || `https://profiles.host.limo/${domain}`;
        const manifestUrl = manifests.agent_json || `https://headlessdomains.com/manifests/${domain}.json`;
        const actionsUrl = data.actions_url
            || profile.actions_url
            || integrations.action_manager?.url
            || `https://headlessdomains.com/actions/${encodeURIComponent(domain)}`;

        return {
            profileUrl,
            actionsUrl,
            manifestUrl
        };
    }

    async fetchHeadlessMetadata(domain, options = {}) {
        const settings = this.getResolverSettings();
        const url = new URL(encodeURIComponent(domain), settings.headlessLookupBase);
        return this.fetchJson(url.toString(), settings.timeout, {}, options);
    }

    buildTemporaryResolutionResult(domain, error) {
        return {
            domain,
            source: 'hns-resolver',
            resolutionState: 'temporary-failure',
            temporaryFailure: true,
            error: {
                code: error?.code || error?.rcodeName || 'RESOLVER_FAILURE',
                message: error?.message || 'HNS resolution temporarily failed',
                attempts: Array.isArray(error?.attempts) ? error.attempts : []
            },
            headlessLinks: this.isHeadlessDomain(domain) ? this.getHeadlessLinks(domain) : null,
            records: {}
        };
    }

    async lookupHeadlessDomain(domain, options = {}) {
        let websiteResponse = options.websiteResponse || null;
        if (options.websiteAbsent !== true) {
            try {
                const webResult = await this.resolveHeadlessWebRecords(domain, {
                    ...options, onWebAbsence: response => { websiteResponse = response; }
                });
                if (webResult) {
                    return webResult;
                }
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                return this.buildTemporaryResolutionResult(domain, error);
            }
        }

        try {
            const data = await this.fetchHeadlessMetadata(domain, options);
            // Identity metadata is authoritative only after a no-web response.
            // Its optional TXT profile must not add another network deadline.
            const hnsProfile = this.parseHnsBioProfile(domain, websiteResponse?.records.TXT || []);
            const manifests = data.manifests || {};
            const profile = data.profile || {};
            const integrations = data.integrations || {};
            const arpChat = integrations.arp_chat || {};
            const redirectUrl = manifests.agent_json || manifests.skill_md || profile.url || arpChat.url;
            const headlessLinks = this.getHeadlessLinks(domain, data);

            const result = {
                domain,
                source: 'headlessdomains',
                resolutionState: 'authoritative-absence',
                url: redirectUrl || `https://headlessdomains.com/${domain}`,
                headlessLinks,
                hnsProfile,
                records: { metadata: data, TXT: websiteResponse?.records.TXT || [] }
            };
            return websiteResponse ? this.attachOptionalProfile(result, domain, websiteResponse) : result;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.log('HeadlessDomains lookup failed:', error.message);
            return null;
        }
    }

    async resolveViaDoh(domain, options = {}) {
        const response = await this.queryRecordSet(domain, ['A', 'AAAA', 'CNAME'], {
            ...options, optionalTypes: ['TXT']
        });
        if (response.rcode === 3) {
            return null;
        }
        const records = response.records;
        const hnsProfile = this.parseHnsBioProfile(domain, records.TXT);
        const webResult = this.buildAddressResult(domain, records, hnsProfile, response)
            || this.buildCnameResult(domain, records, hnsProfile, response);
        if (webResult) {
            return this.attachOptionalProfile(webResult, domain, response);
        }

        if (options.preferWebRecords) return null;
        // TXT redirects remain supported only after authoritative web absence,
        // and come from the same endpoint rather than another operator's root.
        const optional = await response.optionalRecordsPromise;
        if (optional.error) throw optional.error;
        if (optional.rcode !== response.rcode) {
            throw new Error('Inconsistent DNS status between website and TXT records');
        }
        records.TXT = optional.records.TXT;
        const txtProfile = this.parseHnsBioProfile(domain, records.TXT);

        const redirectUrl = this.findUrlInTxt(records.TXT);
        if (redirectUrl) {
            return {
                domain,
                ...this.getResolutionMetadata(response),
                url: redirectUrl,
                hnsProfile: txtProfile,
                records
            };
        }

        if (records.TXT.length > 0) {
            return {
                domain,
                ...this.getResolutionMetadata(response),
                hnsProfile: txtProfile,
                records
            };
        }

        return null;
    }

    async resolveHnsBioProfile(domain) {
        const response = await this.queryRecordSet(domain, ['TXT']);
        return response.rcode === 3 ? null : this.parseHnsBioProfile(domain, response.records.TXT);
    }

    getResolutionMetadata(response) {
        const resolver = this.getPublicResolverInfo(response?.resolver);
        return {
            source: resolver ? `hns:${resolver.id}` : 'hns-resolver',
            resolver,
            resolverFallbackCount: response?.fallbackCount || 0,
            resolverAttempts: Array.isArray(response?.attempts) ? response.attempts : []
        };
    }

    buildCnameResult(domain, records, hnsProfile = null, response = null) {
        if (!records.CNAME.length) {
            return null;
        }

        return {
            domain,
            ...this.getResolutionMetadata(response),
            url: `http://${records.CNAME[0]}`,
            canonicalName: records.CNAME[0],
            hnsProfile,
            records
        };
    }

    buildAddressResult(domain, records, hnsProfile = null, response = null) {
        if (!records.A.length && !records.AAAA.length) {
            return null;
        }

        return {
            domain,
            ...this.getResolutionMetadata(response),
            url: `http://${domain}`,
            address: records.A[0] || records.AAAA[0],
            addressType: records.A.length > 0 ? 'A' : 'AAAA',
            hnsProfile,
            records
        };
    }

    parseHnsBioProfile(domain, txtRecords) {
        const entries = [];

        for (const rawRecord of txtRecords) {
            const record = String(rawRecord || '').trim().replace(/^"|"$/g, '');
            const match = record.match(/^([a-z0-9_-]+)\s*[:=]\s*(.+)$/i);
            if (!match) {
                continue;
            }

            const key = match[1].toLowerCase();
            const value = match[2].trim().replace(/^"|"$/g, '');
            if (!HNS_BIO_PREFIXES.has(key) || !value) {
                continue;
            }

            entries.push({
                key,
                label: HNS_BIO_LABELS[key] || key,
                value
            });
        }

        if (!entries.length) {
            return null;
        }

        return {
            standard: 'hns.bio',
            domain,
            entries
        };
    }

    getRcodeName(rcode) {
        return DNS_RCODE_NAMES[rcode] || `RCODE_${rcode}`;
    }

    createDnsResponseError(rcode, message = '') {
        const rcodeName = this.getRcodeName(rcode);
        const error = new Error(message || `DNS ${rcodeName}`);
        error.code = 'DNS_RESPONSE_ERROR';
        error.rcode = rcode;
        error.rcodeName = rcodeName;
        return error;
    }

    async queryRecordSet(domain, typeNames, options = {}) {
        const cleanDomain = this.normalizeDomain(domain);
        const requestedTypes = [...new Set(typeNames)].filter(type => DNS_TYPES[type]);
        if (!cleanDomain || !requestedTypes.length) {
            throw new Error('A valid DNS name and record type are required');
        }

        const settings = this.getResolverSettings();
        const timeout = options.timeout || settings.timeout;
        this.throwIfAborted(options.signal);
        const optionalTypes = [...new Set(options.optionalTypes || [])]
            .filter(type => DNS_TYPES[type] && !requestedTypes.includes(type));
        // A TLSA capability or DNSSEC failure must not cool down an otherwise
        // healthy website resolver, nor inherit a previous website cooldown.
        const healthScope = requestedTypes.includes('TLSA') ? 'TLSA' : '';
        const candidateState = this.getResolverCandidateState({ ...options, healthScope });
        const attempts = candidateState.cooling.map(candidate => ({
            resolver: this.getPublicResolverInfo(candidate.resolver),
            status: 'COOLDOWN',
            elapsedMs: 0,
            configuredIndex: candidate.configuredIndex,
            retryAt: new Date(candidate.retryAt).toISOString()
        }));
        if (!candidateState.available.length) {
            const error = new Error('All configured HNS resolvers are temporarily cooling down');
            error.code = 'RESOLVER_COOLDOWN';
            error.attempts = attempts;
            throw error;
        }

        const failures = [];
        for (const candidate of candidateState.available) {
            const { resolver, configuredIndex } = candidate;
            const startedAt = Date.now();
            const controller = new AbortController();
            const abort = () => controller.abort();
            options.signal?.addEventListener('abort', abort, { once: true });
            let optionalRecordsPromise = null;
            try {
                this.throwIfAborted(options.signal);
                if (options.requireAuthenticated && new URL(resolver.url).protocol !== 'https:') {
                    const error = new Error('TLSA verification requires an authenticated HTTPS resolver connection');
                    error.code = 'INSECURE_TLSA_TRANSPORT';
                    throw error;
                }
                let optionalRecords = null;
                if (optionalTypes.length) {
                    // Always observe optional failures, even after a native
                    // website has already returned to its consumers.
                    optionalRecordsPromise = Promise.all(optionalTypes.map(typeName =>
                        this.queryResolver(resolver, cleanDomain, typeName, timeout, { signal: controller.signal })
                    )).then(responses => {
                        const rcodes = new Set(responses.map(response => response.rcode));
                        const rcode = responses[0]?.rcode ?? 0;
                        if (rcodes.size > 1 || (rcode !== 0 && rcode !== 3)) {
                            throw this.createDnsResponseError(rcode);
                        }
                        optionalRecords = {
                            records: Object.fromEntries(optionalTypes.map((type, index) => [type, responses[index].records])),
                            rcode
                        };
                        return optionalRecords;
                    }).catch(error => ({ error, records: {}, rcode: null }));
                }
                const responses = await Promise.all(requestedTypes.map(typeName =>
                    this.queryResolver(resolver, cleanDomain, typeName, timeout, { signal: controller.signal })
                ));
                this.throwIfAborted(options.signal);
                const rcodes = new Set(responses.map(response => response.rcode));
                if (rcodes.size > 1) {
                    throw new Error(`Inconsistent DNS status across record types: ${[...rcodes].map(code => this.getRcodeName(code)).join(', ')}`);
                }

                const rcode = responses[0]?.rcode ?? 0;
                if (rcode !== 0 && rcode !== 3) {
                    throw this.createDnsResponseError(rcode);
                }
                const authenticated = responses.every(response => response.authenticated === true);
                if (options.requireAuthenticated && !authenticated) {
                    const error = new Error('HNS resolver did not authenticate the TLSA answer with DNSSEC');
                    error.code = 'DNSSEC_UNAUTHENTICATED';
                    throw error;
                }

                const records = Object.fromEntries([...requestedTypes, ...optionalTypes].map(type => [type, []]));
                responses.forEach((response, responseIndex) => {
                    records[requestedTypes[responseIndex]] = response.records;
                });
                if (optionalRecords?.rcode === rcode) Object.assign(records, optionalRecords.records);
                const elapsedMs = Date.now() - startedAt;
                this.markResolverSuccess(resolver, elapsedMs, this.getRcodeName(rcode), configuredIndex, healthScope);
                attempts.push({
                    resolver: this.getPublicResolverInfo(resolver),
                    status: this.getRcodeName(rcode),
                    elapsedMs,
                    configuredIndex
                });
                return {
                    domain: cleanDomain,
                    records,
                    rcode,
                    rcodeName: this.getRcodeName(rcode),
                    authenticated,
                    resolver,
                    fallbackCount: configuredIndex,
                    elapsedMs,
                    attempts: attempts.sort((left, right) => left.configuredIndex - right.configuredIndex),
                    optionalRecordsPromise
                };
            } catch (error) {
                // Failover abandons all siblings for the failed endpoint.
                controller.abort();
                if (error.name === 'AbortError' || options.signal?.aborted) throw this.createAbortError();
                const elapsedMs = Date.now() - startedAt;
                this.markResolverFailure(resolver, error, elapsedMs, healthScope);
                attempts.push({
                    resolver: this.getPublicResolverInfo(resolver),
                    status: error.rcodeName || error.code || 'ERROR',
                    elapsedMs,
                    configuredIndex,
                    message: error.message
                });
                failures.push(`${resolver.id}: ${error.message}`);
            } finally {
                if (optionalRecordsPromise) {
                    optionalRecordsPromise.then(() => options.signal?.removeEventListener('abort', abort));
                } else {
                    options.signal?.removeEventListener('abort', abort);
                }
            }
        }

        const error = new Error(failures.join('; ') || `No HNS resolver available for ${cleanDomain}`);
        error.code = 'RESOLVER_FAILURE';
        error.attempts = attempts.sort((left, right) => left.configuredIndex - right.configuredIndex);
        throw error;
    }

    async queryResolver(resolverInput, domain, typeName, timeout, options = {}) {
        const resolver = normalizeResolverDescriptor(resolverInput);
        if (!resolver) {
            throw new Error('Invalid resolver configuration');
        }
        if (resolver.transport === 'dns-json') {
            return this.queryDnsJson(resolver, domain, typeName, timeout, options);
        }
        return this.queryDohResponse(resolver.url, domain, typeName, timeout, options);
    }

    async queryDoh(resolverUrl, domain, typeName, timeout) {
        const response = await this.queryDohResponse(resolverUrl, domain, typeName, timeout);
        if (response.rcode !== 0 && response.rcode !== 3) {
            throw this.createDnsResponseError(response.rcode);
        }
        return response.records;
    }

    async queryDohResponse(resolverUrl, domain, typeName, timeout, options = {}) {
        const resolver = this.normalizeDohResolver(resolverUrl);
        if (!resolver) {
            throw new Error(`Invalid DoH resolver: ${resolverUrl}`);
        }
        if (!DNS_TYPES[typeName]) {
            throw new Error(`Unsupported DNS record type: ${typeName}`);
        }
        const query = this.buildDnsQuery(domain, DNS_TYPES[typeName]);
        const url = new URL(resolver);
        url.searchParams.set('dns', query.toString('base64url'));

        const buffer = await this.fetchBuffer(url.toString(), timeout, {
            Accept: 'application/dns-message',
            'User-Agent': 'SkyInclude/1.0.0'
        }, { ...options, maxBytes: 65535 });

        return this.parseDnsResponseMessage(buffer, typeName, {
            id: query.readUInt16BE(0),
            domain,
            qtype: DNS_TYPES[typeName]
        });
    }

    async queryDnsJson(resolverInput, domain, typeName, timeout, options = {}) {
        const resolver = normalizeResolverDescriptor(resolverInput);
        if (!resolver || resolver.transport !== 'dns-json') {
            throw new Error('Invalid DNS JSON resolver');
        }
        if (!DNS_TYPES[typeName]) {
            throw new Error(`Unsupported DNS record type: ${typeName}`);
        }

        const url = new URL(resolver.url);
        url.searchParams.set('name', this.normalizeDomain(domain));
        url.searchParams.set('type', typeName);
        if (typeName === 'TLSA') {
            url.searchParams.set('do', 'true');
            url.searchParams.set('cd', 'false');
        }
        const data = await this.fetchJson(url.toString(), timeout, {
            Accept: 'application/dns-json',
            'User-Agent': 'SkyInclude/1.0.0'
        }, { ...options, maxBytes: 262144 });
        return this.parseDnsJsonResponse(data, domain, typeName);
    }

    parseDnsJsonResponse(data, domain, typeName) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Malformed DNS JSON response');
        }

        const rcode = Number(data.Status);
        if (!Number.isInteger(rcode) || rcode < 0 || rcode > 15) {
            throw new Error('DNS JSON response is missing a valid Status');
        }

        const questions = Array.isArray(data.Question) ? data.Question : [];
        if (questions.length !== 1) {
            throw new Error('DNS JSON response must contain exactly one Question');
        }

        const question = questions[0] || {};
        const questionName = this.normalizeDomain(question.name);
        const questionType = Number(question.type);
        if (questionName !== this.normalizeDomain(domain) || questionType !== DNS_TYPES[typeName]) {
            throw new Error('DNS JSON Question does not match the request');
        }

        if (rcode !== 0 && rcode !== 3) {
            throw this.createDnsResponseError(rcode);
        }

        const records = rcode === 3
            ? []
            : this.parseDnsJsonAnswers(data.Answer, typeName);
        return {
            records,
            rcode,
            rcodeName: this.getRcodeName(rcode),
            authenticated: data.AD === true && data.CD !== true
        };
    }

    parseDnsJsonAnswers(answers, typeName) {
        if (answers !== undefined && !Array.isArray(answers)) {
            throw new Error('DNS JSON Answer must be an array');
        }

        const expectedType = DNS_TYPES[typeName];
        return (answers || [])
            .filter(answer => Number(answer?.type) === expectedType)
            .map(answer => {
                const record = this.parseDnsJsonRecord(answer?.data, typeName);
                if (!record) {
                    throw new Error(`Malformed ${typeName} record in DNS JSON response`);
                }
                return record;
            });
    }

    parseDnsJsonRecord(value, typeName) {
        const data = String(value ?? '').trim();
        if (!data) {
            return null;
        }

        if (typeName === 'A') {
            return net.isIP(data) === 4 ? data : null;
        }
        if (typeName === 'AAAA') {
            return net.isIP(data) === 6 ? data : null;
        }
        if (typeName === 'CNAME') {
            const name = this.normalizeDomain(data);
            return this.isValidDnsName(name) ? name : null;
        }
        if (typeName === 'TXT') {
            return this.parseDnsJsonTxt(data);
        }
        if (typeName === 'TLSA') {
            const match = data.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([0-9a-f]+)$/i);
            if (!match) {
                return null;
            }
            return {
                usage: Number(match[1]),
                selector: Number(match[2]),
                matchingType: Number(match[3]),
                certificateAssociationData: match[4].toLowerCase()
            };
        }
        return null;
    }

    parseDnsJsonTxt(data) {
        if (!data.startsWith('"')) {
            return data;
        }

        const chunks = [];
        const pattern = /"((?:\\.|[^"\\])*)"/g;
        let match;
        while ((match = pattern.exec(data)) !== null) {
            try {
                chunks.push(JSON.parse(`"${match[1]}"`));
            } catch (error) {
                throw new Error('Malformed quoted TXT record');
            }
        }
        return chunks.length ? chunks.join('') : null;
    }

    isValidDnsName(name) {
        return Boolean(name)
            && name.length <= 253
            && name.split('.').every(label => label.length <= 63
                && /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/i.test(label));
    }

    buildDnsQuery(name, qtype) {
        const cleanName = this.normalizeDomain(name);
        if (!this.isValidDnsName(cleanName)) {
            throw new Error(`Invalid DNS name: ${name}`);
        }
        const queryId = Math.floor(Math.random() * 65535);
        const header = Buffer.alloc(12);
        header.writeUInt16BE(queryId, 0);
        // Ask the validating recursive resolver for authenticated data (AD)
        // and DNSSEC records (EDNS DO), without disabling validation (CD).
        // This advertises DNSSEC support and exposes the validation status
        // needed before trusting a TLSA certificate match. Upstream transport
        // failures remain retryable regardless of these request flags.
        header.writeUInt16BE(0x0120, 2);
        header.writeUInt16BE(1, 4);
        header.writeUInt16BE(1, 10);

        const labels = [];
        for (const part of cleanName.split('.')) {
            const label = Buffer.from(part, 'ascii');
            labels.push(Buffer.from([label.length]), label);
        }
        labels.push(Buffer.from([0]));

        const tail = Buffer.alloc(4);
        tail.writeUInt16BE(qtype, 0);
        tail.writeUInt16BE(1, 2);

        const edns = Buffer.from('00002904d0000080000000', 'hex');
        return Buffer.concat([header, ...labels, tail, edns]);
    }

    parseDnsResponse(buffer, typeName) {
        return this.parseDnsResponseMessage(buffer, typeName).records;
    }

    parseDnsResponseMessage(buffer, typeName, expected = null) {
        if (buffer.length < 12) {
            throw new Error('DNS response is shorter than its header');
        }

        let offset = 12;
        const responseId = buffer.readUInt16BE(0);
        const flags = buffer.readUInt16BE(2);
        const qdcount = buffer.readUInt16BE(4);
        const ancount = buffer.readUInt16BE(6);
        const rcode = flags & 0x000f;
        const authenticated = (flags & 0x0020) !== 0 && (flags & 0x0010) === 0;
        const results = [];

        if ((flags & 0x8000) === 0) {
            throw new Error('DNS message is not a response');
        }
        if ((flags & 0x0200) !== 0) {
            throw new Error('Truncated DNS response');
        }
        if (expected?.id !== undefined && responseId !== expected.id) {
            throw new Error('DNS response transaction ID does not match the request');
        }
        if (expected && qdcount !== 1) {
            throw new Error('DNS response must contain exactly one Question');
        }

        for (let i = 0; i < qdcount; i += 1) {
            const questionName = this.readDnsName(buffer, offset);
            if (questionName.offset + 4 > buffer.length) {
                throw new Error('Malformed DNS Question');
            }
            const questionType = buffer.readUInt16BE(questionName.offset);
            const questionClass = buffer.readUInt16BE(questionName.offset + 2);
            offset = questionName.offset + 4;
            if (expected && (
                this.normalizeDomain(questionName.name) !== this.normalizeDomain(expected.domain)
                || questionType !== expected.qtype
                || questionClass !== 1
            )) {
                throw new Error('DNS Question does not match the request');
            }
        }

        if (rcode !== 0 && rcode !== 3) {
            throw this.createDnsResponseError(rcode);
        }
        if (rcode === 3) {
            return { records: [], rcode, rcodeName: this.getRcodeName(rcode), authenticated };
        }

        let parsedAnswers = 0;
        for (let i = 0; i < ancount && offset < buffer.length; i += 1) {
            const answerName = this.readDnsName(buffer, offset);
            offset = answerName.offset;

            if (offset + 10 > buffer.length) {
                throw new Error('Malformed DNS answer metadata');
            }

            const type = buffer.readUInt16BE(offset);
            offset += 2;
            offset += 2;
            offset += 4;
            const rdlength = buffer.readUInt16BE(offset);
            offset += 2;

            if (offset + rdlength > buffer.length) {
                throw new Error('DNS answer exceeds response length');
            }

            const rdataStart = offset;
            const rdata = buffer.subarray(offset, offset + rdlength);

            if (typeName === 'A' && type === DNS_TYPES.A) {
                if (rdlength !== 4) throw new Error('Malformed A record');
                results.push(Array.from(rdata).join('.'));
            } else if (typeName === 'AAAA' && type === DNS_TYPES.AAAA) {
                if (rdlength !== 16) throw new Error('Malformed AAAA record');
                results.push(this.formatIpv6(rdata));
            } else if (typeName === 'TXT' && type === DNS_TYPES.TXT) {
                results.push(this.parseTxtRecord(rdata).join(''));
            } else if (typeName === 'CNAME' && type === DNS_TYPES.CNAME) {
                const cname = this.normalizeDomain(this.readDnsName(buffer, rdataStart).name);
                if (!this.isValidDnsName(cname)) throw new Error('Malformed CNAME record');
                results.push(cname);
            } else if (typeName === 'TLSA' && type === DNS_TYPES.TLSA) {
                const record = this.parseTlsaRecord(rdata);
                if (!record) throw new Error('Malformed TLSA record');
                results.push(record);
            }

            offset += rdlength;
            parsedAnswers += 1;
        }

        if (parsedAnswers !== ancount) {
            throw new Error('DNS response ended before all answers were parsed');
        }

        return {
            records: results.filter(Boolean),
            rcode,
            rcodeName: this.getRcodeName(rcode),
            authenticated
        };
    }

    readDnsName(buffer, startOffset) {
        const labels = [];
        let offset = startOffset;
        let jumped = false;
        let nextOffset = startOffset;
        const seen = new Set();

        while (offset < buffer.length) {
            if (seen.has(offset)) {
                throw new Error('DNS compression loop detected');
            }
            seen.add(offset);

            const length = buffer[offset];
            if (length === 0) {
                offset += 1;
                if (!jumped) {
                    nextOffset = offset;
                }
                break;
            }

            if ((length & 0xc0) === 0xc0) {
                if (offset + 1 >= buffer.length) {
                    throw new Error('Truncated DNS compression pointer');
                }
                const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
                if (pointer >= buffer.length) {
                    throw new Error('DNS compression pointer exceeds response length');
                }
                if (!jumped) {
                    nextOffset = offset + 2;
                }
                offset = pointer;
                jumped = true;
                continue;
            }

            if (length > 63 || offset + 1 + length > buffer.length) {
                throw new Error('Malformed DNS label');
            }

            offset += 1;
            labels.push(buffer.subarray(offset, offset + length).toString('ascii'));
            offset += length;
            if (!jumped) {
                nextOffset = offset;
            }
        }

        return {
            name: labels.join('.'),
            offset: nextOffset
        };
    }

    parseTxtRecord(buffer) {
        const records = [];
        let offset = 0;

        while (offset < buffer.length) {
            const length = buffer[offset];
            offset += 1;
            if (offset + length > buffer.length) {
                throw new Error('Malformed TXT record');
            }
            records.push(buffer.subarray(offset, offset + length).toString('utf8'));
            offset += length;
        }

        return records;
    }

    parseTlsaRecord(buffer) {
        if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
            return null;
        }

        return {
            usage: buffer[0],
            selector: buffer[1],
            matchingType: buffer[2],
            certificateAssociationData: buffer.subarray(3).toString('hex').toLowerCase()
        };
    }

    buildTlsaName(domain, port = 443) {
        const servicePort = Number(port);
        if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65535) {
            throw new Error('Invalid TLSA service port');
        }
        return `_${servicePort}._tcp.${this.normalizeDomain(domain)}`;
    }

    async resolveTLSARecords(domain, options = {}) {
        this.throwIfAborted(options.signal);
        const tlsaName = this.buildTlsaName(domain, options.port);
        const candidateKey = normalizeResolverList([
            options.resolver,
            options.dohResolver,
            ...this.getResolverSettings().resolvers
        ]).map(resolver => this.getResolverKey(resolver)).join(',');
        const cacheKey = `${candidateKey}|${tlsaName}`.toLowerCase();
        if (options.force) {
            // Refresh revokes old trust immediately, even if every resolver
            // subsequently fails. An older request cannot restore that trust.
            this.tlsaCache.delete(cacheKey);
            this.pendingTLSAResolutions.get(cacheKey)?.controller.abort();
            this.pendingTLSAResolutions.delete(cacheKey);
        }
        const cached = this.tlsaCache.get(cacheKey);

        if (!options.force && cached?.authenticated === true
            && Date.now() - cached.timestamp < this.tlsaCacheTimeout) {
            return cached.records;
        }

        let pending = this.pendingTLSAResolutions.get(cacheKey);
        if (!pending || pending.generation !== this.cacheGeneration) {
            const controller = new AbortController();
            const revision = Symbol('TLSA request');
            this.tlsaRevisions.set(cacheKey, revision);
            pending = { controller, consumers: 0, settled: false, generation: this.cacheGeneration };
            pending.promise = this.queryRecordSet(tlsaName, ['TLSA'], {
                ...options,
                signal: controller.signal,
                requireAuthenticated: true,
                ignoreCooldown: options.force === true
            }).then(response => {
                // Also reject stale callers if their transport ignored abort.
                // Merely suppressing the cache write could still authorize an
                // obsolete certificate in the waiting navigation.
                if (controller.signal.aborted || this.tlsaRevisions.get(cacheKey) !== revision) {
                    throw this.createAbortError();
                }
                const records = response.rcode === 3 ? [] : response.records.TLSA;
                if (pending.generation === this.cacheGeneration) {
                    this.tlsaCache.set(cacheKey, {
                        records,
                        authenticated: true,
                        resolver: this.getPublicResolverInfo(response.resolver),
                        timestamp: Date.now()
                    });
                }
                return records;
            }).finally(() => {
                pending.settled = true;
                if (this.pendingTLSAResolutions.get(cacheKey) === pending) {
                    this.pendingTLSAResolutions.delete(cacheKey);
                }
            });
            this.pendingTLSAResolutions.set(cacheKey, pending);
        }
        return this.joinPendingResolution(cacheKey, pending, options.signal, this.pendingTLSAResolutions);
    }

    isSupportedTlsaRecord(record) {
        return Boolean(record)
            && record.usage === SUPPORTED_TLSA.usage
            && record.selector === SUPPORTED_TLSA.selector
            && record.matchingType === SUPPORTED_TLSA.matchingType
            && typeof record.certificateAssociationData === 'string'
            && /^[0-9a-f]+$/i.test(record.certificateAssociationData)
            && record.certificateAssociationData.length === 64;
    }

    getCertificateDate(certificate, snakeKey, camelKey) {
        return certificate?.[snakeKey] || certificate?.[camelKey] || null;
    }

    normalizeCertificateDate(value) {
        if (!value) {
            return null;
        }

        const timestamp = new Date(value).getTime();
        return Number.isNaN(timestamp) ? null : timestamp;
    }

    getCertificateSpkiDer(certificate) {
        if (!certificate) {
            return null;
        }

        const directSpki = certificate.spkiDer || certificate.publicKeyDer || certificate.publicKeyRaw;
        if (directSpki) {
            return Buffer.isBuffer(directSpki) ? directSpki : Buffer.from(directSpki);
        }

        if (certificate.raw) {
            try {
                const x509 = new crypto.X509Certificate(certificate.raw);
                return x509.publicKey.export({ type: 'spki', format: 'der' });
            } catch (error) {
                return null;
            }
        }

        return null;
    }

    hashCertificateMaterial(certificate, selector, matchingType) {
        if (selector !== SUPPORTED_TLSA.selector || matchingType !== SUPPORTED_TLSA.matchingType) {
            return null;
        }

        const spkiDer = this.getCertificateSpkiDer(certificate);
        if (!spkiDer) {
            return null;
        }

        return crypto.createHash('sha256').update(spkiDer).digest('hex');
    }

    formatIpv6(buffer) {
        const parts = [];
        for (let i = 0; i < 16; i += 2) {
            parts.push(buffer.readUInt16BE(i).toString(16));
        }
        return parts.join(':');
    }

    findUrlInTxt(records) {
        for (const record of records) {
            const match = record.match(/https?:\/\/[^\s"']+/);
            if (match) {
                return match[0];
            }
        }

        return null;
    }

    async fetchJson(url, timeout, headers = {}, options = {}) {
        const buffer = await this.fetchBuffer(url, timeout, {
            Accept: 'application/json',
            'User-Agent': 'SkyInclude/1.0.0',
            ...headers
        }, options);
        try {
            return JSON.parse(buffer.toString('utf8'));
        } catch (error) {
            throw new Error('Response was not valid JSON');
        }
    }

    fetchBuffer(url, timeout, headers = {}, options = {}) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
                reject(new Error('Unsupported HTTP request protocol'));
                return;
            }
            if (options.signal?.aborted) {
                reject(this.createAbortError());
                return;
            }
            const client = parsedUrl.protocol === 'https:' ? https : http;
            const deadlineMs = Number.isFinite(Number(timeout)) && Number(timeout) > 0
                ? Number(timeout) : this.getResolverSettings().timeout;
            const maxBytes = options.maxBytes || 1048576;
            let request = null;
            let response = null;
            let settled = false;
            const finish = (error, buffer) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                options.signal?.removeEventListener('abort', abort);
                if (error) {
                    request?.destroy();
                    response?.destroy();
                    reject(error);
                } else resolve(buffer);
            };
            const abort = () => finish(this.createAbortError());
            const deadline = setTimeout(() => {
                const error = new Error('Request deadline exceeded');
                error.code = 'REQUEST_TIMEOUT';
                finish(error);
            }, deadlineMs);
            options.signal?.addEventListener('abort', abort, { once: true });
            const tooLarge = () => {
                const error = new Error(`Response exceeds ${maxBytes} bytes`);
                error.code = 'RESPONSE_TOO_LARGE';
                finish(error);
            };
            try {
                request = client.get(parsedUrl, { headers }, incoming => {
                    response = incoming;
                    const chunks = [];
                    let receivedBytes = 0;
                    response.on('error', error => finish(error));
                    response.on('aborted', () => {
                        const error = new Error('Response aborted before completion');
                        error.code = 'RESPONSE_ABORTED';
                        finish(error);
                    });
                    response.on('close', () => {
                        if (!response.complete && !settled) {
                            const error = new Error('Response closed before completion');
                            error.code = 'RESPONSE_ABORTED';
                            finish(error);
                        }
                    });
                    if (Number(response.headers['content-length']) > maxBytes) {
                        tooLarge();
                        return;
                    }

                    response.on('data', chunk => {
                        receivedBytes += chunk.length;
                        if (receivedBytes > maxBytes) tooLarge();
                        else if (!settled) chunks.push(chunk);
                    });
                    response.on('end', () => {
                        if (settled) return;
                        const buffer = Buffer.concat(chunks);
                        if (response.statusCode < 200 || response.statusCode >= 300) {
                            const error = new Error(`HTTP ${response.statusCode}: ${buffer.toString('utf8').slice(0, 120)}`);
                            error.code = `HTTP_${response.statusCode}`;
                            finish(error);
                            return;
                        }
                        finish(null, buffer);
                    });
                });

                request.on('error', error => finish(error));
                if (options.signal?.aborted) abort();
            } catch (error) {
                finish(error);
            }
        });
    }

    async resolveAPI(domain, options = {}) {
        return this.resolveHNSDomain(domain, options);
    }

    async resolveP2P(domain, options = {}) {
        console.log('P2P HNS resolution not implemented, using public DoH');
        return this.resolveViaDoh(this.normalizeDomain(domain), options);
    }

    async verifyDANE(domain, certificate, options = {}) {
        const cleanDomain = this.normalizeDomain(domain);
        const tlsaName = this.buildTlsaName(cleanDomain, options.port);
        const baseResult = {
            state: 'disabled',
            domain: cleanDomain,
            tlsaName,
            supportedRecords: 0,
            unsupportedRecords: 0,
            matchedRecord: null,
            error: null
        };

        if (!options.force && !this.getResolverSettings().enableDANE) {
            return baseResult;
        }

        let records = [];
        try {
            records = Array.isArray(options.records)
                ? options.records
                : await this.resolveTLSARecords(cleanDomain, options);
        } catch (error) {
            return {
                ...baseResult,
                state: 'resolver_failure',
                error: error.message
            };
        }

        if (!records.length) {
            return {
                ...baseResult,
                state: 'no_tlsa'
            };
        }

        if (!certificate) {
            return {
                ...baseResult,
                state: 'connection_failure',
                error: 'No certificate was provided for DANE verification'
            };
        }

        const supported = records.filter(record => this.isSupportedTlsaRecord(record));
        const unsupported = records.length - supported.length;
        const withCounts = {
            ...baseResult,
            supportedRecords: supported.length,
            unsupportedRecords: unsupported
        };

        if (!supported.length) {
            return {
                ...withCounts,
                state: 'unsupported_record'
            };
        }

        const now = Date.now();
        const validFrom = this.normalizeCertificateDate(this.getCertificateDate(certificate, 'valid_from', 'validFrom'));
        if (validFrom && validFrom > now) {
            return {
                ...withCounts,
                state: 'cert_not_yet_valid'
            };
        }

        const validTo = this.normalizeCertificateDate(this.getCertificateDate(certificate, 'valid_to', 'validTo'));
        if (validTo && validTo < now) {
            return {
                ...withCounts,
                state: 'cert_expired'
            };
        }

        for (const record of supported) {
            const hash = this.hashCertificateMaterial(certificate, record.selector, record.matchingType);
            if (hash && hash === record.certificateAssociationData.toLowerCase()) {
                return {
                    ...withCounts,
                    state: 'verified',
                    matchedRecord: record
                };
            }
        }

        return {
            ...withCounts,
            state: 'tlsa_mismatch'
        };
    }

    async checkTraditionalDNS(domain) {
        try {
            const addresses = await dns.lookup(domain, { all: true });
            return addresses && addresses.length > 0 ? `https://${domain}` : null;
        } catch (error) {
            return null;
        }
    }

    updateSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        this.clearCache();
    }

    clearCache() {
        this.cacheGeneration += 1;
        this.cache.clear();
        this.tlsaCache.clear();
        this.resolverHealth.clear();
    }

    getCacheStats() {
        return {
            size: this.cache.size,
            tlsaSize: this.tlsaCache.size,
            unhealthyResolvers: this.resolverHealth.size
        };
    }

    getResolverDiagnostics() {
        return this.resolverDiagnostics.map(entry => ({
            ...entry,
            resolver: entry.resolver ? { ...entry.resolver } : null
        }));
    }
}

const resolver = new HNSResolver();

module.exports = {
    HNSResolver,
    resolveHNSDomain: (domain, options) => resolver.resolveHNSDomain(domain, options),
    verifyDANE: (domain, cert) => resolver.verifyDANE(domain, cert),
    checkTraditionalDNS: domain => resolver.checkTraditionalDNS(domain),
    updateSettings: settings => resolver.updateSettings(settings),
    clearCache: () => resolver.clearCache(),
    getCacheStats: () => resolver.getCacheStats(),
    getResolverDiagnostics: () => resolver.getResolverDiagnostics()
};
