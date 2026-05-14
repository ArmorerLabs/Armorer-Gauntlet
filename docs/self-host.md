# Self-Hosting Armorer Gauntlet

The default setup is intentionally simple:

```bash
make setup
make start
```

That starts Docker services, opens an HTTPS tunnel, starts the local Codex daemon, and prints a phone-camera QR that opens the PWA already paired.

## Components

```text
phone PWA -> https/wss public tunnel or domain -> relay + PWA
dev daemon -> wss relay URL -> relay
```

The daemon stays on the developer machine because it uses local Codex auth and local sessions.

## Advanced Local Commands

Run just the Docker services:

```bash
make up
```

Print the current HTTPS tunnel URLs:

```bash
make tunnel
```

Run the daemon manually:

```bash
make daemon RELAY_URL=wss://example.trycloudflare.com/relay
```

The old raw JSON pairing flow still exists as a fallback when the daemon is started without `--app-url`, but the normal `make start` QR is a URL that opens the mobile app.

## VPS or Domain Deployment

Build the project:

```bash
npm run build
```

Run the relay:

```bash
node apps/relay/dist/index.js --host 0.0.0.0 --port 8787
```

Run the PWA:

```bash
HOST=0.0.0.0 PORT=3000 ORIGIN=https://gauntlet.example.com node apps/pwa/build/index.js
```

Put both behind HTTPS. A simple Caddy front door can serve the PWA and proxy relay WebSockets on `/relay`:

```caddyfile
gauntlet.example.com {
  handle /relay* {
    reverse_proxy 127.0.0.1:8787
  }

  handle {
    reverse_proxy 127.0.0.1:3000
  }
}
```

Start the local daemon with a URL QR for that deployment:

```bash
node apps/daemon/dist/index.js start \
  --relay wss://gauntlet.example.com/relay \
  --app-url https://gauntlet.example.com \
  --pair
```

## Push Notifications

Generate VAPID keys:

```bash
node apps/relay/dist/index.js --print-vapid
```

Run the relay with VAPID enabled:

```bash
node apps/relay/dist/index.js \
  --host 0.0.0.0 \
  --port 8787 \
  --vapid-subject mailto:you@example.com \
  --vapid-public-key <public> \
  --vapid-private-key <private>
```

Build the PWA with the same public key:

```bash
PUBLIC_VAPID_PUBLIC_KEY=<public> npm run build -w @armorer/gauntlet-pwa
```

The relay sends generic notifications only. Actual session details are encrypted and fetched by the PWA after it opens.

After pairing, open PWA Settings, tap **Enable push**, then tap **Send test**. Attention events from Codex use the same relay push path.

## Daemon State

The daemon stores identity and paired mobile devices in:

```bash
~/.armorer-gauntlet/daemon.json
```

To revoke phones, open PWA settings and tap **Revoke paired phones on daemon**. This clears daemon pairings, signs phones out, and requires a fresh `make start` QR.

If you cannot access the PWA, stop the daemon, delete entries from `pairings`, and restart the daemon.

For throwaway development state:

```bash
ARMORER_GAUNTLET_HOME=/tmp/gauntlet-dev \
  node apps/daemon/dist/index.js start --relay ws://127.0.0.1:8787 --pair
```

## Troubleshooting

- QR opens text or JSON: use `make start`; raw JSON means the daemon was started without `--app-url`.
- Pairing says expired: restart `make start`; QR payloads expire after 10 minutes.
- Phone cannot reach the app: run `make start` again and scan the latest HTTPS tunnel QR.
- No sessions appear after the app was backgrounded: reopen the PWA; it should reconnect and refresh automatically. If the Cloudflare tunnel hostname changed, scan the newest QR.
- New sessions start in the selected local `cwd`; the path must exist on the daemon machine.
- Model requires a newer Codex: upgrade the laptop `codex` CLI and restart `make start`; the daemon uses that local client.
- Push does not work on iOS: install the PWA to the home screen and use iOS 16.4+.
- Push worked before but stopped after restarting the relay: reopen the PWA once so it can re-register the saved push subscription with the new relay process.
