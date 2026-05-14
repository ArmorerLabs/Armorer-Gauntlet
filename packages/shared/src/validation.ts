import {
  PROTOCOL_VERSION,
  type PairingQrPayload,
  type PublicKeyJwk,
  type RelayWireMessage
} from "./protocol.js";

export function isRelayWireMessage(value: unknown): value is RelayWireMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown };
  return candidate.type === "control" || candidate.type === "e2ee";
}

const decoder = new TextDecoder();

export function parseRelayWireMessage(raw: string | ArrayBuffer | Uint8Array): RelayWireMessage {
  const text = typeof raw === "string" ? raw : decoder.decode(raw);
  const parsed = JSON.parse(text) as unknown;
  if (!isRelayWireMessage(parsed)) {
    throw new Error("Invalid relay message");
  }
  return parsed;
}

export function parsePairingQrPayload(text: string): PairingQrPayload {
  const parsed = expandPairingPayload(JSON.parse(text) as unknown);
  if (
    parsed.version !== PROTOCOL_VERSION ||
    !parsed.relayUrl ||
    !parsed.daemonId ||
    !parsed.daemonName ||
    !parsed.daemonPublicKey ||
    !parsed.pairingToken ||
    !parsed.expiresAt
  ) {
    throw new Error("Invalid pairing payload");
  }
  if (Date.parse(parsed.expiresAt) <= Date.now()) {
    throw new Error("Pairing payload has expired");
  }
  return parsed as PairingQrPayload;
}

export function encodePairingQrPayload(payload: PairingQrPayload): string {
  return JSON.stringify([
    payload.version,
    payload.relayUrl,
    payload.daemonId,
    payload.daemonName,
    payload.daemonPublicKey.x,
    payload.daemonPublicKey.y,
    payload.pairingToken,
    Math.floor(Date.parse(payload.expiresAt) / 1000)
  ]);
}

function expandPairingPayload(value: unknown): Partial<PairingQrPayload> {
  if (Array.isArray(value)) return expandCompactPairingPayload(value);
  return value as Partial<PairingQrPayload>;
}

function expandCompactPairingPayload(value: unknown[]): Partial<PairingQrPayload> {
  const [version, relayUrl, daemonId, daemonName, x, y, pairingToken, expiresAtSeconds] = value;
  const expiresAt =
    typeof expiresAtSeconds === "number" && Number.isFinite(expiresAtSeconds)
      ? new Date(expiresAtSeconds * 1000).toISOString()
      : undefined;
  return {
    version,
    relayUrl,
    daemonId,
    daemonName,
    daemonPublicKey: compactPublicKey(x, y),
    pairingToken,
    expiresAt
  } as Partial<PairingQrPayload>;
}

function compactPublicKey(x: unknown, y: unknown): PublicKeyJwk | undefined {
  if (typeof x !== "string" || typeof y !== "string") return undefined;
  return {
    crv: "P-256",
    ext: true,
    kty: "EC",
    x,
    y
  };
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled discriminated union value: ${JSON.stringify(value)}`);
}

export function unwrapNestedErrorMessage(message: string): string {
  try {
    const parsed = JSON.parse(message) as unknown;
    if (!parsed || typeof parsed !== "object") return message;
    const data = parsed as { message?: unknown; error?: { message?: unknown } };
    const inner = typeof data.message === "string" ? data.message : data.error?.message;
    if (typeof inner !== "string") return message;
    return unwrapNestedErrorMessage(inner);
  } catch {
    return message;
  }
}
