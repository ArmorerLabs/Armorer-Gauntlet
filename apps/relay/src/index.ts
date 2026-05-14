#!/usr/bin/env node
import { Command } from "commander";
import webPush from "web-push";
import { startRelayServer } from "./server.js";

const program = new Command();

program
  .name("armorer-gauntlet-relay")
  .description("Self-hosted WebSocket relay for Armorer Gauntlet")
  .option("--host <host>", "Host to bind", "0.0.0.0")
  .option("--port <port>", "Port to bind", "8787")
  .option("--queue-ttl-ms <ms>", "Encrypted offline queue TTL", `${24 * 60 * 60 * 1000}`)
  .option("--vapid-subject <subject>", "Web Push VAPID subject, e.g. mailto:you@example.com")
  .option("--vapid-public-key <key>", "Web Push VAPID public key")
  .option("--vapid-private-key <key>", "Web Push VAPID private key")
  .option("--print-vapid", "Generate and print VAPID keys, then exit")
  .parse(process.argv);

const options = program.opts<{
  host: string;
  port: string;
  queueTtlMs: string;
  vapidSubject?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  printVapid?: boolean;
}>();

if (options.printVapid) {
  console.log(JSON.stringify(webPush.generateVAPIDKeys(), null, 2));
  process.exit(0);
}

const relayOptions: Parameters<typeof startRelayServer>[0] = {
  host: options.host,
  port: Number.parseInt(options.port, 10),
  queueTtlMs: Number.parseInt(options.queueTtlMs, 10)
};

if (options.vapidSubject && options.vapidPublicKey && options.vapidPrivateKey) {
  relayOptions.vapid = {
    subject: options.vapidSubject,
    publicKey: options.vapidPublicKey,
    privateKey: options.vapidPrivateKey
  };
}

const server = startRelayServer(relayOptions);

server.ready.then((address) => {
  console.log(`Armorer Gauntlet relay listening on ${address}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
