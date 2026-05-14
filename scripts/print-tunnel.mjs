#!/usr/bin/env node
import { waitForTunnelUrl } from "./lib/tunnel.mjs";

const appUrl = await waitForTunnelUrl();
if (!appUrl) {
  console.error("Tunnel is still starting. Run `docker compose --profile tunnel logs tunnel` to view the URL.");
  process.exit(1);
}

const relayUrl = `${appUrl.replace("https://", "wss://")}/relay`;

console.log("");
console.log("Tunnel is ready.");
console.log(`  Phone PWA:   ${appUrl}`);
console.log(`  Daemon URL:  ${relayUrl}`);
console.log("");
console.log("Pair from this machine with:");
console.log(`  make daemon RELAY_URL=${relayUrl}`);
