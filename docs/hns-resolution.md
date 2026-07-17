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

Resolver settings are ordered. SkyInclude asks one endpoint for the complete logical record set (A, AAAA, CNAME, and TXT) and uses the next endpoint only when the current one has a transport failure, TLS/HTTP error, malformed response, DNS failure status such as `SERVFAIL`, or inconsistent status across record types. It does not merge answers from different operators.

Authoritative `NXDOMAIN` and successful `NOERROR` with no records are terminal answers for that lookup. This prevents a fallback resolver with a different collision policy or stale root view from silently replacing an authoritative result.

After an endpoint failure, an in-memory circuit breaker skips it for 30 seconds. This prevents every navigation from paying the full timeout while a community resolver is offline. Changing resolver settings or clearing the resolver cache resets this local health state.

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
3. If no web-hosting record exists, the browser falls back to HeadlessDomains agent manifests, skill manifests, and profile URLs.

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
