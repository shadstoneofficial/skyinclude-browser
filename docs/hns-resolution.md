# HNS Resolution Architecture

SkyInclude Browser supports Handshake (HNS) domains without requiring the operating system DNS resolver to know about HNS.

### HTTPS admission reliability

The browser uses remote resolvers; initial failures are not a local blockchain
sync phase. Address resolution and authenticated TLSA identity checks are separate.
Web3DNS may supply an address without being able to provide validated TLSA data.
HTTP 403, timeouts and unvalidated answers are not authoritative website absence
and must not authorize DANE or automatic manifest fallback.

CONNECT retains a 15-second total setup deadline. DNS attempts are capped at
2.5 seconds and certificate probes at 4 seconds (smaller configured timeouts still
apply), reserving time for the default fallback sequence. Custom resolver lists
may still exceed the total budget. Deadline expiry and client disconnect are
distinct diagnostics; a timeout retains available TLSA attempt provenance and
offers an explicit retry, without automatically replaying forms or weakening trust.
HTTPS availability actions are scoped to their tab, page and navigation revision.

See [the October 5 incident and review gates](hns-admission-incident-2026-10-05.md)
for evidence, tests, and the separate unresolved HNSDoH reliability investigation.

## Flow

1. User enters a URL such as `setup.skyinclude`.
2. The browser normalizes it and detects that the hostname is likely HNS.
3. The main process attempts HNS resolution through DNS-over-HTTPS.
4. If an address is found, the browser loads the native HNS URL through the local HTTP proxy.
5. The proxy forwards the request to the resolved IP address while preserving the original `Host` header.

## Resolver Transports And Failover

SkyInclude supports two HTTPS resolver transports:

- `doh-wire`: RFC 8484-style DNS wire messages sent over HTTPS.
- `dns-json`: HTTPS APIs that return a DNS JSON response, including Web3DNS.

Resolver settings are ordered. SkyInclude asks one endpoint for A, AAAA, and CNAME and starts an optional TXT query alongside them. The website decision waits for a consistent authoritative status across the three web record types, but a valid native website does not wait for TXT/profile metadata. Late TXT can enrich the profile indicator and cache without changing the chosen website. TXT redirects remain available for ordinary HNS names only after authoritative absence of web records. Optional TXT from a failed endpoint cannot be mixed into the winning endpoint's result.

SkyInclude uses the next endpoint only when the critical web queries have a transport failure, TLS/HTTP error, malformed response, DNS failure status such as `SERVFAIL`, or inconsistent status across record types. An optional TXT failure does not invalidate a valid website. It does not merge answers from different operators.

Authoritative `NXDOMAIN` and successful `NOERROR` with no records are terminal answers for that lookup. This prevents a fallback resolver with a different collision policy or stale root view from silently replacing an authoritative result.

These authoritative answers are distinct from temporary resolver failures. A timeout, transport or TLS/HTTP error, rate limit, `SERVFAIL`, malformed response, or the local resolver cooldown means that SkyInclude does not know whether web records exist. It must not convert that uncertainty into an identity fallback or cache it as a website result. Instead, the browser shows an internal “Native website temporarily unavailable” page with Retry and explicit links for native HTTP and, when applicable, HeadlessDomains profile, actions, and manifest views.

After an endpoint failure, an in-memory circuit breaker skips it for 30 seconds. This prevents every navigation from paying the full timeout while a community resolver is offline. Changing resolver settings or clearing the resolver cache resets this local health state.

An explicit Retry or Reload from the matching generated website-outage page
bypasses that cooldown for a fresh attempt. Ordinary navigations cannot use this
bypass, and an ordinary in-flight lookup cannot absorb the explicit retry.

Website and TLSA lookups have separate circuit-breaker health. An endpoint that
cannot answer TLSA service names must not disable otherwise working A/AAAA/CNAME
resolution, and a website-query cooldown must not prevent an independent TLSA
attempt. Resolver order and customized endpoint lists are preserved.

### Deadlines, shared work, and caching

Concurrent lookups for the same normalized hostname and resolver configuration
share one pending resolution. Cancelling one tab removes only that consumer;
underlying DNS requests are aborted when no pending consumer needs them. Each
network query has an absolute deadline starting before connection establishment,
not just a socket-inactivity timeout. Response bodies are bounded: 65,535 bytes
for binary DNS, 256 KiB for DNS JSON, and 1 MiB for identity metadata. Fallback
endpoints may consume additional per-query deadlines.

A website is returned as soon as the critical web-record queries finish.
Optional TXT enrichment can finish after the website lookup's consumers settle;
it remains deadline-bounded, and its UI update is guarded by the current tab,
navigation identity, and hostname. Resolver outages return canonical identity
links immediately without waiting for HeadlessDomains metadata. Transient
failures are never cached. Clearing caches prevents older in-flight website or
TLSA answers from repopulating them.

Native HNS HTTP navigations retain Chromium's normal HTTP caching behavior.
Loading a native site does not clear the shared session cache or force no-cache
headers. The explicit Clear Cache and Reload command still clears page and
resolver caches. Ordinary Reload calls Electron's native reload API; reloading
an internal outage page retries resolution. Electron 42.11.3 has an upstream
POST-reload limitation: its repost-confirmation path can silently do nothing.
SkyInclude does not bypass that confirmation or reconstruct/resend form data.
Native same-host form submissions and 307/308 redirects are separately tested;
they must not be confused with resubmitting an already completed POST via Reload.
See the [upstream reload implementation](https://github.com/electron/electron/blob/v42.11.3/shell/browser/api/electron_api_web_contents.cc#L2586).

The loopback proxy limits connection work and the post-upload wait for initial
response headers to 15 seconds each, and HTTP stream inactivity to 60 seconds.
An active upload is not subject to the connection/header deadline. It does not impose a total-duration deadline on
downloads/media or an established CONNECT tunnel. Client disconnects cancel
pending resolution and upstream sockets. Native Host headers include an explicit
non-default port; TLS SNI still uses the native hostname.

### Offline ICANN/HNS classification

`assets/icann-tlds.json` contains the official IANA TLD list with source/version
metadata. Classification needs no runtime network request. Multi-label names
under delegated ICANN suffixes use ordinary DNS/WebPKI, including `.shop`,
`.online`, `.finance`, and `.photography`. DNS names are normalized for case,
trailing root dots, and IDNA; IP literals are handled separately.

For compatibility, single-label roots and explicit HNS namespace hints
(`hns`, `agent`, `chatbot`, `nb`, `sats`, `blockchain`, `crypto`, `mercenary`,
`bit`, `coin`, `wallet`) retain the native HNS route. A future collision for one
of those hints requires an explicit policy change; updating the IANA snapshot
alone cannot silently move an existing HNS namespace to ICANN.

Refresh and review the snapshot with `node scripts/update-icann-tlds.js`.
Use `node scripts/update-icann-tlds.js --check` for a read-only comparison with
the current official list. Normal tests validate the bundled snapshot offline.

Address-bar multi-word text is searched using the configured HTTPS search engine
(`%s` placeholder or legacy query prefix). Single words remain native HNS roots;
`? term` explicitly searches a single word. Direct URLs, including manifest
URLs, remain direct navigation. New tabs use the configured homepage.

### Settings format

The resolver list accepts one entry per line:

```text
doh-wire https://resolver.example/dns-query
dns-json https://api.web3dns.net/
```

Existing URL-only settings remain compatible and migrate to transport descriptors without changing their order. A URL without a transport prefix is treated as `doh-wire`; `api.web3dns.net` is recognized as `dns-json`.

The built-in order is:

1. HNS DoH (`doh-wire https://hnsdoh.com/dns-query`)
2. Web3DNS DoH (`doh-wire https://doh.web3dns.net/`)

Shakestation was retired from active use on 2026-10-04 at the project owner's
direction. Its old endpoint is retained only in the provider archive. New
installs receive the two active entries. Settings migration upgrades untouched
legacy built-in lists and removes the exact retired hostname, including a
retired custom-first endpoint. Other customized endpoints/order remain intact;
the browser does not treat an arbitrary provider's display name or ID as proof
that it is Shakestation. Affected users receive a retirement notice. If removal
leaves a customized configuration without any resolver, the browser asks the
user to select one rather than silently introducing another provider.

The Web3DNS binary DoH endpoint uses the hostname root `/`. SkyInclude preserves
that path instead of appending `/dns-query`. Other providers retain conventional
DoH URL shorthand. The older `https://api.web3dns.net/` JSON adapter remains
supported for existing customized configurations; neither Web3DNS endpoint uses
`/dns-query`. The JSON and binary interfaces are the same provider, not two
independent fallback operators. Native resolver IPs are deliberately not
accepted in this list: native DNS is a different, unencrypted transport and
must not be normalized into a DoH URL.

Endpoint compatibility does not imply DNSSEC validation. A Web3DNS binary TLSA
response observed on 2026-10-04 contained the correct record but AD=false. The
browser must reject it for DANE trust and explain the missing authentication.
See [provider status and pending operator questions](resolver-provider-status.md).

The resolver test in Settings uses the saved resolver order and reports the endpoint name, transport, DNS status, fallback count, latency, and record counts.

### Privacy and diagnostics

Every third-party resolver can observe the names sent to it. Resolver selection therefore affects privacy as well as availability. Diagnostics retain a small in-memory history containing endpoint identity, transport, latency, status, and fallback count. They do not add answer contents or additional queried-name logging.

Built-in endpoint changes require an explicit release decision backed by current
health checks. HNS DoH remains first and Web3DNS remains second; Shakestation is
archived and is never queried. Integration tests do not replace live provider
qualification or establish an uptime guarantee.

The HNS resolver indicator identifies the provider that actually answered the
website lookup, not the first provider in Settings. Its details distinguish the
website/address lookup from the TLSA/HTTPS identity lookup, because these can use
different providers or fail independently. Details include the transport,
sanitized endpoint, fallback attempts and whether a result came from cache.
DNSSEC authentication and certificate verification remain separate from merely
receiving a DNS answer. No provider is invented for an unresolved lookup, and
ordinary ICANN/local pages must not inherit another tab's HNS resolver label.

The address bar continues to show the HNS hostname and path, for example:

```text
setup.skyinclude/blog
```

## Why A Local Proxy?

Many hosted HNS sites depend on virtual hosting. Loading the raw IP address can show the wrong site or trigger redirects to gateway domains.

The local proxy lets Chromium request:

```text
http://setup.skyinclude/blog
```

while the app forwards upstream to the resolved IP with:

```text
Host: setup.skyinclude
```

## HeadlessDomains

Names ending in `.agent` and `.chatbot` can work as both websites and agent identities. For browser navigation, SkyInclude Browser first checks for web-hosting records:

1. A / AAAA records are loaded through the local HNS proxy with the original `Host` header preserved.
2. CNAME records are used next.
3. Only after an authoritative `NOERROR` response contains no A, AAAA, or CNAME web-hosting record (or the name is authoritatively absent) does the browser fall back to HeadlessDomains identity information.

Published manifest actions are identity metadata; they do not change this order. Adding an `actions` array to a manifest cannot displace a native site. If every resolver is temporarily unavailable, SkyInclude keeps the native hostname visible and presents an internal status page. It never opens raw manifest JSON automatically in that case, and the transient result is not cached, so a later retry can recover immediately when HNS resolution returns. Directly entering a HeadlessDomains manifest URL remains supported because that is an explicit user choice on an ordinary HTTPS origin.

This lets domains such as `mike.agent`, `pourspout.agent`, and `saltrimmer.agent` open their hosted websites by default while keeping their agent manifests discoverable.

## HNS HTTPS And DANE/TLSA

Native HNS HTTPS is a separate trust path from normal WebPKI HTTPS. A compatible HNS browser needs to resolve the HNS name, inspect the HTTPS server certificate using the HNS hostname as SNI, and verify the certificate against TLSA records such as:

```text
_443._tcp.<name> TLSA 3 1 1 <sha256-of-public-key>
```

SkyInclude Browser keeps normal WebPKI validation for ICANN domains separate from HNS DANE/TLSA work.

Wire-format requests set RD and AD and include an EDNS OPT record with DO;
checking-disabled (CD) is not set. TLSA answers, including negative answers,
must come over authenticated HTTPS and carry the recursive resolver's AD bit
without CD. This delegates DNSSEC validation to the configured validating HNS
resolver; the browser does not independently validate the DNSSEC chain. An
unsigned/unvalidated response is a verification failure, not evidence that TLSA
does not exist. SkyInclude tries the next configured endpoint and never falls
back to ordinary ICANN DNS for TLSA. JSON APIs must likewise return `AD: true`
without `CD: true`. Non-default HTTPS ports use `_<port>._tcp.<name>` and separate
TLSA cache entries.

Cold HTTP-to-HTTPS redirects use the same DANE admission path as an explicitly
entered HTTPS URL. Before the local proxy opens an HNS CONNECT tunnel, SkyInclude
resolves authenticated TLSA data, probes the exact address and port using the
native hostname as SNI, and installs a certificate-fingerprint exception only
after a successful match. Trust is scoped to the hostname, port, address, and
resolver-cache generation. Chromium still handles the original redirect and
request: the browser does not cancel a redirect and reconstruct it as a GET.
The native hostname, path/query, Host header, SNI, cookies, and 307/308 method/body
semantics therefore remain on the original browser request path. Once a native
HTTP(S) document and its address mapping exist, same-native-host navigations
also stay with Chromium, preserving form submissions. First visits, cross-host
navigation, gateway normalization, and internal status/identity pages retain the
existing resolution interception. This fix does not claim to add general
cross-host HNS form-submission support.

Electron's certificate-verification callback supplies a hostname but no port,
and its decisions are cached by the network service. SkyInclude therefore also
locks each HNS hostname to one SHA-256 certificate fingerprint for the browser
process lifetime. Different ports may use that same certificate only after
their own TLSA checks; a different certificate for the same hostname is blocked
before opening the tunnel. A legitimate certificate rotation requires quitting
and reopening the browser to verify the new certificate in a fresh session.
Clearing website/resolver caches does not remove this safety lock. This is an
intentional fail-closed limitation, not support for arbitrary distinct
certificates on simultaneous ports of one HNS hostname.

Concurrent admissions share verification work; cancelling one consumer does not
cancel another. Certificate probes have an absolute deadline covering both TCP
and TLS establishment and release their sockets when complete or cancelled.
Failed admissions are not trusted or cached as successful website results.
A failed main-frame HTTPS redirect opens an internal status page with Retry
HTTPS rather than leaving a blank page or a generic `ERR_FAILED` banner.
Temporary TLSA failure never opens an agent manifest and never silently
downgrades HTTPS. An explicit native HTTP option is available for compatible
failure states; a published TLSA mismatch still fails closed.
Retry HTTPS (or Reload) from SkyInclude's generated status page makes a fresh
TLSA attempt even during the local cooldown. Ordinary links, automatic redirects,
and background probes do not receive this cooldown bypass.
Forced revalidation invalidates active admission for that hostname and HTTPS
port across all resolved addresses. Older in-flight work cannot restore revoked
TLSA data or admission after the refresh.

Many early HNS websites do not publish TLSA records. Missing TLSA records do not break ordinary HNS browsing: `http://<name>` can still load through the local HNS HTTP proxy. If a user asks for `https://<name>` and no TLSA record exists, the browser describes that as not DANE verified and offers an explicit compatibility fallback to native HNS HTTP. If a TLSA record exists but does not match the server certificate, the browser fails closed instead of silently downgrading.

## No-Install Fallback

For users who only need to check whether an HNS site loads in a normal browser, use the public gateway form:

```text
https://<name>.hns.best
```

Example:

```text
https://skyinclude.hns.best
```

This is a compatibility and onboarding fallback. SkyInclude Browser should still be used when testing native HNS resolution, local proxy behavior, preserved hostnames, cookies, redirects, and HeadlessDomains agent manifests.

## Debugging

On macOS, inspect:

```text
~/Library/Application Support/skyinclude-browser/skyinclude-debug.log
```

Useful log events:

- `proxy-configured`
- `hns-proxy-map`
- `hns-proxy-request`
- `load-url`
- `load-error`

Resolver-result logs also include:

- `resolverId`
- `resolverTransport`
- `resolverFallbackCount`
- record counts and route, without DNS answer contents

For a manual smoke test:

1. Save at least two HTTPS resolvers in Settings.
2. Test `skyinclude`, `setup.skyinclude`, `handshake.mercenary`, `handshake.mastermind`, and `mike.agent`.
3. Confirm one normal ICANN name such as `google.com` remains on the traditional DNS/WebPKI path.
4. Temporarily use an unreachable first endpoint and confirm the second endpoint answers.
5. Repeat a second HNS lookup within 30 seconds and confirm the failed first endpoint is skipped without another full-timeout delay.
6. If DANE is enabled, verify a matching TLSA record succeeds and a published mismatch still fails closed.
7. From a cold session, open `http://handshake.mercenary/` and verify its HTTPS
   redirect renders the native site with DANE verification, without pre-opening
   HTTPS. Repeat with an isolated POST 307/308 fixture and inspect the received
   method/body, Host header, SNI, and path/query.
8. In an isolated profile, make all TLSA resolvers unavailable, confirm the
   internal status page, then restore them, clear resolver cooldown/cache, and
   Retry HTTPS. Confirm recovery without a manifest redirect or insecure bypass.
