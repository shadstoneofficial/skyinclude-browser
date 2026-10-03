const assert = require('node:assert/strict');
const test = require('node:test');
const { domainToASCII } = require('node:url');
const { parseIanaTlds } = require('../scripts/update-icann-tlds');
const snapshot = require('../assets/icann-tlds.json');

function sampleSource() {
    const header = '# Version 2026100200, Last Updated Fri Oct  2 07:07:02 2026 UTC';
    return `${header}\n${snapshot.tlds.map(tld => tld.toUpperCase()).join('\n')}\n`;
}

test('bundled IANA root-zone data includes auditable provenance and valid unique labels', () => {
    assert.equal(snapshot.source, 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt');
    assert.match(snapshot.version, /^\d{10}$/);
    assert.ok(Number.isFinite(Date.parse(snapshot.lastUpdated)));
    assert.match(snapshot.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(new Set(snapshot.tlds).size, snapshot.tlds.length);
    assert.deepEqual(snapshot.tlds, [...snapshot.tlds].sort());
    for (const tld of snapshot.tlds) {
        assert.equal(domainToASCII(tld), tld);
        assert.match(tld, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
    }
});

test('IANA snapshot updater parses source metadata and normalizes root-zone labels', () => {
    const parsed = parseIanaTlds(sampleSource());
    assert.equal(parsed.version, '2026100200');
    assert.equal(parsed.lastUpdated, '2026-10-02T07:07:02.000Z');
    assert.deepEqual(parsed.tlds, snapshot.tlds);
    assert.match(parsed.sourceSha256, /^[a-f0-9]{64}$/);
});

test('IANA snapshot updater refuses truncated, malformed, duplicate, or unrelated input', () => {
    assert.throws(() => parseIanaTlds('<html>Unavailable</html>'), /header/);
    assert.throws(() => parseIanaTlds('# Version 2026100200, Last Updated invalid\nCOM\n'), /header/);
    assert.throws(() => parseIanaTlds('# Version 2026100200, Last Updated Fri Oct 2 07:07:02 2026 UTC\nCOM\n'), /number/);
    const source = sampleSource();
    assert.throws(() => parseIanaTlds(source.replace('\nSHOP\n', '\nSHOP.EXAMPLE\n')), /entry/);
    assert.throws(() => parseIanaTlds(`${source}COM\n`), /duplicate/);
    assert.throws(() => parseIanaTlds(source.replace('\nCOM\n', '\n')), /missing com/);
});
