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
        this.tlsaCache = new Map();
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
            const health = this.resolverHealth.get(this.getResolverKey(resolver));
            if (health && health.retryAt > now) {
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

    markResolverFailure(resolver, error, elapsedMs) {
        const key = this.getResolverKey(resolver);
        this.resolverHealth.set(key, {
            retryAt: Date.now() + this.resolverCooldownMs,
            error: error.message
        });
        this.recordResolverDiagnostic({
            event: 'failure',
            resolver: this.getPublicResolverInfo(resolver),
            elapsedMs,
            status: error.rcodeName || error.code || 'ERROR',
            message: error.message
        });
    }

    markResolverSuccess(resolver, elapsedMs, rcodeName, fallbackCount) {
        this.resolverHealth.delete(this.getResolverKey(resolver));
        this.recordResolverDiagnostic({
            event: 'success',
            resolver: this.getPublicResolverInfo(resolver),
            elapsedMs,
            status: rcodeName,
            fallbackCount
        });
    }

    async resolveHNSDomain(domain) {
        const cleanDomain = this.normalizeDomain(domain);
        const cacheKey = cleanDomain.toLowerCase();
        const cached = this.cache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < this.cacheTimeout) {
            console.log('HNS resolution cache hit');
            return cached.result;
        }

        try {
            let result = null;
            const settings = this.getResolverSettings();

            if (this.isHeadlessDomain(cleanDomain)) {
                result = await this.resolveHeadlessWebRecords(cleanDomain);
                if (!result) {
                    result = await this.lookupHeadlessDomain(cleanDomain);
                }
                if (!result && settings.resolutionMode === 'p2p') {
                    result = await this.resolveP2P(cleanDomain);
                }
            } else if (settings.resolutionMode === 'p2p') {
                result = await this.resolveP2P(cleanDomain);
            }

            if (!result) {
                result = await this.resolveViaDoh(cleanDomain);
            }

            if (result) {
                this.cache.set(cacheKey, {
                    result,
                    timestamp: Date.now()
                });
            }

            return result;
        } catch (error) {
            console.error('HNS resolution failed:', error.message);
            return null;
        }
    }

    async resolveHeadlessWebRecords(domain) {
        const attempts = 5;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                const result = await this.resolveWebRecordsOnly(domain);
                if (result) {
                    return result;
                }
            } catch (error) {
                if (error.code === 'RESOLVER_COOLDOWN') {
                    return null;
                }
            }

            if (attempt < attempts) {
                await new Promise(resolve => setTimeout(resolve, 250 * attempt));
            }
        }

        return null;
    }

    async resolveWebRecordsOnly(domain) {
        const response = await this.queryRecordSet(domain, ['TXT', 'CNAME', 'A', 'AAAA']);
        if (response.rcode === 3) {
            return null;
        }
        const records = response.records;
        const hnsProfile = this.parseHnsBioProfile(domain, records.TXT);

        return this.buildAddressResult(domain, records, hnsProfile, response)
            || this.buildCnameResult(domain, records, hnsProfile, response);
    }

    normalizeDomain(domain) {
        return String(domain || '')
            .trim()
            .replace(/^https?:\/\//, '')
            .replace(/\/.*$/, '')
            .replace(/\.$/, '')
            .toLowerCase();
    }

    isHeadlessDomain(domain) {
        return domain.endsWith('.agent') || domain.endsWith('.chatbot');
    }

    async lookupHeadlessDomain(domain) {
        const settings = this.getResolverSettings();
        const url = new URL(encodeURIComponent(domain), settings.headlessLookupBase);

        try {
            const data = await this.fetchJson(url.toString(), settings.timeout);
            const hnsProfile = await this.resolveHnsBioProfile(domain).catch(() => null);
            const webResult = await this.resolveHeadlessWebRecords(domain).catch(() => null);
            if (webResult) {
                return webResult;
            }
            const manifests = data.manifests || {};
            const profile = data.profile || {};
            const integrations = data.integrations || {};
            const arpChat = integrations.arp_chat || {};
            const redirectUrl = manifests.agent_json || manifests.skill_md || profile.url || arpChat.url;

            if (!redirectUrl) {
                return {
                    domain,
                    source: 'headlessdomains',
                    url: `https://headlessdomains.com/${domain}`,
                    hnsProfile,
                    records: { metadata: data }
                };
            }

            return {
                domain,
                source: 'headlessdomains',
                url: redirectUrl,
                hnsProfile,
                records: { metadata: data }
            };
        } catch (error) {
            console.log('HeadlessDomains lookup failed:', error.message);
            return null;
        }
    }

    async resolveViaDoh(domain, options = {}) {
        const response = await this.queryRecordSet(domain, ['TXT', 'CNAME', 'A', 'AAAA'], options);
        if (response.rcode === 3) {
            return null;
        }
        const records = response.records;
        const hnsProfile = this.parseHnsBioProfile(domain, records.TXT);

        if (options.preferWebRecords) {
            const addressResult = this.buildAddressResult(domain, records, hnsProfile, response);
            if (addressResult) {
                return addressResult;
            }

            const cnameResult = this.buildCnameResult(domain, records, hnsProfile, response);
            if (cnameResult) {
                return cnameResult;
            }

            return null;
        }

        const redirectUrl = this.findUrlInTxt(records.TXT);
        if (redirectUrl) {
            return {
                domain,
                ...this.getResolutionMetadata(response),
                url: redirectUrl,
                hnsProfile,
                records
            };
        }

        const cnameResult = this.buildCnameResult(domain, records, hnsProfile, response);
        if (cnameResult) {
            return cnameResult;
        }

        const addressResult = this.buildAddressResult(domain, records, hnsProfile, response);
        if (addressResult) {
            return addressResult;
        }

        if (records.TXT.length > 0) {
            return {
                domain,
                ...this.getResolutionMetadata(response),
                hnsProfile,
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
        const candidateState = this.getResolverCandidateState(options);
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
            try {
                const responses = await Promise.all(requestedTypes.map(typeName =>
                    this.queryResolver(resolver, cleanDomain, typeName, timeout)
                ));
                const rcodes = new Set(responses.map(response => response.rcode));
                if (rcodes.size > 1) {
                    throw new Error(`Inconsistent DNS status across record types: ${[...rcodes].map(code => this.getRcodeName(code)).join(', ')}`);
                }

                const rcode = responses[0]?.rcode ?? 0;
                if (rcode !== 0 && rcode !== 3) {
                    throw this.createDnsResponseError(rcode);
                }

                const records = Object.fromEntries(requestedTypes.map(type => [type, []]));
                responses.forEach((response, responseIndex) => {
                    records[requestedTypes[responseIndex]] = response.records;
                });
                const elapsedMs = Date.now() - startedAt;
                this.markResolverSuccess(resolver, elapsedMs, this.getRcodeName(rcode), configuredIndex);
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
                    resolver,
                    fallbackCount: configuredIndex,
                    elapsedMs,
                    attempts: attempts.sort((left, right) => left.configuredIndex - right.configuredIndex)
                };
            } catch (error) {
                const elapsedMs = Date.now() - startedAt;
                this.markResolverFailure(resolver, error, elapsedMs);
                attempts.push({
                    resolver: this.getPublicResolverInfo(resolver),
                    status: error.rcodeName || error.code || 'ERROR',
                    elapsedMs,
                    configuredIndex,
                    message: error.message
                });
                failures.push(`${resolver.id}: ${error.message}`);
            }
        }

        const error = new Error(failures.join('; ') || `No HNS resolver available for ${cleanDomain}`);
        error.code = 'RESOLVER_FAILURE';
        throw error;
    }

    async queryResolver(resolverInput, domain, typeName, timeout) {
        const resolver = normalizeResolverDescriptor(resolverInput);
        if (!resolver) {
            throw new Error('Invalid resolver configuration');
        }
        if (resolver.transport === 'dns-json') {
            return this.queryDnsJson(resolver, domain, typeName, timeout);
        }
        return this.queryDohResponse(resolver.url, domain, typeName, timeout);
    }

    async queryDoh(resolverUrl, domain, typeName, timeout) {
        const response = await this.queryDohResponse(resolverUrl, domain, typeName, timeout);
        if (response.rcode !== 0 && response.rcode !== 3) {
            throw this.createDnsResponseError(response.rcode);
        }
        return response.records;
    }

    async queryDohResponse(resolverUrl, domain, typeName, timeout) {
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
        });

        return this.parseDnsResponseMessage(buffer, typeName, {
            id: query.readUInt16BE(0),
            domain,
            qtype: DNS_TYPES[typeName]
        });
    }

    async queryDnsJson(resolverInput, domain, typeName, timeout) {
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
        const data = await this.fetchJson(url.toString(), timeout, {
            Accept: 'application/dns-json',
            'User-Agent': 'SkyInclude/1.0.0'
        });
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
            rcodeName: this.getRcodeName(rcode)
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
        header.writeUInt16BE(0x0100, 2);
        header.writeUInt16BE(1, 4);

        const labels = [];
        for (const part of cleanName.split('.')) {
            const label = Buffer.from(part, 'ascii');
            labels.push(Buffer.from([label.length]), label);
        }
        labels.push(Buffer.from([0]));

        const tail = Buffer.alloc(4);
        tail.writeUInt16BE(qtype, 0);
        tail.writeUInt16BE(1, 2);

        return Buffer.concat([header, ...labels, tail]);
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
            return { records: [], rcode, rcodeName: this.getRcodeName(rcode) };
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
            rcodeName: this.getRcodeName(rcode)
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

    buildTlsaName(domain) {
        return `_443._tcp.${this.normalizeDomain(domain)}`;
    }

    async resolveTLSARecords(domain, options = {}) {
        const tlsaName = this.buildTlsaName(domain);
        const candidateKey = normalizeResolverList([
            options.resolver,
            options.dohResolver,
            ...this.getResolverSettings().resolvers
        ]).map(resolver => this.getResolverKey(resolver)).join(',');
        const cacheKey = `${candidateKey}|${tlsaName}`.toLowerCase();
        const cached = this.tlsaCache.get(cacheKey);

        if (!options.force && cached && Date.now() - cached.timestamp < this.tlsaCacheTimeout) {
            return cached.records;
        }

        const response = await this.queryRecordSet(tlsaName, ['TLSA'], options);
        const records = response.rcode === 3 ? [] : response.records.TLSA;
        this.tlsaCache.set(cacheKey, {
            records,
            resolver: this.getPublicResolverInfo(response.resolver),
            timestamp: Date.now()
        });
        return records;
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

    async fetchJson(url, timeout, headers = {}) {
        const buffer = await this.fetchBuffer(url, timeout, {
            Accept: 'application/json',
            'User-Agent': 'SkyInclude/1.0.0',
            ...headers
        });
        try {
            return JSON.parse(buffer.toString('utf8'));
        } catch (error) {
            throw new Error('Response was not valid JSON');
        }
    }

    fetchBuffer(url, timeout, headers = {}) {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const client = parsedUrl.protocol === 'https:' ? https : http;
            const request = client.get(parsedUrl, { headers }, response => {
                const chunks = [];

                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    if (response.statusCode < 200 || response.statusCode >= 300) {
                        const error = new Error(`HTTP ${response.statusCode}: ${buffer.toString('utf8').slice(0, 120)}`);
                        error.code = `HTTP_${response.statusCode}`;
                        reject(error);
                        return;
                    }
                    resolve(buffer);
                });
            });

            request.on('error', reject);
            request.setTimeout(timeout, () => {
                const error = new Error('Request timeout');
                error.code = 'REQUEST_TIMEOUT';
                request.destroy(error);
            });
        });
    }

    async resolveAPI(domain) {
        return this.resolveHNSDomain(domain);
    }

    async resolveP2P(domain) {
        console.log('P2P HNS resolution not implemented, using public DoH');
        return this.resolveViaDoh(this.normalizeDomain(domain));
    }

    async verifyDANE(domain, certificate, options = {}) {
        const cleanDomain = this.normalizeDomain(domain);
        const tlsaName = this.buildTlsaName(cleanDomain);
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
                : await this.resolveTLSARecords(cleanDomain);
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
    resolveHNSDomain: domain => resolver.resolveHNSDomain(domain),
    verifyDANE: (domain, cert) => resolver.verifyDANE(domain, cert),
    checkTraditionalDNS: domain => resolver.checkTraditionalDNS(domain),
    updateSettings: settings => resolver.updateSettings(settings),
    clearCache: () => resolver.clearCache(),
    getCacheStats: () => resolver.getCacheStats(),
    getResolverDiagnostics: () => resolver.getResolverDiagnostics()
};
