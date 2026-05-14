import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MIN_CODEX_CLI_VERSION } from "@armorer/gauntlet-shared";

const execFileAsync = promisify(execFile);

export interface CodexHealth {
  version: string;
  loginStatus: string;
}

export async function assertCodexReady(): Promise<CodexHealth> {
  const [versionResult, loginResult] = await Promise.all([
    execFileAsync("codex", ["--version"]),
    execFileAsync("codex", ["login", "status"]).then(
      ({ stdout, stderr }) => `${stdout}${stderr}`.trim(),
      (error: unknown) => (error instanceof Error ? error.message : "codex login status failed")
    )
  ]);

  const match = versionResult.stdout.match(/(\d+\.\d+\.\d+)/);
  const version = match?.[1] ?? "0.0.0";
  if (compareSemver(version, MIN_CODEX_CLI_VERSION) < 0) {
    throw new Error(
      `codex-cli ${MIN_CODEX_CLI_VERSION}+ is required; found ${version}. Upgrade Codex before starting the daemon.`
    );
  }

  return { version, loginStatus: loginResult || "unknown" };
}

export function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}
