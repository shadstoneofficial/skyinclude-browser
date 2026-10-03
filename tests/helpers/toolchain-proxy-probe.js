const path = require('node:path');
const { downloadElectronArtifactZip } = require('app-builder-lib/out/util/electronGet');

async function main() {
    const [url, cacheRoot, checksum] = process.argv.slice(2);
    const artifact = await downloadElectronArtifactZip({
        version: '9.9.9',
        artifactName: 'fixture.bin',
        cacheDir: cacheRoot,
        electronDownload: {
            isGeneric: true,
            checksums: { 'fixture.bin': checksum },
            mirrorOptions: { resolveAssetURL: async () => url },
            downloadOptions: { quiet: true, timeout: { request: 2000 } },
        },
    });
    if (!path.isAbsolute(artifact)) throw new Error('Expected an absolute artifact path');
}

main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
});
