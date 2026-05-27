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

