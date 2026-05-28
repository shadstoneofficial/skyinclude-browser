# SkyInclude Browser

SkyInclude Browser is an Electron desktop browser for regular websites and Handshake (HNS) domains.

It resolves HNS names with DNS-over-HTTPS, supports HeadlessDomains agent/chatbot manifests, and routes HNS HTTP traffic through a local in-app proxy so sites can keep their native hostname, paths, cookies, and redirects.

## Features

- Browse normal DNS sites like `google.com`
- Browse HNS sites like `skyinclude`, `setup.skyinclude`, `handshake.mercenary`, and `handshake.mastermind`
- Preserve native HNS hostnames in the address bar, including inner paths
- Resolve `.agent` and `.chatbot` names through HeadlessDomains manifests
- Open new-window links as managed browser tabs
- Local settings UI for resolver and privacy options

## Development

Requirements:

- Node.js 18+
- npm

Install and run:

```bash
npm install
npm start
```

Run syntax checks:

```bash
npm test
```

Build macOS DMGs:

```bash
npm run build-mac
```

Build release artifacts for macOS, Windows, and Ubuntu:

```bash
gh workflow run release.yml --repo shadstoneofficial/skyinclude-browser --ref main
```

Release tags matching `v*` also trigger the artifact workflow. See [docs/releasing.md](docs/releasing.md).

Build output is written to `dist/`, which is intentionally ignored by git.

## HNS Resolution

The browser handles HNS domains in two stages:

1. The main process tries to resolve a hostname with HNS DNS-over-HTTPS.
2. HNS HTTP traffic is loaded through a local proxy, which preserves the original HNS `Host` header while forwarding to the resolved IP address.

This avoids raw-IP browsing issues where hosted sites return the wrong virtual host or redirect away from the native HNS name.

More detail: [docs/hns-resolution.md](docs/hns-resolution.md)

If a tester does not have SkyInclude Browser installed yet, use the public gateway fallback:

```text
https://<name>.hns.best
```

Example: `https://skyinclude.hns.best`

## Useful Test Sites

- `skyinclude`
- `setup.skyinclude`
- `handshake.mercenary`
- `handshake.mastermind`
- `janice.agent`
- `google.com`

## Logs

On macOS, debug logs are written to:

```text
~/Library/Application Support/skyinclude-browser/skyinclude-debug.log
```

## Project Structure

```text
.
├── main.js            # Electron main process, tabs, HNS proxy
├── resolver.js        # HNS DoH and HeadlessDomains resolution
├── renderer.js        # Browser chrome UI
├── preload.js         # Safe IPC bridge
├── settings.js        # Local settings persistence
├── settings-ui.html   # Settings window
├── history.js         # Local browsing history
├── index.html         # Main browser UI
├── styles.css         # Browser UI styles
├── announcement.html  # Home page
└── assets/            # App icons
```

## License

MIT
