const https = require('https');
const http = require('http');
const dns = require('dns').promises;
const { URL } = require('url');

const DNS_TYPES = {
    A: 1,
    CNAME: 5,
    TXT: 16,
    AAAA: 28
};

class HNSResolver {
    constructor(settingsManager = null) {
        this.settingsManager = settingsManager;
        this.settings = {
            resolutionMode: 'doh',
            dohResolver: 'https://hnsdoh.com/dns-query',
            headlessLookupBase: 'https://headlessdomains.com/api/v1/lookup/',
            timeout: 10000,
            enableDANE: false
        };

        this.cache = new Map();
        this.cacheTimeout = 300000;
    }

    getResolverSettings() {
        if (!this.settingsManager) {
            return { ...this.settings };
        }

        const resolvers = this.settingsManager.getSetting('hnsResolvers') || [];
        const customResolver = this.settingsManager.getSetting('hnsCustomResolver');
        const dohResolver = customResolver || resolvers.find(resolver => resolver.includes('/dns-query'));

        return {
            resolutionMode: this.settingsManager.getSetting('hnsResolutionMode') || 'doh',
            dohResolver: dohResolver || this.settings.dohResolver,
            headlessLookupBase: this.settings.headlessLookupBase,
            timeout: this.settingsManager.getSetting('hnsTimeout') || this.settings.timeout,
            enableDANE: this.settingsManager.getSetting('hnsDANE') === true
        };
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
                result = await this.resolveViaDoh(cleanDomain, { preferWebRecords: true });
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
                    records: { metadata: data }
                };
            }

            return {
                domain,
                source: 'headlessdomains',
                url: redirectUrl,
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

        if (options.preferWebRecords) {
            const addressResult = this.buildAddressResult(domain, records);
            if (addressResult) {
                return addressResult;
            }

            const cnameResult = this.buildCnameResult(domain, records);
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
                records
            };
        }

        const cnameResult = this.buildCnameResult(domain, records);
        if (cnameResult) {
            return cnameResult;
        }

        const addressResult = this.buildAddressResult(domain, records);
        if (addressResult) {
            return addressResult;
        }

        if (txtRecords.length > 0) {
            return {
                domain,
                source: 'hnsdoh',
                records
            };
        }

        return null;
    }

    buildCnameResult(domain, records) {
        if (!records.CNAME.length) {
            return null;
        }

        return {
            domain,
            source: 'hnsdoh',
            url: `http://${records.CNAME[0]}`,
            canonicalName: records.CNAME[0],
            records
        };
    }

    buildAddressResult(domain, records) {
        if (!records.A.length && !records.AAAA.length) {
            return null;
        }

        return {
            domain,
            source: 'hnsdoh',
            url: `http://${domain}`,
            address: records.A[0] || records.AAAA[0],
            addressType: records.A.length > 0 ? 'A' : 'AAAA',
            records
        };
    }

    async queryDoh(resolverUrl, domain, typeName, timeout) {
        const resolver = resolverUrl.startsWith('http')
            ? resolverUrl
            : `https://${resolverUrl.replace(/\/$/, '')}/dns-query`;
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

    async verifyDANE(domain, certificate) {
        if (!this.getResolverSettings().enableDANE) {
            return true;
        }

        if (!certificate) {
            return false;
        }

        const now = Date.now();
        if (certificate.valid_from && new Date(certificate.valid_from) > now) {
            return false;
        }

        if (certificate.valid_to && new Date(certificate.valid_to) < now) {
            return false;
        }

        return true;
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
    }

    getCacheStats() {
        return {
            size: this.cache.size
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
