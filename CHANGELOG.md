# Changelog

## v0.2.0

Quality and observability pass on top of the v0.1.0 release.

Daemon

- Extracted the turn runtime into a dedicated module with unit coverage for queueing, draining, interrupting, retrying, and resuming turns.
- Added an opt-in trace mode (`--debug` / `GAUNTLET_DEBUG=1`) that logs relay frames, Codex notifications, and turn lifecycle transitions.
- Added `--log-file` / `GAUNTLET_LOG_FILE` to tee stdout and stderr to a file for offline diagnosis.
- Relay and Codex `app-server` socket close/error events are logged at all times, so a silent disconnect is no longer the cause of an unresponsive mobile session.
- Daemon errors thrown from the mobile-message handler are classified consistently and reported through the existing `error` AppMessage.

PWA

- New attachments pipeline with images and text files up to four per message.
- New directives parser and renderer for inline command chips inside user messages.
- Markdown renderer improvements, including safer link handling and richer code block rendering.
- Mobile composer respects the iOS/Android keyboard inset and stays anchored to the visual viewport.
- Service worker test coverage and tighter offline-cache behaviour.
- Session route handles preparing, queued, and interrupted turns with friendlier copy.

Tooling

- GitHub Actions workflow runs check, unit tests, build, and Playwright e2e on PRs and on `main`.
- New documentation section in `docs/development.md` covering daemon debugging and log files.

## v0.1.0 - Initial Public Release

Armorer Gauntlet is now ready for its first public source release.

- Mobile command deck for coding agents running on your own machine.
- Self-hosted relay with end-to-end encrypted app messages.
- QR-first phone pairing with short-lived one-time tokens.
- Mobile session list, chat, approvals, markdown rendering, and status views.
- Generic push notifications for approvals, input requests, failures, and ready-for-instructions transitions.
- Current Codex provider adapter with a protocol shape designed for future coding-agent providers.
- Mobile and desktop Playwright coverage backed by mocked relay/daemon fixtures.
