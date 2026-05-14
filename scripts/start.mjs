#!/usr/bin/env node
import { spawn } from "node:child_process";
import { waitForTunnelUrl } from "./lib/tunnel.mjs";

const appUrl = await waitForTunnelUrl();
if (!appUrl) {
  console.error("Tunnel is still starting. Run `docker compose --profile tunnel logs tunnel` to view details.");
  process.exit(1);
}
const relayUrl = `${appUrl.replace("https://", "wss://")}/relay`;

console.log("");
console.log("Armorer Gauntlet is ready.");
console.log("Starting the local Codex daemon. The QR below opens the mobile app already paired.");
console.log("");

const daemon = spawn(
  "npm",
  [
    "exec",
    "-w",
    "@armorer/gauntlet-daemon",
    "--",
    "tsx",
    "src/index.ts",
    "start",
    "--relay",
    "ws://127.0.0.1:8787",
    "--mobile-relay",
    relayUrl,
    "--app-url",
    appUrl,
    "--pair"
  ],
  { stdio: "inherit" }
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    daemon.kill(signal);
  });
}

daemon.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
