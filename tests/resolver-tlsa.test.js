const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { HNSResolver } = require('../resolver');

function settingsManager(enableDANE = true) {
    return {
        getSetting(key) {
            if (key === 'hnsDANE') return enableDANE;
            if (key === 'hnsResolvers') return ['https://resolver.invalid/dns-query'];
            if (key === 'hnsTimeout') return 1000;
            return null;
        }
    };
}

function createResolver(records = [], enableDANE = true) {
    const resolver = new HNSResolver(settingsManager(enableDANE));
    resolver.resolveTLSARecords = async () => records;
    return resolver;
}

function createCertificate(daysFromNow = 30) {
    const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' });
    const hash = crypto.createHash('sha256').update(publicKeyDer).digest('hex');
    const now = Date.now();

    return {
        certificate: {
            publicKeyDer,
            valid_from: new Date(now - 86400000).toISOString(),
            valid_to: new Date(now + daysFromNow * 86400000).toISOString()
        },
        hash
    };
}

test('parses TLSA rdata', () => {
    const resolver = new HNSResolver();
    const record = resolver.parseTlsaRecord(Buffer.from('030101' + 'ab'.repeat(32), 'hex'));

    assert.deepEqual(record, {
        usage: 3,
        selector: 1,
        matchingType: 1,
        certificateAssociationData: 'ab'.repeat(32)
    });
});

test('parses TLSA records from a DNS wire response', () => {
    const resolver = new HNSResolver();
    const header = Buffer.alloc(12);
    header.writeUInt16BE(1, 0);
    header.writeUInt16BE(0x8180, 2);
    header.writeUInt16BE(0, 4);
    header.writeUInt16BE(1, 6);

    const answerName = Buffer.from([0]);
    const answerMeta = Buffer.alloc(10);
    answerMeta.writeUInt16BE(52, 0);
    answerMeta.writeUInt16BE(1, 2);
    answerMeta.writeUInt32BE(300, 4);
    answerMeta.writeUInt16BE(35, 8);

    const rdata = Buffer.from('030101' + 'ab'.repeat(32), 'hex');
    const response = Buffer.concat([header, answerName, answerMeta, rdata]);
    const records = resolver.parseDnsResponse(response, 'TLSA');

    assert.equal(records.length, 1);
    assert.equal(records[0].certificateAssociationData, 'ab'.repeat(32));
});

test('rejects malformed TLSA rdata', () => {
    const resolver = new HNSResolver();
    assert.equal(resolver.parseTlsaRecord(Buffer.from('0301', 'hex')), null);
});

test('classifies supported and unsupported TLSA records', () => {
    const resolver = new HNSResolver();
    assert.equal(resolver.isSupportedTlsaRecord({
        usage: 3,
        selector: 1,
        matchingType: 1,
        certificateAssociationData: 'ab'.repeat(32)
    }), true);
    assert.equal(resolver.isSupportedTlsaRecord({
        usage: 2,
        selector: 1,
        matchingType: 1,
        certificateAssociationData: 'ab'.repeat(32)
    }), false);
});

test('returns no_tlsa when no TLSA records exist', async () => {
    const result = await createResolver([]).verifyDANE('early.hns', null);

    assert.equal(result.state, 'no_tlsa');
});

test('returns disabled unless forced or hnsDANE is enabled', async () => {
    const result = await createResolver([], false).verifyDANE('early.hns', null);
    const forcedResult = await createResolver([], false).verifyDANE('early.hns', null, { force: true });

    assert.equal(result.state, 'disabled');
    assert.equal(forcedResult.state, 'no_tlsa');
});

test('returns unsupported_record when TLSA exists outside MVP subset', async () => {
    const { certificate } = createCertificate();
    const result = await createResolver([{
        usage: 2,
        selector: 1,
        matchingType: 1,
        certificateAssociationData: 'ab'.repeat(32)
    }]).verifyDANE('early.hns', certificate);

    assert.equal(result.state, 'unsupported_record');
    assert.equal(result.unsupportedRecords, 1);
});

test('returns cert_expired before comparing TLSA hash', async () => {
    const { certificate, hash } = createCertificate(-1);
    const result = await createResolver([{
        usage: 3,
        selector: 1,
        matchingType: 1,
        certificateAssociationData: hash
    }]).verifyDANE('expired.hns', certificate);

    assert.equal(result.state, 'cert_expired');
});

test('returns verified for a matching TLSA 3 1 1 SPKI hash', async () => {
    const { certificate, hash } = createCertificate();
    const result = await createResolver([{
        usage: 3,
        selector: 1,
        matchingType: 1,
        certificateAssociationData: hash
    }]).verifyDANE('secure.hns', certificate);

    assert.equal(result.state, 'verified');
    assert.equal(result.supportedRecords, 1);
});

test('returns tlsa_mismatch for a supported but non-matching TLSA hash', async () => {
    const { certificate } = createCertificate();
    const result = await createResolver([{
        usage: 3,
        selector: 1,
        matchingType: 1,
        certificateAssociationData: 'cd'.repeat(32)
    }]).verifyDANE('secure.hns', certificate);

    assert.equal(result.state, 'tlsa_mismatch');
});
