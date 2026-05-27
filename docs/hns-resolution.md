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

Names ending in `.agent` and `.chatbot` are looked up through HeadlessDomains. The browser prefers an agent manifest when one exists, then falls back to other published profile URLs.

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

