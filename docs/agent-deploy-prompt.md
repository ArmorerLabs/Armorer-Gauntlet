# Agent Deployment Prompt

Use this prompt with a coding or operations agent when you want it to set up Armorer Gauntlet from a clone.

```text
You are helping deploy Armorer Gauntlet from this repository.

Goal:
- Get the QR-first demo running with Colima/Docker Compose.
- Report that the user should scan the QR printed by `make start`.
- Do not delete daemon state, Docker volumes, .env, or existing user files without explicit confirmation.

Steps:
1. Inspect the repo root and read README.md plus docs/self-host.md.
2. Check prerequisites: node, npm, docker, docker compose, colima, and codex.
3. Run `make setup`.
4. Run `make start`.
5. Tell the user to scan the URL QR printed in the terminal with their phone camera.
6. Keep `make start` running while the user pairs and tests the mobile app.

Rules:
- Never overwrite a customized .env without showing the diff and asking first.
- Never remove ~/.armorer-gauntlet unless the user explicitly asks to reset pairings.
- Never expose VAPID private keys or local Codex auth material in logs or summaries.
- If a command fails, summarize the failing command, the important error lines, and the safest next fix.
```
