# Native HNS HTTPS recovery — 2026-10-04

## Report and diagnosis

Opening `handshake.mercenary` showed a blank page followed by
`ERR_FAILED (-2)` while redirecting from native HTTP to native HTTPS.
The new website was already deployed; replacing DNS or undoing the design
upgrade was not indicated by the evidence.

Read-only checks found:

- The native A record points to `168.144.102.205`.
- HTTP redirects to `https://handshake.mercenary/`, which serves the updated site.
- The server's public-key SHA-256 matches TLSA `3 1 1`:
  `530d46ec4e4ee9a13aa937fa0667b59c175402c0b24399ac8ed2959687c04d23`.
- A validating HNS recursive resolver returned AD for the A and TLSA answers;
  direct authoritative answers included signatures. Resolver failures were also
  observed, so this is point-in-time evidence, not an uptime guarantee.
- The existing browser prepared DANE trust for directly entered HTTPS URLs but
  not for a cold HTTP-to-HTTPS redirect before Chromium's certificate check.
- The JSON fallback rejected underscore-prefixed TLSA service names. Existing
  wire-format endpoints returned authenticated answers with the corrected
  RD+AD/EDNS-DO query format during live checks.
- Real Electron acceptance reproduced an additional same-host form bug:
  navigation interception changed POST into GET before a 307/308 redirect.
  Same-native-host submissions now remain on Chromium's original request path.
- A rapid first navigation exposed an older homepage abort rejecting the current
  load promise with numeric error `-3`. That abort must not replace a successful
  HTTPS document with an error page.

## Fix boundaries

The change adds shared, endpoint-scoped DANE admission at the native proxy's
CONNECT boundary and authenticated TLSA failover. It does not rewrite redirects,
intercept TLS application bytes, disable certificate checks, alter the website,
change production DNS, replace default resolver operators, or install an app.
The existing website-before-identity rules remain in effect.

| Situation | Website outcome | Profile/actions/manifest outcome |
| --- | --- | --- |
| A/AAAA or CNAME plus manifest/actions | Native website wins | Identity metadata cannot displace it |
| Cold HTTP → HTTPS with authenticated matching TLSA | Native HTTPS after DANE admission | No automatic identity navigation |
| Authoritative absence of web records | Existing identity fallback | Existing HeadlessDomains fallback remains available |
| Temporary website DNS outage | Internal unavailable page and retry | Explicit profile/actions/manifest links where applicable |
| Temporary TLSA outage or unauthenticated TLSA | Internal HTTPS status; no silent downgrade | Never an automatic manifest redirect |
| Published TLSA mismatch | Blocked, fails closed | No manifest or HTTP bypass |
| Different certificate for a hostname already trusted this browser session | Blocked; restart browser to reverify legitimate rotation | No manifest or automatic downgrade |
| Ordinary ICANN URL | Normal DNS and WebPKI | Unchanged |
| Explicit manifest URL | Direct HTTPS navigation | Manifest opens because the user chose it |

## Verification and release gate

Source handoff checks on 2026-10-04:

- `npm test`: 191 passed, zero failed/skipped (including syntax/toolchain checks).
- `npm audit --audit-level=high`: zero vulnerabilities.
- `git diff --check`: clean.
- Repository hygiene: 60 tracked/untracked non-ignored source files scanned;
  no credential/private-key patterns, generated binaries/logs, oversized files,
  or runtime machine-local paths found.
- Independent source re-review: no remaining actionable findings.
- Real Electron 42.11.3 passed all 17 critical fixture cases at `0223337`,
  including direct HTTPS, cold redirects, real POST 301/302/303/307/308,
  certificate rejection, cross-port pinning, and rapid initial navigation.
  The form-conversion and stale-homepage-abort failures were fixed and retested.
- Trusted website-outage Retry/Reload bypasses local cooldown. The real browser
  recovered on its first Retry, clicked 115 ms after a synthetic resolver
  failure. Cold-redirect TLSA recovery retained the native query and fragment.
- Both GitHub CI checks passed at `0223337` (dependency audit/tests and Windows
  toolchain patch). The build agent independently reran all 191 source tests.
- These are source-runtime fixture results, not signed-package acceptance.
  Live-site acceptance is still blocked as detailed below. No merge or release
  is approved by these results.

Automated source coverage includes DNSSEC request flags and response validation,
TLSA failover/cooldowns, non-default ports, cancellation/deadlines, native CONNECT
admission, endpoint-scoped certificate trust, redirect failure UI, and recovery.
The full suite and repository hygiene checks must pass before source handoff.

Independent review identified a cross-port certificate-cache ambiguity in
Electron's hostname-only verifier. The containment is a process-lifetime,
single-SHA-256-fingerprint lock per HNS hostname, in addition to endpoint-specific
TLSA admission. Cache clearing cannot remove this lock; legitimate certificate
rotation requires a browser restart. Distinct certificates on simultaneous
ports of one hostname are intentionally unsupported until a safely
endpoint-bound verification mechanism is available.

Packaged acceptance must additionally verify cold redirects, real POST 307/308
requests, resolver outage/recovery, mismatch rejection, and native hostname,
Host, SNI, and path/query preservation. Previous v0.1.25 acceptance evidence is
retained, including its unsuccessful POST-reload check; it is not a full pass.
The build agent must use the reviewed merged source and a new immutable patch
version. Do not publish the older draft as if it contains this fix.

### Live acceptance blocker: validating resolver availability

One cold, read-only browser navigation at 03:20 UTC on 2026-10-04 used the
unchanged default resolver order and a fresh temporary profile. Address lookup
recovered through Web3DNS, then native HTTP redirected to HTTPS. All configured
TLSA providers failed:

| Provider | Observed TLSA result |
| --- | --- |
| HNS DoH | HTTP 403: DoH dropped query |
| Web3DNS JSON | HTTP 400: service name rejected as invalid FQDN |
| Shakestation DoH | Request deadline exceeded |

The browser retained `https://handshake.mercenary/` and displayed
`Native HTTPS temporarily unavailable`, with certificate validation explicitly
not verified. It did not render the updated HTTPS site, claim DANE success,
silently downgrade, or navigate to a manifest. This verifies safe failure, not
successful live loading.

Two further read-only DNS-only checks at 03:27 UTC tested the existing
operator's [documented regional endpoints](https://welcome.hnsdoh.com/).
Australia returned the same HTTP 403; Asia refused the connection. These
point-in-time results are not a global uptime claim. No provider defaults,
user settings, production DNS, or certificate trust were changed.

Next gate: qualify a reliable authenticated DNSSEC-validating TLSA resolver,
review any provider/configuration change, and rerun cold live navigation with
native hostname, Host, SNI and DANE preserved. Do not remove authentication
requirements or bypass certificate checks to turn this into a passing result.
The PR remains draft until this live-loading gap has an accepted resolution.

The build agent retained the 17-case summary, individual reports, live-failure
report, screenshots, and runtime SHA-256 inventory separately from the public
repository. Temporary profiles, session data and synthetic private keys are
not part of that evidence archive or this PR.

### Separate known limitation: POST reload

Real Electron acceptance reproduced toolbar Reload doing nothing after an
already completed POST, including on ordinary localhost (not just HNS).
Electron 42.11.3's [native reload implementation](https://github.com/electron/electron/blob/v42.11.3/shell/browser/api/electron_api_web_contents.cc#L2586)
documents this unimplemented repost-confirmation path. It is distinct from
the same-host form and 307/308 fixes. Do not report POST reload as passed or
silently work around it with automatic resubmission, captured request bodies,
or a global disable-confirmation flag. A safe follow-up requires explicit user
confirmation and separate acceptance coverage. Publication remains gated on an
explicit decision about this known limitation.
