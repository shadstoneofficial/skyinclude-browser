# HNS HTTPS admission and stale status — 5 October 2026

## Evidence and scope

Owner-authorized report from the local “Diagnose SkyInclude DNSSEC failure”
chat, based on Mike's running v0.1.27 arm64 app, extracted packaged source,
sanitized logs, controlled UI navigation and isolated reproduction. These are
reported observations from that machine, not a fresh reproduction on Janice's.
No credentials were submitted, settings changed, app reinstalled or trust bypassed.

- HNSDoH binary DoH intermittently returned HTTP 403 (“DoH dropped query”).
  Web3DNS binary DoH supplied addresses and TLSA records with AD=false.
  Rejecting those TLSA records was correct. The cause of the remote 403 is unknown.
- At 10:15:56 Bangkok, skyinclude succeeded with fresh authenticated HNSDoH
  answers; at 10:16:46 mercenary failed; at 10:17:24 handshake.mercenary succeeded.
  A separate probe batch saw all six HNSDoH requests fail and all six Web3DNS
  responses unauthenticated. This is not proof of a permanent outage.
- The mercenary HTTPS availability banner and action survived navigation to
  other hosts, including a failed handshake.mercenary page. This was stale UI,
  not proof of cross-host certificate trust.
- At 10:24:13 a Login link failed after the five-minute trust entry expired.
  The log said “Navigation cancelled”, with no structured admission failure.
  Retry at 10:28:08 loaded the login form with fresh authenticated HNSDoH data
  and matching DANE certificate. No login was submitted.
- Isolated reproduction showed both the CONNECT deadline and a client socket
  ending produced that same cancellation message. It did not establish which
  caused the live Login incident.

## Implementation

- Bind banner actions to originating tab, URL and navigation revision. Dismiss
  on new navigation/loading or tab/page changes, reject late actions, and do not
  offer HTTPS when already on an HTTPS page. Old notification timers cannot
  dismiss newer notices.
- Cap each TLSA/address attempt in CONNECT at 2.5 seconds and certificate probe
  at 4 seconds (a smaller configured setting still applies), rather than allowing
  every stage to consume the 15-second CONNECT deadline. The total deadline
  remains bounded; arbitrary custom-provider lists are not guaranteed to finish.
- Distinguish CONNECT_TIMEOUT from CLIENT_DISCONNECTED. Record timeout stage,
  elapsed time and sanitized TLSA attempt metadata; preserve lookup context on
  the status page. Do not report a certificate inspection failure when only the
  overall secure connection failure is known. Cancellation does not cache an
  outage against the next navigation.
- Preserve strict authenticated TLSA, validity and certificate matching, exact
  endpoint trust, native Host/SNI, opaque tunnel bytes and Chromium form handling.
  No automatic POST replay, insecure fallback or raw manifest navigation added.

## Validation / review gates

Automated tests cover deadline vs disconnect, resolver-progress propagation,
primary timeout followed by authenticated fallback, failed certificate admission,
stale banners across hosts/tabs/navigation revisions, and exact GET/POST/Host/SNI
through a fresh tunnel after trust expiry. Existing DNSSEC, ICANN, manifest,
proxy and Reload/form tests remain required.

Implementation verification on this branch: `npm test` **262/262 passed**,
`npm audit --audit-level=high` **0 vulnerabilities**, `git diff --check` clean.
Repository scans found no secret/key files or files over 5 MB; keyword matches
were reviewed as source identifiers, signing environment-variable references,
documentation and deliberately fake test values. Dependencies were installed
only in the isolated worktree, with Electron binary download disabled.

Before any new release: review this change, run packaged Electron UI acceptance
on a disposable profile, exercise same-host Login after expiry and verify banner
clearance. Do not equate Node/socket regression tests with packaged acceptance.
No version bump, installed-app change, binary build or release is included.

## Roadmap / unresolved work

### October 29 acceptance restart

The unchanged PR passed all 262 tests again. Its previous clean dependency audit
was superseded by newly published advisories. Acceptance now uses Electron
42.11.18 (same major), Undici 7.30.1, nested build-time Undici 6.29.1 and fast-uri
3.1.9. Electron Builder remains 26.15.3. The updated lockfile reports zero
vulnerabilities and all 262 tests pass. Packaged acceptance and fresh CI are
still required; this dependency refresh does not certify live resolver uptime.

References: [Electron advisory](https://github.com/advisories/GHSA-x562-297c-g43g),
[Undici advisory](https://github.com/advisories/GHSA-2m5v-pch6-74hx).

Packaged arm64 acceptance at source `110c0bdc0976ecbb02efabb245571b40671998bf`:

- 17/18 broad synthetic cases passed: direct DANE, all redirect methods,
  outages/recovery, missing/malformed/unvalidated TLSA, certificate mismatch,
  cross-port protections and rapid startup. The synthetic POST toolbar case
  timed out waiting for a resend; it does not operate the native recovery sheet.
  Retained as a failed synthetic case, not relabeled as a pass.
- Separate native-toolbar and actual-sheet checks passed for HTTP and DANE
  HTTPS POST: Cancel sent nothing; each explicit confirmation sent exactly one
  original-body POST. HNS Host, SNI and TLSA service port were preserved.
  Dialog options confirmed Cancel as default/cancel; the actual Cancel action
  was clicked, not a successful Return-key test.
- PR-specific packaged checks passed: real verified availability banner,
  clearing on HTTP→HTTPS and cross-host failure, no redundant HTTPS offer,
  and fresh TLSA verification after simulated trust expiry/cache invalidation
  followed by same-host navigation. This is not a natural five-minute wait.
- All tests used disposable profiles and loopback fixtures. Test CA trust was
  scoped to child processes; no installed app or system trust store changed.
  Runtime hashes matched the commit. The local app is unsigned; these checks
  are not evidence of signing/notarization or live resolver reliability.

The follow-up candidate version is 0.1.28. Fresh CI and signed-package checks
are required before handoff. No public release publication is included.

1. Complete review and packaged acceptance of these immediate UI/diagnostic fixes.
2. Investigate HNSDoH 403 with operator evidence and timestamps, without assuming
   a rate-limit, blocking policy or server-side cause. Do not hammer the endpoint.
3. Qualify an independently validating fallback. Web3DNS remains a record source,
   not a DNSSEC validator; AD=false must not authorize DANE.
4. Keep authenticated Handshake root/DS and local-validation research separate.
   This browser does not wait for a local blockchain sync.
