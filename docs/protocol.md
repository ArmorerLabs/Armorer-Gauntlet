# Armorer Gauntlet Protocol

The relay routes frames but must not be able to read session content. It sees only minimal routing metadata plus whether a frame is attention-worthy enough to trigger a generic push.

## Relay Frame

Plaintext header:

- `version`: protocol version.
- `id`: frame id.
- `from`: sender device id.
- `to`: recipient device id.
- `kind`: routing hint such as `request`, `event`, or `attention`.
- `sentAt`: sender timestamp.
- `seq`: sender sequence number.

Encrypted body:

- `alg`: currently `ECDH-P256+A256GCM`.
- `nonce`: AES-GCM nonce.
- `ciphertext`: encrypted app message.

`kind: attention` is intentionally plaintext so the relay can send a generic push notification without decrypting the body.

## Pairing

The normal `make start` flow prints a URL QR:

```text
https://<app-host>/?p=<base64url-compact-json-pairing-payload>
```

The embedded pairing payload is compact JSON to keep the terminal QR small enough for phone cameras. It contains:

- relay URL.
- daemon id and display name.
- daemon public key.
- pairing token.
- expiry timestamp.
- protocol version.

The PWA removes `pair` from the address bar after loading, generates its own keypair, claims the token through the relay, and both sides derive an AES-GCM key from ECDH. The daemon stores only paired mobile public keys. The relay stores pairing offers briefly, deletes an offer after the first successful claim, and does not receive OpenAI credentials or Codex auth material.

## App Messages

Mobile-to-daemon:

- `sessions.list`: request existing provider sessions.
- `session.create`: start a Codex thread in a selected local `cwd`.
- `thread.read`: request a thread snapshot.
- `turn.start`: send a message/input to an existing thread.
- `approval.respond`: answer a supported approval prompt.
- `pairings.revoke_all`: clear daemon-side mobile pairings.

Daemon-to-mobile:

- `sessions.snapshot`: current session list.
- `daemon.status`: daemon/device pairing status.
- `session.created`: newly created session summary.
- `thread.snapshot`: current thread history.
- `turn.accepted`: daemon accepted mobile input.
- `codex.event`: provider event bridged from Codex app-server.
- `attention`: approval, input request, failed turn, or completed turn needing visibility.
- `approval.settled`: approval request has been answered.
- `pairings.revoked`: daemon pairings were cleared.
- `error`: structured error.

## Provider Boundary

Codex is the first provider. Provider-specific fields keep the Codex app-server language where it maps directly to upstream concepts, but the mobile and relay protocol remain provider-neutral enough for future adapters.

Expected future provider adapter shape:

```text
provider adapter -> normalized session summary
provider adapter -> normalized thread snapshot
provider adapter -> normalized attention events
provider adapter <- turn input / approval response
```

## Security Notes

- Mobile never receives OpenAI credentials.
- Relay never decrypts app messages.
- Daemon reuses local Codex auth and local Codex session storage.
- Push payloads are generic by design.
- Pairing tokens are short-lived and single-use.
