const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const crypto = require('crypto');
const { URL } = require('url');

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

const FALLBACK_DOH_RESOLVERS = [
    'https://hnsdoh.com/dns-query',
    'https://query.hdns.io/dns-query'
];

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
            dohResolver: 'https://hnsdoh.com/dns-query',
            headlessLookupBase: 'https://headlessdomains.com/api/v1/lookup/',
            timeout: 4000,
            enableDANE: false
        };

        this.cache = new Map();
        this.cacheTimeout = 300000;
        this.tlsaCache = new Map();
        this.tlsaCacheTimeout = 300000;
    }

    getResolverSettings() {
        if (!this.settingsManager) {
            return { ...this.settings };
        }

        const resolvers = this.settingsManager.getSetting('hnsResolvers') || [];
        const customResolver = this.settingsManager.getSetting('hnsCustomResolver');
        const dohResolver = customResolver || resolvers.find(resolver => String(resolver || '').includes('/dns-query'));

        const configuredTimeout = Number(this.settingsManager.getSetting('hnsTimeout') || this.settings.timeout);
        const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
            ? Math.min(configuredTimeout, this.settings.timeout)
            : this.settings.timeout;

        return {
            resolutionMode: this.settingsManager.getSetting('hnsResolutionMode') || 'doh',
            dohResolver: dohResolver || this.settings.dohResolver,
            headlessLookupBase: this.settings.headlessLookupBase,
            timeout,
            enableDANE: this.settingsManager.getSetting('hnsDANE') === true
        };
    }

    normalizeDohResolver(resolverUrl) {
        const value = String(resolverUrl || '').trim();
        if (!value) {
            return null;
        }

        const withScheme = value.startsWith('http://') || value.startsWith('https://')
            ? value
            : `https://${value}`;

        try {
            const url = new URL(withScheme);
            if (!url.pathname || url.pathname === '/') {
                url.pathname = '/dns-query';
            }
            return url.toString();
        } catch (error) {
            return null;
        }
    }

    getDohResolverCandidates(options = {}) {
        const settings = this.getResolverSettings();
        const resolvers = this.settingsManager?.getSetting('hnsResolvers') || [];
        const customResolver = this.settingsManager?.getSetting('hnsCustomResolver');
        const candidates = [
            options.dohResolver,
            customResolver,
            settings.dohResolver,
            ...resolvers,
            ...FALLBACK_DOH_RESOLVERS
        ];
        const seen = new Set();

        return candidates
            .map(resolver => this.normalizeDohResolver(resolver))
            .filter(Boolean)
            .filter(resolver => {
                const key = resolver.toLowerCase();
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
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
            const result = await this.resolveWebRecordsOnly(domain);
            if (result) {
                return result;
            }

            if (attempt < attempts) {
                await new Promise(resolve => setTimeout(resolve, 250 * attempt));
            }
        }

        return null;
    }

    async resolveWebRecordsOnly(domain) {
        const settings = this.getResolverSettings();
        const [cnameRecords, aRecords, aaaaRecords, hnsProfile] = await Promise.all([
            this.queryDoh(settings.dohResolver, domain, 'CNAME', settings.timeout).catch(() => []),
            this.queryDoh(settings.dohResolver, domain, 'A', settings.timeout).catch(() => []),
            this.queryDoh(settings.dohResolver, domain, 'AAAA', settings.timeout).catch(() => []),
            this.resolveHnsBioProfile(domain, settings).catch(() => null)
        ]);
        const records = { TXT: [], CNAME: cnameRecords, A: aRecords, AAAA: aaaaRecords };

        return this.buildAddressResult(domain, records, hnsProfile)
            || this.buildCnameResult(domain, records, hnsProfile);
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
            const hnsProfile = await this.resolveHnsBioProfile(domain, settings);
            const webResult = await this.resolveHeadlessWebRecords(domain);
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
        const settings = this.getResolverSettings();
        const [txtRecords, cnameRecords, aRecords, aaaaRecords] = await Promise.all([
            this.queryDoh(settings.dohResolver, domain, 'TXT', settings.timeout).catch(() => []),
            this.queryDoh(settings.dohResolver, domain, 'CNAME', settings.timeout).catch(() => []),
            this.queryDoh(settings.dohResolver, domain, 'A', settings.timeout).catch(() => []),
            this.queryDoh(settings.dohResolver, domain, 'AAAA', settings.timeout).catch(() => [])
        ]);
        const records = { TXT: txtRecords, CNAME: cnameRecords, A: aRecords, AAAA: aaaaRecords };
        const hnsProfile = this.parseHnsBioProfile(domain, txtRecords);

        if (options.preferWebRecords) {
            const addressResult = this.buildAddressResult(domain, records, hnsProfile);
            if (addressResult) {
                return addressResult;
            }

            const cnameResult = this.buildCnameResult(domain, records, hnsProfile);
            if (cnameResult) {
                return cnameResult;
            }

            return null;
        }

        const redirectUrl = this.findUrlInTxt(txtRecords);
        if (redirectUrl) {
            return {
                domain,
                source: 'hnsdoh',
                url: redirectUrl,
                hnsProfile,
                records
            };
        }

        const cnameResult = this.buildCnameResult(domain, records, hnsProfile);
        if (cnameResult) {
            return cnameResult;
        }

        const addressResult = this.buildAddressResult(domain, records, hnsProfile);
        if (addressResult) {
            return addressResult;
        }

        if (txtRecords.length > 0) {
            return {
                domain,
                source: 'hnsdoh',
                hnsProfile,
                records
            };
        }

        return null;
    }

    async resolveHnsBioProfile(domain, settings = this.getResolverSettings()) {
        const txtRecords = await this.queryDoh(settings.dohResolver, domain, 'TXT', settings.timeout).catch(() => []);
        return this.parseHnsBioProfile(domain, txtRecords);
    }

    buildCnameResult(domain, records, hnsProfile = null) {
        if (!records.CNAME.length) {
            return null;
        }

        return {
            domain,
            source: 'hnsdoh',
            url: `http://${records.CNAME[0]}`,
            canonicalName: records.CNAME[0],
            hnsProfile,
            records
        };
    }

    buildAddressResult(domain, records, hnsProfile = null) {
        if (!records.A.length && !records.AAAA.length) {
            return null;
        }

        return {
            domain,
            source: 'hnsdoh',
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

    async queryDoh(resolverUrl, domain, typeName, timeout) {
        const resolver = this.normalizeDohResolver(resolverUrl);
        if (!resolver) {
            throw new Error(`Invalid DoH resolver: ${resolverUrl}`);
        }
        const query = this.buildDnsQuery(domain, DNS_TYPES[typeName]);
        const url = new URL(resolver);
        url.searchParams.set('dns', query.toString('base64url'));

        const buffer = await this.fetchBuffer(url.toString(), timeout, {
            Accept: 'application/dns-message',
            'User-Agent': 'SkyInclude/1.0.0'
        });

        return this.parseDnsResponse(buffer, typeName);
    }

    buildDnsQuery(name, qtype) {
        const queryId = Math.floor(Math.random() * 65535);
        const header = Buffer.alloc(12);
        header.writeUInt16BE(queryId, 0);
        header.writeUInt16BE(0x0100, 2);
        header.writeUInt16BE(1, 4);

        const labels = [];
        for (const part of name.split('.')) {
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
        if (buffer.length < 12) {
            return [];
        }

        let offset = 12;
        const qdcount = buffer.readUInt16BE(4);
        const ancount = buffer.readUInt16BE(6);
        const results = [];

        for (let i = 0; i < qdcount; i += 1) {
            const questionName = this.readDnsName(buffer, offset);
            offset = questionName.offset + 4;
        }

        for (let i = 0; i < ancount && offset < buffer.length; i += 1) {
            const answerName = this.readDnsName(buffer, offset);
            offset = answerName.offset;

            if (offset + 10 > buffer.length) {
                break;
            }

            const type = buffer.readUInt16BE(offset);
            offset += 2;
            offset += 2;
            offset += 4;
            const rdlength = buffer.readUInt16BE(offset);
            offset += 2;

            if (offset + rdlength > buffer.length) {
                break;
            }

            const rdataStart = offset;
            const rdata = buffer.subarray(offset, offset + rdlength);

            if (typeName === 'A' && type === DNS_TYPES.A && rdlength === 4) {
                results.push(Array.from(rdata).join('.'));
            } else if (typeName === 'AAAA' && type === DNS_TYPES.AAAA && rdlength === 16) {
                results.push(this.formatIpv6(rdata));
            } else if (typeName === 'TXT' && type === DNS_TYPES.TXT) {
                results.push(...this.parseTxtRecord(rdata));
            } else if (typeName === 'CNAME' && type === DNS_TYPES.CNAME) {
                results.push(this.readDnsName(buffer, rdataStart).name);
            } else if (typeName === 'TLSA' && type === DNS_TYPES.TLSA) {
                const record = this.parseTlsaRecord(rdata);
                if (record) {
                    results.push(record);
                }
            }

            offset += rdlength;
        }

        return results.filter(Boolean);
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
                const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
                if (!jumped) {
                    nextOffset = offset + 2;
                }
                offset = pointer;
                jumped = true;
                continue;
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
        const settings = this.getResolverSettings();
        const tlsaName = this.buildTlsaName(domain);
        const resolvers = this.getDohResolverCandidates(options);
        const timeout = options.timeout || settings.timeout;
        const lookupErrors = [];

        for (const resolver of resolvers) {
            const cacheKey = `${resolver}|${tlsaName}`.toLowerCase();
            const cached = this.tlsaCache.get(cacheKey);

            if (!options.force && cached && Date.now() - cached.timestamp < this.tlsaCacheTimeout) {
                return cached.records;
            }

            try {
                const records = await this.queryDoh(resolver, tlsaName, 'TLSA', timeout);
                this.tlsaCache.set(cacheKey, {
                    records,
                    timestamp: Date.now()
                });

                return records;
            } catch (error) {
                lookupErrors.push(`${resolver}: ${error.message}`);
            }
        }

        throw new Error(lookupErrors.join('; ') || `No DoH resolver available for ${tlsaName}`);
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

    async fetchJson(url, timeout) {
        const buffer = await this.fetchBuffer(url, timeout, {
            Accept: 'application/json',
            'User-Agent': 'SkyInclude/1.0.0'
        });
        return JSON.parse(buffer.toString('utf8'));
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
                        reject(new Error(`HTTP ${response.statusCode}: ${buffer.toString('utf8').slice(0, 120)}`));
                        return;
                    }
                    resolve(buffer);
                });
            });

            request.on('error', reject);
            request.setTimeout(timeout, () => {
                request.destroy(new Error('Request timeout'));
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
    }

    getCacheStats() {
        return {
            size: this.cache.size,
            tlsaSize: this.tlsaCache.size
        };
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
    getCacheStats: () => resolver.getCacheStats()
};
