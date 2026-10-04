# v0.1.26 build candidate

## Authorization and provenance

On 2026-10-04 the owner approved merging PR #28 and making a fresh build.
This authorizes merge and artifact generation/verification, not installation
or public release. Use a new immutable `v0.1.26` version; do not replace the
older v0.1.25 tag, draft assets or installed app.

The accepted runtime baseline is
`6f572b58cdf53ea215c976cc70ee15bf2cbcb41c`. The candidate preparation changes
only package version metadata and this document; application payloads,
dependency versions and lockfile dependency entries remain identical.
Build from the resulting merged `main` commit, recording its full SHA and
the workflow run rather than building from an uncommitted checkout.

## Accepted source checks

- 246 source tests and 142 external-harness tests pass.
- All 17 critical Electron scenarios and nine address-draft checks pass.
- Four unlocked rapid-startup runs pass without a Home-settlement wait,
  including trusted browser input at approximately 196 ms and 354 ms.
- Normal OS-native paste/Return reaches visibly rendered secured content.
- All five provider/UI checks pass with native screenshots; pending TLSA
  does not inherit a different tab's verified state.
- Original hostname, Host header, SNI, actual-port TLSA, path/query and
  strict DNSSEC/DANE checks are preserved.

These are scoped source-acceptance results, not certification of the new
installers. The packaging version must be checked again inside each artifact.

## Build and verification scope

Use the existing artifact-only workflow for macOS arm64/x64, Windows and
Linux. It does not create a GitHub Release and disables Electron Builder
publishing. Download and independently verify all resulting artifacts and
checksums. For macOS, verify Developer ID signatures, Apple notarization,
stapling, Gatekeeper, DMG integrity and read-only mounted bundle contents.
Compare packaged application files with the exact approved source and rerun
packaged acceptance with temporary profiles. Do not copy into /Applications
or touch a user's browser profile.

## Publication remains on hold

- The known upstream Electron POST-reload limitation is not waived by the
  approval to make this candidate. Recheck and disclose it; do not silently
  drop a failing scenario from the release verdict.
- Live HNSDoH reliability is not certified by synthetic fixture passes.
  Web3DNS does not validate DNSSEC; AD=false records remain untrusted for
  TLSA admission. No local DNSSEC validator is included in this candidate.
- Building a candidate does not guarantee continuous HTTPS access to
  `handshake.mercenary` while its validating resolver is unavailable.
- Windows packages remain unsigned unless separately qualified otherwise.

Public release needs a separate decision on these limitations plus completed
artifact/platform verification and explicit publication approval. A successful
CI build alone does not clear those gates.
