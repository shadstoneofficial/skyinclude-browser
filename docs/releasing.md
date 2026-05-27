# Releasing SkyInclude Browser

This repo builds release artifacts with GitHub Actions and publishes them through GitHub Releases after the workflow artifacts have been verified.

## Build Artifacts

The release artifact workflow lives at `.github/workflows/release.yml`.

It runs on:

- Manual dispatch with `workflow_dispatch`
- Tags that start with `v`, such as `v0.1.0`

Each platform job runs:

1. `npm ci`
2. `npm test`
3. The platform build script from `package.json`
4. SHA256 checksum generation
5. Artifact upload

Expected artifacts:

- macOS: `.dmg` files for Intel and Apple Silicon
- Windows: NSIS `.exe` installers
- Ubuntu/Linux: `.AppImage` and `.deb` packages
- `SHA256SUMS.txt` for each platform artifact set

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
5. Create or update the GitHub release.
6. Upload the installers/packages and checksum files.
7. Confirm the public release page shows the expected assets.

## Current Signing Notes

The macOS build currently disables automatic certificate discovery in CI. That allows unsigned DMGs to build reproducibly, but public users may see macOS security prompts until Developer ID signing and notarization are configured.

Windows packages are also unsigned until a code-signing certificate is configured.
