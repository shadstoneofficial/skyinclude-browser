# Reload after form submission

## Cause and scope

Electron 42.11.3's `WebContents::Reload` requests Chromium's repost check,
but its implementation documents that the approval continuation is missing and
POST reload can silently fail. A disposable local form reproduced this with no
navigation events and no second request, independently of HNS resolution.

Upstream implementation:
<https://github.com/electron/electron/blob/v42.11.3/shell/browser/api/electron_api_web_contents.cc#L2798-L2813>

This is separate from resolver availability and does not qualify an additional
DNSSEC-validating resolver or change the live handshake.mercenary trust chain.

## Behavior

| Reload outcome | Browser behavior |
| --- | --- |
| Native navigation starts | Normal Electron reload; no recovery prompt |
| No main-frame navigation starts within 1.5 seconds | Offer a Cancel-first warning that reloading may repeat a login, post, or purchase |
| Cancel or close the warning | No recovery request |
| Explicitly choose Reload and resend | Chromium `Page.reload`, guarded by the original document loader ID |
| Navigate, Stop, switch tabs, or close the tab before approval | Discard stale recovery |
| Debugger already attached, or command rejected | Do not take over the debugger, reconstruct a request, or retry automatically; show a safe failure message |
| Internal error page or resolution still pending | Existing original-address retry behavior remains unchanged |

The watchdog detects a reload that did not start, **not proof of a POST**. Slow
or otherwise stalled navigation may also offer the conservative warning. It
never resends anything without explicit approval. Cancellation remains the
default; form data is neither inspected nor stored by the application.

The temporary debugger attaches only to the relevant webContents, opens no
remote debugging port, and detaches after the operation. Chromium retains the
HTTP method, form body and navigation history. The browser does not use
`loadURL` to replace a POST with a GET. Native hostname, Host header, proxy,
SNI and DANE/TLSA verification remain on the existing paths.

## Verification and release gate

- Regression tests cover confirmation, cancellation, duplicate attempts,
  navigation/Stop/closure/tab-switch races, loader guard rejection, debugger
  ownership and watchdog cleanup.
- Full source suite: 258 tests passed (2026-10-04).
- Electron 42.11.3 arm64 disposable source test: actual toolbar DOM click,
  one cancellation followed by two confirmed reloads; exactly three total POSTs
  with identical encoded form bodies. Dialog responses were supplied by the
  test harness; this is **not native dialog visual acceptance**.
- Ordinary GET toolbar reload also passed without a recovery prompt. The 16
  source-level HNS scenarios passed: DANE, HTTP-to-HTTPS redirects including
  POST 301/302/303/307/308, resolver/TLSA outage recovery, certificate and TLSA
  rejection, and cross-port certificate pinning. The older ungated startup
  scenario timed out. A targeted rerun with the first-rendered-tab acceptance
  gate also timed out waiting for fixture content. Both failures remain open
  acceptance findings; do not claim all startup checks passed or proceed to a
  new build until the acceptance owner diagnoses them.
- Before a new build: review this change and check the real Cancel/default and
  Reload and resend controls on an unlocked Mac, including normal GET reload,
  repeated POST reload, Back/Forward, and a secured native HNS form fixture.
- Before publication: repeat acceptance on newly signed packages. Existing
  v0.1.26 artifacts and tag must not be modified to pretend they contain this fix.

No installed application, normal browsing profile, certificate trust settings,
live forum submission, release or binary is changed by the source tests.
