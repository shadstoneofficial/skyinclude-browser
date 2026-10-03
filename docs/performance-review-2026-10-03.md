# SkyInclude Browser performance and reliability review

Date: 2026-10-03

Baseline: published v0.1.23, commit `38f577dbe06224a49126c4490587fc9c430c3316`

Decision: approved by Janice to record the review and orchestrate a focused implementation.

## Scope and evidence

The review covered the published source, deterministic synthetic probes, and a
point-in-time resolver health check. The baseline passed all 53 tests. It did not
include a current installed-app CPU, memory, battery, or page-paint benchmark;
there is no claimed percentage speedup.

The saved checkout contains unrelated partial changes based on older source.
Those files must remain untouched. Implementation uses an isolated `codex/`
worktree from `origin/main`. No release, binary publication, application install,
or replacement of `/Applications/SkyInclude Browser.app` is authorized by this
performance implementation.

## Findings and approved first-pass fixes

| Priority | Finding | Evidence | Fix |
| --- | --- | --- | --- |
| High | Native HNS HTTP navigation clears the shared Chromium cache. | `main.js` clears the session cache and adds no-cache headers on each native navigation. | Preserve ordinary HTTP caching; keep an explicit cache-clear/hard-reload action. |
| High | Concurrent DNS lookups duplicate requests. | Ten same-host consumers produced 40 DNS queries in a synthetic probe. | Coalesce pending hostname lookups; cancel work when no consumer needs it. |
| High | Optional TXT/profile data delays a valid website. | A records were ready at 20 ms, but a 180 ms TXT query delayed navigation to 182 ms. | Keep A/AAAA/CNAME on the critical path; enrich profile metadata separately without changing the chosen website. |
| High | Resolver timeouts measure inactivity, not elapsed time. | A trickling local response completed at 252 ms with a configured 60 ms timeout. | Add absolute deadlines, response limits, and cancellation; return the internal outage page without waiting for manifest metadata. |
| High | ICANN classification is incomplete. | `.shop`, `.online`, `.finance`, and `.photography` are wrongly sent to HNS resolution. | Vendor official IANA TLD data for offline classification, with a documented HNS collision policy and update procedure. |
| High | A slow earlier navigation overwrites a newer one. | Both published code and the local partial implementation loaded the earlier URL after the newer URL. | Guard state mutations and loads with a navigation identity; cancel superseded and closed-tab work; expose Stop. |
| Medium | Background throttling is globally disabled. | Three Chromium switches disable timer/renderer/background throttling. | Restore Chromium's default background throttling. |
| Medium | History and diagnostic logging block the main process. | Navigation writes full history and request logs with synchronous filesystem calls. | Debounce and atomically write history; queue and rotate logs; flush persistence on quit. |

The live resolver sample from this machine returned HTTP 403 from the primary
resolver, a successful Web3DNS response, and a Shakestation timeout. This is
environment-specific evidence, not proof that a service is globally unavailable
and not sufficient by itself to change the default resolver order.

## Non-negotiable behavior

Native HNS A/AAAA websites win, followed by native CNAME websites. HeadlessDomains
identity fallback is allowed only after authoritative absence of web records.
Timeouts, transport errors, SERVFAIL, rate limits, and cooldowns are temporary
failures. They must not automatically open raw manifest JSON or cache an identity
fallback as a website result. Explicit manifest navigation stays ordinary HTTPS.

Keep the loopback proxy, visible native hostname, original Host header, TLS SNI,
and DANE/TLSA certificate checks. Do not weaken certificate verification or send
unresolved HNS names to traditional DNS as a performance shortcut.

## Product roadmap

The focused pass may add address-bar search and clearer loading/Stop behavior.
Unsupported settings should be labeled honestly. A full tracker blocker,
bookmarks, session restoration, sleeping tabs with audio/download/form exceptions,
and migration from BrowserView to WebContentsView remain separate follow-ups.
They need their own compatibility and user-experience validation.

## Verification and handoff

- Add deterministic regression tests for the findings, including native cache
  reuse, overlapping navigation, cancellation, shared DNS queries, optional TXT,
  absolute deadlines, persistence ordering, and offline ICANN classification.
- Run the complete suite, syntax checks, whitespace checks, and public-repository
  hygiene scans.
- Keep original website/manifest/action, outage/recovery, Host, hostname, SNI,
  and DANE/TLSA tests green.
- Commit and push the isolated branch, and open a draft PR for review.
- Record final test counts and remaining manual smoke-test limitations here.

## Sources

- [Electron performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Electron background throttling](https://www.electronjs.org/docs/latest/api/web-contents#contentssetbackgroundthrottlingallowed)
- [IANA root zone database](https://www.iana.org/domains/root/db)
- [Node HTTP timeout behavior](https://nodejs.org/api/http.html#requestsettimeouttimeout-callback)

## Implementation outcome

Branch: `codex/performance-reliability-oct2026`, based on the baseline above.

The first-pass fixes are implemented, including offline IANA classification,
shared DNS lookups, absolute network deadlines, nonblocking optional TXT,
navigation cancellation, normal HTTP caching, background throttling, queued
logs, and atomic debounced history. The integration review additionally caught
and fixed stale metadata/HTTPS banners, redirect address-bar regressions,
uppercase URL and host:port handling, POST-preserving Reload, CONNECT IPv6/port
handling, active-upload timeouts, and delayed disconnect cancellation. Early TLS
bytes are retained in a bounded buffer while a CONNECT target is resolved.

Address-bar search and configured new-tab homepages now work. Reload becomes
Stop while loading, and Escape stops navigation. JavaScript preferences apply to
new tabs. The UI no longer advertises an implemented P2P client or active tracker
filter, and certificate verification remains enforced.

### Behavior matrix

| Situation | Website/navigation | Profile | Actions | Manifest |
| --- | --- | --- | --- | --- |
| Native A/AAAA or CNAME plus manifest/actions | Native website wins; Host/hostname stay native | TXT profile enrichment can arrive later | Explicit public-page choice | Explicit direct URL; cannot displace the website |
| Authoritative no web records | Existing HeadlessDomains identity fallback | Available per identity metadata | Explicit public-page choice | May be the existing identity fallback destination |
| All resolvers temporarily unavailable/cooling | Internal temporary-unavailable page; not cached as a website | Explicit canonical link | Explicit canonical link | Explicit canonical link only; no automatic JSON navigation |
| Resolver recovers after transient failure | Retry returns the native website | Optional enrichment | Explicit choice | Does not remain cached as a fallback |
| Ordinary ICANN site | Normal hostname/DNS/WebPKI route | No automatic HNS metadata | Normal website behavior | Normal website behavior |
| Explicitly entered manifest URL | Ordinary HTTPS navigation to that exact URL | No automatic HNS lookup | No automatic HNS lookup | Opens as requested |

### Verification results

- Complete suite and syntax checks: **132/132 passed**, repeated three times
  with zero failures, cancellations, or skipped tests.
- Original native website/actions/manifest, outage/recovery, Host/hostname,
  SNI, and DANE/TLSA tests remain green.
- Real loopback HTTP/TCP tests verify cache headers, native Host ports,
  transparent CONNECT bytes, uploads, upstream teardown, and prompt cancellation.
- `git diff --check` passed. Sensitive-file and large-file scans were clean;
  broad credential-word hits were reviewed as validation code, test fixtures,
  or existing signing documentation/environment-variable references.
- Runtime modules and the IANA asset are included in the packaging file list;
  no dependency or version bump was needed. No binaries were built or published.
- The saved dirty checkout retains its original modified/untracked file set.
- Dependency audit: `npm audit --package-lock-only --audit-level=high` failed
  with 9 high and 1 moderate findings in the unchanged build-tool dependency
  lockfile. Findings include brace-expansion, fast-uri, and the
  http-cache-semantics/cacheable-request/got chain used by Electron build tools.
  This is an inherited merge/CI blocker, not introduced by these source changes.
  The audit's forced remediation suggests changing electron-builder to 26.5.0;
  no forced downgrade, dependency update, or audit-policy bypass was applied.

Reproduce the offline probes with `npm run benchmark:resolver`. One run on this
machine gave ten consumers **4 DNS requests** (baseline: 40), native web ready at
**21 ms** while TXT enrichment completed at **182 ms**, and a trickling response
rejected after **63 ms** for a **60 ms** deadline (baseline completed at 252 ms).
These are synthetic timing observations, not promised real-world page speedups.

The dependency-audit failure above describes the initial implementation handoff;
the approved follow-up below supersedes that blocker.

Remaining at the initial handoff before merge/release: manual Electron UI smoke tests of the documented
HNS/ICANN targets, multi-tab background behavior, native HTTPS trust indicators,
and POST reload prompts. Installed-app CPU/memory/battery/page-paint benchmarks
and cross-platform packaged-app checks were not run. The draft PR is a source
review handoff, not a release approval.

## Approved dependency/toolchain follow-up

The user approved dependency/toolchain cleanup after the first implementation
handoff. See [toolchain maintenance](toolchain-maintenance.md) for the pinned
versions, audit rationale, guarded compatibility patch, and future upgrade rules.

- Refresh compatible brace-expansion and fast-uri patches; remove the vulnerable
  Got/shared-cache dependency chain by using the public Fetch downloader API.
- Preserve the already-locked Electron 42.11.3 and stable packager 26.15.3;
  pin the build dependencies and align CI/README with Node 22.12.0+.
- Keep the full dev-inclusive audit gate. The patch refuses unknown packager
  versions/files, preserves verified downloads, progress, retry, body deadlines,
  and HTTP proxy/bypass support. Browser proxy/Host/SNI/DANE paths are unchanged.
- Fresh `npm ci` applies and verifies the patch; `npm audit --audit-level=high`
  now reports **0 vulnerabilities**.
- Full suite: **140/140 passed**, including eight new build-tool tests, with
  zero failures/skips/cancellations. Existing native HNS/ICANN and manifest,
  resolver-recovery, Host/hostname, DANE/TLSA, and SNI regressions remain green.
- An unsigned macOS arm64 unpacked-app smoke build passed using explicit
  `identity: null`, `notarize: false`, and `publish: never`, outside the repository
  in a temporary output directory. No installer, DMG, signed/notarized build,
  release/tag, binary publication, app installation, or `/Applications` replacement
  was performed. Cross-platform packaging and manual UI verification still remain.
- Packaged ASAR inspection verified the runtime modules and IANA snapshot are
  present and build-only tools are excluded. Staged whitespace, sensitive-file,
  credential-pattern, large-file, and generated-binary hygiene checks are clean.

## Approved source merge and release handoff

On 2026-10-03 the user requested merging and deploying the approved work, and
asked whether to involve the existing build agent. This supersedes the earlier
source-only approval boundary; it does not authorize replacing the installed app
or bypassing release verification.

The complete suite passed again (**140/140**, no failures, cancellations, or
skips), the dev-inclusive audit reported **0 vulnerabilities**, and source CI
was green. The isolated worktree is the only source of this PR; the saved dirty
checkout remains untouched.

### Real Electron UI smoke evidence

These checks used Electron 42.11.3 with the extracted unsigned packaged runtime
and a temporary bootstrap redirecting user data, session data, and logs to a
disposable directory. They did not use or modify the installed app or its
profile. This is runtime UI evidence, not acceptance of a final signed installer.

- `lisa.agent` rendered its native HTTP website with `lisa.agent/` visible and
  the Native HNS HTTP indicator. The original tab remained intact while opening
  and navigating another tab.
- Google HTTPS rendered normally with its HTTPS indicator and without a stale
  HNS profile indicator. New-tab navigation worked.
- An explicitly entered manifest URL started ordinary HTTPS navigation to that
  URL; the endpoint returned HTTP 200. The computer-use inspection failed on
  the raw JSON view, so its rendered body is not claimed as visually verified.
  Deterministic direct-manifest regressions remain green.
- Explicit `https://skyinclude/` displayed the internal TLSA Resolver Failure
  page and its corresponding trust indicator when live TLSA providers failed.
  Certificate verification was not weakened or bypassed.
- Bare `skyinclude` and `handshake.mercenary` resolved native A records but their
  HTTP-to-HTTPS redirects hit `ERR_CERT_AUTHORITY_INVALID`. An isolated source
  checkout of baseline commit `38f577d` reproduced the `skyinclude` failure with
  the same certificate rejection. The verifier and default opt-in DANE setting
  are unchanged by this PR. This inherited redirect/trust UX remains a follow-up,
  not evidence of a new performance regression.
- An inert loopback-only POST form submitted successfully. Reload did not
  visibly confirm a resubmission or produce a second POST, so the manual POST
  prompt/resubmission case remains unverified. No real form or transaction was
  submitted. The deterministic reload test confirms use of native reload rather
  than replacing POST history with a fresh GET navigation.

Source merge is approved; public binary publication still requires signed and
notarized macOS verification, Windows/Linux packaging and launch checks, and the
remaining packaged UI acceptance cases (including POST reload, background-tab
behavior, and a successfully DANE-verified native HTTPS site). A new build should
use a new patch version, expected `v0.1.24`, from a verified final `main` commit;
do not rebuild or move the published `v0.1.23` tag.

During UI checks this Mac reported ENOSPC and approximately 239 MiB free. Do not
start a local installer build or bulk artifact download until adequate storage is
available. No user files were removed to work around this condition. The temporary
browser instances were closed after testing. No release workflow, new tag,
binary publication, app installation, or `/Applications` replacement was performed
as part of these checks.
