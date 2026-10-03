# Contributing

Thanks for helping improve SkyInclude Browser.

## Local Setup

```bash
npm install
npm start
```

Before opening a pull request, run:

```bash
npm test
```

For repeatable offline resolver performance probes, run
`npm run benchmark:resolver`. This measures shared DNS work, optional TXT
latency, and absolute deadlines; it is not a full-browser rendering benchmark.
The bundled ICANN classification list can be compared with upstream using
`node scripts/update-icann-tlds.js --check`. Refresh it with
`node scripts/update-icann-tlds.js` and review the provenance/data diff.

## Pull Request Guidelines

- Keep changes focused and explain the user-visible behavior.
- Include manual test notes for HNS navigation changes.
- Do not commit `dist/`, `node_modules/`, DMGs, packaged apps, logs, or local settings.
- Avoid adding new resolver services without documenting the privacy and reliability tradeoffs.

## Manual HNS Smoke Test

Please test these before merging resolver or navigation changes:

- `skyinclude`
- `setup.skyinclude`
- `handshake.mercenary`
- `handshake.mercenary/viewtopic.php?t=280`
- `handshake.mastermind/schedule/`
- `janice.agent`
- `google.com`
