# Development Guide

This repo is a TypeScript monorepo for the Armorer Gauntlet MVP.

## Layout

```text
apps/
  daemon/   local dev-machine bridge for Codex app-server
  pwa/      SvelteKit mobile PWA
  relay/    self-hosted WebSocket relay
packages/
  codex-protocol/  generated Codex app-server protocol types
  shared/          protocol, validation, and crypto helpers
docs/
  self-host.md     deployment and operations notes
  protocol.md      wire protocol and pairing notes
```

The production MVP code lives in `apps/`, `packages/`, and `docs/`.

## Common Scripts

```bash
npm run dev:relay
npm run dev:daemon
npm run dev:pwa
npm run check
npm test
npm run build
npm run test:e2e
```

Dev, build, and check scripts rebuild the internal `packages/*` libraries first so a fresh clone does not depend on stale local `dist/` output. `npm run check` also runs a workspace export smoke check that imports internal package entrypoints.

Focused workspace commands:

```bash
npm run check -w @armorer/gauntlet-pwa
npm run build -w @armorer/gauntlet-daemon
npm run build -w @armorer/gauntlet-relay
```

## Development Loop

1. Start the relay.
2. Start the daemon with `--pair`.
3. Start the PWA.
4. Scan the daemon QR from the phone UI.
5. Create or resume a Codex session on the laptop.
6. Refresh the PWA session list.
7. Iterate on UI/daemon/relay code.
8. Run checks before handing off.

## Codex Provider

The daemon talks to `codex app-server`, not a PTY. This is deliberate: the app wants structured sessions, turns, approvals, and status events rather than raw terminal pixels.

Regenerate provider protocol bindings after a Codex CLI upgrade:

```bash
npm run generate:codex-protocol
```

The generated files live under `packages/codex-protocol/src/generated`.

## Debugging the Daemon

The daemon prints connection status and pairing prompts to stdout by default. When a mobile session looks stuck (no response, queue not draining, approval card missing), enable the trace mode and tee output to a file:

```bash
# Flags
npm exec -w @armorer/gauntlet-daemon -- tsx src/index.ts start \
  --relay ws://127.0.0.1:8787 --pair \
  --debug --log-file /tmp/gauntlet-daemon.log

# Or environment variables
GAUNTLET_DEBUG=1 GAUNTLET_LOG_FILE=/tmp/gauntlet-daemon.log make daemon
```

With `--debug` the daemon logs:

- inbound and outbound relay frames (type, kind, sequence, sender)
- Codex `app-server` notifications and requests by method
- turn lifecycle: start, queue, drain, interrupt, retry, resume

Even without `--debug`, the daemon reports relay socket close and Codex `app-server` socket close events. A silent disconnect is the most common cause of a phone session that looks alive but never receives a reply.

`--log-file` tees both stdout and stderr to the file. It is append-only, so subsequent runs grow the file rather than truncating it.

## Design Notes

The PWA uses Armorer UI vibes:

- dark zinc surfaces.
- emerald runtime accents.
- restrained cards and badges.
- QR-first mobile onboarding.
- Codex shown as the current provider, not as the product name.

## Verification Checklist

Run:

```bash
npm run check
npm test
npm run build
npm run test:e2e
```

Manual browser checks:

- unpaired onboarding shows `Scan QR code` first.
- paste fallback expands and remains usable.
- paired state shows sessions and provider badge.
- thread view shows `codex resume <SESSION_ID>`.
- long paths, commands, and diffs scroll instead of breaking layout.

## Public Repository Checklist

- Keep `.env`, daemon state, generated build output, Playwright reports, and `node_modules` out of git.
- Run the secret scan pattern from the release issue or CI before making the repository public.
- Confirm the selected license with the project owner before adding a `LICENSE`.
- Check screenshots and docs for personal paths, real tunnel URLs, private emails, and local machine names.
