# Contributing

Thanks for helping improve Armorer Gauntlet.

## Local Setup

```bash
make setup
make start
```

For regular development without the all-in-one runner:

```bash
npm run dev:relay
npm run dev:pwa
npm run dev:daemon
```

## Before Opening a Pull Request

Run the full verification set:

```bash
npm run check
npm test
npm run build
npm run test:e2e
```

Do not commit `.env`, VAPID private keys, daemon state, Codex auth material, generated build output, Playwright reports, or local machine paths from screenshots/logs.

## Provider Protocol Updates

After upgrading Codex, regenerate the app-server bindings:

```bash
npm run generate:codex-protocol
```

Review generated diffs carefully. The daemon should keep mapping provider-specific events into the shared app protocol instead of leaking raw upstream details into the relay.
