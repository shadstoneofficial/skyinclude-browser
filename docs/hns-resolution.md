# HNS Resolution Architecture

SkyInclude Browser supports Handshake (HNS) domains without requiring the operating system DNS resolver to know about HNS.

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
resolver caches. Ordinary Reload uses Chromium reload semantics, including POST
resubmission behavior; reloading an internal outage page retries resolution.

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
2. Web3DNS (`dns-json https://api.web3dns.net/`)
3. Shakestation DoH (`doh-wire https://resolve.shakestation.io/dns-query`)

New installs receive all three entries. Existing installs that still have either the untouched legacy single-HNSDoH default or the untouched HNSDoH/Web3DNS built-in pair are upgraded to this three-endpoint order. Explicitly customized resolver lists keep their exact order, and the optional custom resolver remains first.

The Web3DNS API root is the JSON endpoint. `https://api.web3dns.net/dns-query` is not used. The community-provided native resolver IPs (`82.68.70.162` and `82.68.70.163`) are deliberately not accepted in this list: native DNS is a different, unencrypted transport and must not be normalized into a DoH URL.

The resolver test in Settings uses the saved resolver order and reports the endpoint name, transport, DNS status, fallback count, latency, and record counts.

### Privacy and diagnostics

Every third-party resolver can observe the names sent to it. Resolver selection therefore affects privacy as well as availability. Diagnostics retain a small in-memory history containing endpoint identity, transport, latency, status, and fallback count. They do not add answer contents or additional queried-name logging.

Built-in endpoint changes require an explicit release decision backed by current health checks. Web3DNS remains the second built-in resolver. Shakestation was approved as the third, wire-format DoH fallback after its service recovered; it remains last because point-in-time probes showed intermittent first-query latency. Neither endpoint replaces HNS DoH as the first choice.

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
