import { describe, expect, it } from "vitest";
import { encodePairingQrPayload, parsePairingQrPayload } from "./validation.js";
import type { PairingQrPayload } from "./protocol.js";

describe("pairing payload validation", () => {
  it("round-trips compact QR payloads", () => {
    const payload = fakePayload();
    const compact = encodePairingQrPayload(payload);

    expect(compact.length).toBeLessThan(JSON.stringify(payload).length);
    expect(parsePairingQrPayload(compact)).toMatchObject({
      version: payload.version,
      relayUrl: payload.relayUrl,
      daemonId: payload.daemonId,
      daemonName: payload.daemonName,
      daemonPublicKey: {
        crv: "P-256",
        kty: "EC",
        x: payload.daemonPublicKey.x,
        y: payload.daemonPublicKey.y
      },
      pairingToken: payload.pairingToken
    });
  });

  it("keeps parsing legacy full JSON payloads", () => {
    const payload = fakePayload();

    expect(parsePairingQrPayload(JSON.stringify(payload))).toMatchObject(payload);
  });
});

function fakePayload(): PairingQrPayload {
  return {
    version: 1,
    relayUrl: "wss://example.trycloudflare.com/relay",
    daemonId: "daemon_123",
    daemonName: "Armorer Gauntlet",
    daemonPublicKey: {
      crv: "P-256",
      ext: true,
      kty: "EC",
      x: "x".repeat(43),
      y: "y".repeat(43)
    },
    pairingToken: "p_123456789",
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
}
