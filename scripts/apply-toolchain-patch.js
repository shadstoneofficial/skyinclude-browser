const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const patchTargets = [
    ['out/util/electronGet.js',
        '3452ca5b9a2f29dd6460f0cc9937be2dc1bbbf36809f410649a015b35a607b48',
        '1229cfa775e68af2efef48f6c09fca3775aace3461d109b76aff1b991ef16581'],
    ['out/binDownload.js',
        '2d3a1a10d62b19e1bbaf3c0a77aa52ae17c25e2f34cb51faef99684cfecbb08a',
        '79ece1522f966f982aead0347c44b70254b131d46949ab95ac41f7436622c5b7'],
    ['out/util/skyincludeFetchDownload.js', null,
        'c2a012956d8ba96cc29485818e656e40aa194f034b4dec28ec3764673067069d'],
];

function digest(file) {
    try {
        return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function applyToolchainPatch(projectRoot = path.resolve(__dirname, '..')) {
    const builderRoot = path.join(projectRoot, 'node_modules', 'app-builder-lib');
    const builder = JSON.parse(fs.readFileSync(path.join(builderRoot, 'package.json'), 'utf8'));
    if (builder.version !== '26.15.3') {
        throw new Error('Re-review the download patch before changing app-builder-lib 26.15.3.');
    }
    const hashes = patchTargets.map(([file]) => digest(path.join(builderRoot, file)));
    if (hashes.every((hash, index) => hash === patchTargets[index][2])) {
        return 'already applied';
    }
    if (!hashes.every((hash, index) => hash === patchTargets[index][1])) {
        throw new Error('Unexpected packager file contents; refusing to overwrite or partially apply the download patch.');
    }
    const patch = path.join(projectRoot, 'patches', 'app-builder-lib+26.15.3.patch');
    for (const check of [true, false]) {
        const args = ['-c', 'core.autocrlf=false', 'apply', '--whitespace=error', ...(check ? ['--check'] : []), patch];
        const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
        if (result.error || result.status !== 0) {
            throw new Error(`Cannot ${check ? 'validate' : 'apply'} download patch (Git is required): ${result.error?.message || result.stderr}`);
        }
    }
    if (!patchTargets.every(([file, , hash]) => digest(path.join(builderRoot, file)) === hash)) {
        throw new Error('Download patch verification failed; reinstall the locked dependencies before packaging.');
    }
    return 'applied';
}

if (require.main === module) {
    try {
        console.log(`Electron Builder download patch: ${applyToolchainPatch()}`);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { applyToolchainPatch };
