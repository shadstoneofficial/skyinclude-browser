# Releasing SkyInclude Browser

This repo builds release artifacts with GitHub Actions and publishes them through GitHub Releases after the workflow artifacts have been verified.

## Build Artifacts

The release artifact workflow lives at `.github/workflows/release.yml`.

It runs on:

- Manual dispatch with `workflow_dispatch`
- Tags that start with `v`, such as `v0.1.0`

Each platform job runs:

1. `npm ci`
2. `npm audit --audit-level=high`
3. `npm test`
4. The platform build script from `package.json`
5. SHA256 checksum generation
6. GitHub artifact attestation generation from `dist/SHA256SUMS.txt`
7. Artifact upload

Expected artifacts:

- macOS: `.dmg` files for Intel and Apple Silicon
- Windows: NSIS `.exe` installers
- Ubuntu/Linux: `.AppImage` and `.deb` packages
- `SHA256SUMS.txt` for each platform artifact set
- GitHub artifact attestations associated with the workflow run

## macOS Developer ID Signing

macOS release builds are intended to be signed with a Developer ID Application certificate and notarized by Apple. Electron Builder uses the repository secrets below during the macOS job:

```text
CSC_LINK
CSC_KEY_PASSWORD
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

Expected meanings:

- `CSC_LINK`: base64-encoded `.p12` export of the Developer ID Application certificate and private key
- `CSC_KEY_PASSWORD`: password used when exporting the `.p12`
- `APPLE_ID`: Apple Developer account email used for notarization
- `APPLE_APP_SPECIFIC_PASSWORD`: Apple app-specific password for notarization
- `APPLE_TEAM_ID`: Apple Developer Team ID, for example `2AT6KFBL29`

Do not commit `.p12` files, app-specific passwords, or other signing material. Add them only as GitHub Actions secrets.

The macOS build config enables Hardened Runtime and Electron Builder notarization. The release workflow deliberately keeps certificate auto-discovery disabled for Windows and Linux jobs, but not for the macOS job.

Apple notarization can take longer than ordinary packaging, so the macOS signing step has a longer timeout than the Windows and Linux package builds. If a run times out while waiting on `xcrun notarytool submit --wait`, the certificate import and code signing may still be correct; rerun after checking Apple's notarization service status.

## Manual Build Run

```bash
gh workflow run release.yml --repo shadstoneofficial/skyinclude-browser --ref main
```

## Tag Build Run

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Publish Flow

Use the GitHub release manager workflow after the artifact workflow passes:

1. Confirm the tag and target commit.
2. Confirm all platform jobs passed.
3. Download the workflow artifacts.
4. Verify artifact names, sizes, and checksums.
5. Verify artifact attestations.
6. Create or update the GitHub release.
7. Upload the installers/packages and checksum files.
8. Confirm the public release page shows the expected assets.

## Verification Checklist

Set the release tag you are checking:

```bash
RELEASE_TAG=v0.1.1
```

Confirm the tag points to the intended commit:

```bash
git fetch --tags origin
git rev-parse "${RELEASE_TAG}^{commit}"
```

Check whether the tag is signed:

```bash
git tag -v "${RELEASE_TAG}"
```

Confirm the linked workflow run completed successfully and used the expected commit:

```bash
gh run view WORKFLOW_RUN_ID -R shadstoneofficial/skyinclude-browser --json conclusion,event,headBranch,headSha
```

Verify downloaded artifacts against `SHA256SUMS.txt`:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

Verify GitHub artifact provenance for each downloaded artifact:

```bash
gh attestation verify SkyInclude.Browser.Setup.0.1.1.exe -R shadstoneofficial/skyinclude-browser
gh attestation verify SkyInclude.Browser-0.1.1.dmg -R shadstoneofficial/skyinclude-browser
gh attestation verify SkyInclude.Browser-0.1.1-arm64.dmg -R shadstoneofficial/skyinclude-browser
gh attestation verify SkyInclude.Browser-0.1.1.AppImage -R shadstoneofficial/skyinclude-browser
gh attestation verify skyinclude-browser_0.1.1_amd64.deb -R shadstoneofficial/skyinclude-browser
```

If a release is marked immutable, GitHub CLI can also verify release assets:

```bash
gh release verify "${RELEASE_TAG}" -R shadstoneofficial/skyinclude-browser
gh release verify-asset "${RELEASE_TAG}" SkyInclude.Browser.Setup.0.1.1.exe -R shadstoneofficial/skyinclude-browser
```

## Current Signing Notes

The macOS build signs and notarizes when the required Apple Developer ID secrets are present in GitHub Actions. If those secrets are missing or invalid, the macOS job should fail rather than publish unsigned public DMGs.

Windows packages are also unsigned until a code-signing certificate is configured.

Artifact attestations improve build provenance, but they do not replace OS code signing, notarization, or Authenticode verification.

The artifact workflow builds packages with Electron Builder publishing disabled. GitHub Releases should be created explicitly after the workflow artifacts are reviewed.
