#!/usr/bin/env node

// Refresh the offline root-zone classification data from the official IANA
// source. `--check` reports upstream drift without changing any files.
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const SOURCE_URL = 'https://data.iana.org/TLD/tlds-alpha-by-domain.txt';
const SNAPSHOT_PATH = path.join(__dirname, '..', 'assets', 'icann-tlds.json');
const MAX_SOURCE_BYTES = 256 * 1024;
const DEADLINE_MS = 15000;

function parseIanaTlds(sourceText) {
    const lines = sourceText.trim().split(/\r?\n/);
    const header = /^# Version (\d{10}), Last Updated (.+)$/.exec(lines.shift() || '');
    if (!header || !Number.isFinite(Date.parse(header[2]))) {
        throw new Error('IANA response is missing a valid version/date header');
    }

    if (lines.length < 1000 || lines.length > 5000) {
        throw new Error('IANA response has an unexpected number of root-zone entries');
    }
    const tlds = lines.map(line => {
        if (!/^[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?$/.test(line)) {
            throw new Error(`Invalid IANA root-zone entry: ${line}`);
        }
        return line.toLowerCase();
    });
    if (new Set(tlds).size !== tlds.length) throw new Error('IANA response contains duplicate entries');
    for (const required of ['com', 'org', 'net', 'arpa', 'shop', 'online', 'xn--p1ai']) {
        if (!tlds.includes(required)) throw new Error(`IANA response is missing ${required}`);
    }

    return {
        source: SOURCE_URL,
        version: header[1],
        lastUpdated: new Date(header[2]).toISOString(),
        sourceSha256: crypto.createHash('sha256').update(sourceText).digest('hex'),
        tlds: tlds.sort()
    };
}

function fetchIanaTlds() {
    return new Promise((resolve, reject) => {
        let settled = false;
        let request;
        let response;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            if (error) {
                response?.destroy();
                request?.destroy();
                reject(error);
            } else {
                resolve(value);
            }
        };
        const deadline = setTimeout(() => finish(new Error('IANA download exceeded the 15-second deadline')), DEADLINE_MS);
        request = https.get(SOURCE_URL, { headers: { 'Accept-Encoding': 'identity' } }, incoming => {
            response = incoming;
            if (incoming.statusCode !== 200) {
                finish(new Error(`IANA download returned HTTP ${incoming.statusCode}`));
                return;
            }
            const chunks = [];
            let bytes = 0;
            incoming.on('data', chunk => {
                bytes += chunk.length;
                if (bytes > MAX_SOURCE_BYTES) {
                    finish(new Error('IANA response exceeds the source-size limit'));
                    return;
                }
                chunks.push(chunk);
            });
            incoming.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
            incoming.on('error', error => finish(error));
            incoming.on('aborted', () => finish(new Error('IANA response was interrupted')));
        });
        request.on('error', error => finish(error));
    });
}

async function updateSnapshot({ check = false } = {}) {
    const snapshot = parseIanaTlds(await fetchIanaTlds());
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    let current = null;
    try {
        current = await fs.readFile(SNAPSHOT_PATH, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (current === serialized) {
        console.log(`IANA snapshot ${snapshot.version} is current (${snapshot.tlds.length} TLDs)`);
        return;
    }
    if (check) throw new Error('Bundled IANA snapshot differs from upstream; run node scripts/update-icann-tlds.js and review the diff');

    const temporaryPath = `${SNAPSHOT_PATH}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporaryPath, serialized, { flag: 'wx' });
        await fs.rename(temporaryPath, SNAPSHOT_PATH);
    } finally {
        await fs.unlink(temporaryPath).catch(error => {
            if (error.code !== 'ENOENT') throw error;
        });
    }
    console.log(`Updated IANA snapshot to ${snapshot.version} (${snapshot.tlds.length} TLDs)`);
}

if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--check') || args.length > 1) {
        console.error('Usage: node scripts/update-icann-tlds.js [--check]');
        process.exitCode = 1;
    } else {
        updateSnapshot({ check: args.includes('--check') }).catch(error => {
            console.error(error.message);
            process.exitCode = 1;
        });
    }
}

module.exports = { parseIanaTlds };
