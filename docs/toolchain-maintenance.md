# Build toolchain maintenance — 2026-10-03

This follow-up removes the inherited dependency-audit blocker without changing
the browser version (0.1.23), the locked Electron runtime (42.11.3), platform
targets, signing/notarization configuration, or browser networking architecture.

## Locked dependencies and Node requirement

| Item | Decision |
| --- | --- |
| Node | 22.12.0+; CI and release jobs use Node 22 |
| Electron | Pin the already-locked 42.11.3 runtime |
| Electron Builder / app-builder-lib | Pin the already-locked stable 26.15.3 packager |
| `@electron/get` | Pin 5.1.0 and override the packager's older v3 dependency |
| Undici | Explicit build-only dependency, 7.30.0, for Fetch proxy support |
| brace-expansion | Refresh compatible branches to 1.1.21, 2.1.7, and 5.0.12 |
| fast-uri | Refresh to 3.1.8 within its existing major |

`got`, `cacheable-request`, `http-cache-semantics`, and their unused dependency
chain are removed from the lockfile. Runtime dependencies remain empty. The full
`npm audit --audit-level=high` gate still includes development dependencies;
there is no advisory exclusion, dev-dependency omission, or forced downgrade.

The [http-cache-semantics advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
reports no patched release. `@electron/get` v5 removes Got in favor of Fetch, but
also changes download options and proxy APIs, as documented in its
[official v5 release notes](https://github.com/electron/get/releases/tag/v5.0.0).
A dependency override alone would silently lose the stable packager's Got-style
deadline/proxy options and Fetch-error retry handling.

## Narrow compatibility patch

`patches/app-builder-lib+26.15.3.patch` adapts only the stable packager's download
paths to `@electron/get` v5. Its proxy/error migration follows the
[upstream implementation](https://github.com/electron-userland/electron-builder/blob/electron-builder%4027.0.0-alpha.9/packages/app-builder-lib/src/util/electronGet.ts).
It does not install Electron Builder 27 alpha or change the rest of the packager.

- Use the public `FetchDownloader` extension point for runtime/tool downloads.
- Keep progress callbacks, custom request headers, caching, and existing
  checksum verification. Neither this patch nor its tests disable checksums.
- Translate the ten-minute download deadline to an AbortSignal covering the
  response body. Each attempt/checksum request gets a fresh deadline; an explicit
  caller cancellation remains non-retryable.
- Initialize Fetch proxy support for HTTP(S)_PROXY and NO_PROXY, including
  lowercase forms. These are build-download proxies, not the browser's native
  HNS proxy.
- Retry transient 5xx/429 responses and nested transport failures; do not retry
  authentication errors, missing files (HTTP 404), bad checksums, or TLS failures.
- Refuse legacy custom Got agents and insecure TLS download options instead of
  silently ignoring them. This repository does not configure either option.
  Use standard proxy variables or Fetch RequestInit options for future tooling.

`npm ci` runs `scripts/apply-toolchain-patch.js`. It requires the exact packager
version and SHA-256 fingerprints of the original files before applying anything,
then verifies the patched files. Re-running it is idempotent. Unexpected or
partially changed files fail closed and are not overwritten. Git is required;
patch files use LF on every platform. No extra patching package is installed.

Do not use `--ignore-scripts` for packaging. Tests explicitly verify the patch
has been applied. Browser runtime files and packaged assets do not include this
build-only helper, patch, script, or dependency tree.

## Verification and maintenance

Run `npm ci`, `npm audit --audit-level=high`, and `npm test` before packaging.
Toolchain tests use loopback fixtures for verified downloads, corrupt checksums,
headers/progress, 503 retry, body timeout/recovery, cancellation, and proxy/bypass.
They also verify exact dependency pins and the absence of the old cache chain.

Before upgrading the packager, re-review its supported download API, update or
remove this patch, and regenerate the fingerprints only from reviewed sources.
Prefer removing the patch when a stable upstream release supports v5 directly.
An override must not outlive its compatibility proof.

An unsigned unpacked-app smoke build is separate from a release. Signed DMGs,
Windows/Linux artifacts, notarization, upload, installation, and release workflow
dispatch need their normal explicit approval and platform verification.

Verified in the approved cleanup: a fresh locked install, full dev-inclusive audit
with zero vulnerabilities, all 140 tests, and an unsigned macOS arm64 unpacked-app
build. ASAR inspection confirmed runtime modules/IANA data are included and
build-only tooling is excluded. No app installation or release was performed;
signed/notarized and cross-platform package validation remains a later step.
