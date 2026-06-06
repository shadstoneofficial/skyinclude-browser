# HNS Resolution Architecture

SkyInclude Browser supports Handshake (HNS) domains without requiring the operating system DNS resolver to know about HNS.

## Flow

1. User enters a URL such as `setup.skyinclude`.
2. The browser normalizes it and detects that the hostname is likely HNS.
3. The main process attempts HNS resolution through DNS-over-HTTPS.
4. If an address is found, the browser loads the native HNS URL through the local HTTP proxy.
5. The proxy forwards the request to the resolved IP address while preserving the original `Host` header.

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
