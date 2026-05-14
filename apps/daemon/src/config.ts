import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  createDeviceIdentity,
  type DeviceIdentity,
  type PublicKeyJwk
} from "@armorer/gauntlet-shared";

export interface MobilePairing {
  mobileId: string;
  mobileName: string;
  mobilePublicKey: PublicKeyJwk;
  pairedAt: string;
}

export interface DaemonConfig {
  daemonName: string;
  identity: DeviceIdentity;
  relayUrl?: string;
  pairings: Record<string, MobilePairing>;
}

export function getConfigPath(): string {
  return join(process.env.ARMORER_GAUNTLET_HOME ?? join(homedir(), ".armorer-gauntlet"), "daemon.json");
}

export async function loadOrCreateConfig(input: {
  daemonName?: string;
  relayUrl?: string;
}): Promise<DaemonConfig> {
  const configPath = getConfigPath();
  try {
    const existing = JSON.parse(await readFile(configPath, "utf8")) as DaemonConfig;
    let dirty = false;
    if (input.daemonName && existing.daemonName !== input.daemonName) {
      existing.daemonName = input.daemonName;
      dirty = true;
    }
    if (input.relayUrl && existing.relayUrl !== input.relayUrl) {
      existing.relayUrl = input.relayUrl;
      dirty = true;
    }
    if (dirty) await saveConfig(existing);
    return existing;
  } catch (error) {
    const identity = await createDeviceIdentity("daemon");
    const config: DaemonConfig = {
      daemonName: input.daemonName ?? hostname(),
      identity,
      ...(input.relayUrl ? { relayUrl: input.relayUrl } : {}),
      pairings: {}
    };
    await saveConfig(config);
    return config;
  }
}

export async function saveConfig(config: DaemonConfig): Promise<void> {
  const configPath = getConfigPath();
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
