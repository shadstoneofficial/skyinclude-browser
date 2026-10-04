# Startup address draft protection — 2026-10-04

## Finding and scope

Source acceptance at `85656f5efcbaa30ce8f723fb61831ea21176bee8`
recorded an unlocked rapid-startup diagnostic in which `updateLoadingState`
called `updateAddressBar` for Home and cleared the address before trusted Enter.
The rapid diagnostic assigned the input value directly; normal visible native
paste/Enter passed. This is evidence of an unprotected address draft, not proof
that every ordinary startup navigation fails.

Source review confirmed that loading, tab and initial-state callbacks all wrote
the input unconditionally. They could also reselect it through a deferred Home
focus callback. The fix changes renderer address ownership only. It does not
add a Home-settlement delay, alter resolution, weaken an acceptance assertion,
or change proxy, original Host, native hostname, SNI, DANE/TLSA or IPC trust.

## Address field behavior

| Event | Result |
| --- | --- |
| Same-tab background update while editing | Keep the focused draft and its selection; update underlying page state. |
| Initial Home state arrives while editing | Keep the draft, including before the first tab ID is known. |
| Enter on a nonempty draft | Submit the captured address and release protection for subsequent navigation/redirect updates. |
| New edit during a pending navigation | Protect the new draft from the older navigation's updates. |
| Empty Enter | Do not navigate or end the edit. |
| Escape during an edit | Restore the latest underlying page address; do not also stop loading. |
| Address field loses focus | Restore the latest underlying page address. |
| Switch to another tab | Show that tab's address, never the previous tab's draft. |
| Focused but unedited field | Continue following navigation and redirects normally. |

`addressBarDisplayValue` is the last value supplied by the renderer (or accepted
at explicit submission), separate from `currentUrl`. A changed, focused value
belongs to the user until submission, cancellation, blur or tab change. This
also covers the direct-value diagnostic without relying on synthetic input
events. `addressBarTabId` tracks the field's owner independently of asynchronous
tab-switch completion. Deferred focus work is scoped to its tab and navigation
request and never reselects an already-focused address field.

## Verification and handoff

- Added ten deterministic renderer regressions exercising the actual constructor,
  listeners and update methods with a minimal DOM/IPC fixture and no user profile.
- Before the fix: seven regressions failed, including the Home-cleared-address
  reproduction. After the fix: all ten pass.
- Full `npm test`: **246/246 pass**, zero failures/skips, including existing
  native HNS, TLSA, Host/SNI, ICANN and explicit-manifest regressions.
- `npm audit --audit-level=low`: zero vulnerabilities.
- Syntax/whitespace checks and repository hygiene inventory pass. No binaries,
  profile data, credentials or delivery artifacts were added.

Independent source-Electron acceptance must rerun at the exact new commit:
rapid-startup trace with no Home wait, trusted input/Enter, normal visible
navigation, all critical scenarios, provider UI, editing/cancellation/tab
behavior, and original Host/SNI/port/path verification. Record any remaining
counterexample rather than replacing it with one green run. Source tests are
not signed-package acceptance.

PR #28 remains draft. The existing unrelated documentation edits are excluded
from this change. No package version, build, signing, merge, release,
installation, personal profile or production DNS/site change is authorized by
this startup-fix handoff. The upstream Electron POST-reload limitation and live
HNSDoH reliability/trust gates remain separate and unwaived; Web3DNS AD=false
records do not become trusted TLSA data.
