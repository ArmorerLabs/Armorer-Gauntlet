import { execFileSync } from "node:child_process";

const TUNNEL_URL_REGEX = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g;
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

export async function waitForTunnelUrl({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const url = latestTunnelUrl();
    if (url) return url;
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

export function latestTunnelUrl() {
  return [...dockerComposeLogs().matchAll(TUNNEL_URL_REGEX)].at(-1)?.[0];
}

function dockerComposeLogs() {
  try {
    return execFileSync("docker", ["compose", "--profile", "tunnel", "logs", "--no-color", "tunnel"], {
      encoding: "utf8"
    });
  } catch {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
