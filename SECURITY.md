# Security

Armorer Gauntlet is a self-hosted control plane for local coding-agent sessions. Please treat security issues as sensitive.

## Reporting

Do not open public issues for vulnerabilities. Use GitHub private vulnerability reporting if it is enabled on the repository, or contact the maintainers privately.

## Sensitive Data

Never share:

- `.env` values or VAPID private keys.
- `~/.armorer-gauntlet/daemon.json`.
- Local Codex auth material or session files.
- Pairing QR payloads before they expire.
- Real tunnel URLs when they identify an active private deployment.

## Design Notes

The relay routes encrypted frames and stores bounded encrypted offline queues. It cannot decrypt session content, but it can see routing metadata and whether a frame is marked as attention-worthy for generic Web Push delivery.

Run the PWA and relay behind HTTPS/WSS for real devices. Browser camera access, service workers, and push notifications all depend on secure contexts outside localhost.
