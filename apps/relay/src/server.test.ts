import {
  createRelayHeader,
  type E2eeRelayMessage,
  type RelayWireMessage
} from "@armorer/gauntlet-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import webPush from "web-push";
import { startRelayServer, type RunningRelayServer } from "./server.js";

vi.mock("web-push", () => ({
  default: {
    sendNotification: vi.fn().mockResolvedValue(undefined),
    setVapidDetails: vi.fn()
  }
}));

const servers: RunningRelayServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("relay", () => {
  it("routes encrypted frames without inspecting payloads", async () => {
    const relay = startRelayServer({ host: "127.0.0.1", port: 0 });
    servers.push(relay);
    const url = await relay.ready;

    const daemon = await connect(url, "daemon-1", "daemon");
    const mobile = await connect(url, "mobile-1", "mobile");

    const received = nextMessage(mobile.socket);
    const frame: E2eeRelayMessage = {
      type: "e2ee",
      header: createRelayHeader({
        from: "daemon-1",
        to: "mobile-1",
        kind: "event",
        seq: 1
      }),
      body: {
        alg: "ECDH-P256+A256GCM",
        nonce: "opaque",
        ciphertext: "definitely-not-plaintext"
      }
    };

    daemon.socket.send(JSON.stringify(frame));
    await expect(received).resolves.toMatchObject(frame);
    expect(relay.getStats().queuedFrames).toBe(0);
  });

  it("queues encrypted frames for offline devices and flushes on hello", async () => {
    const relay = startRelayServer({ host: "127.0.0.1", port: 0, queueTtlMs: 10_000 });
    servers.push(relay);
    const url = await relay.ready;

    const daemon = await connect(url, "daemon-1", "daemon");
    const frame: E2eeRelayMessage = {
      type: "e2ee",
      header: createRelayHeader({
        from: "daemon-1",
        to: "mobile-offline",
        kind: "attention",
        seq: 1
      }),
      body: {
        alg: "ECDH-P256+A256GCM",
        nonce: "n",
        ciphertext: "c"
      }
    };

    daemon.socket.send(JSON.stringify(frame));
    await waitFor(() => relay.getStats().queuedFrames === 1);

    const mobile = await connect(url, "mobile-offline", "mobile");
    await expect(nextMessage(mobile.socket)).resolves.toMatchObject(frame);
    expect(relay.getStats().queuedFrames).toBe(0);
  });

  it("sends generic web push for attention frames", async () => {
    const relay = startRelayServer({
      host: "127.0.0.1",
      port: 0,
      vapid: {
        subject: "mailto:test@example.com",
        publicKey: "public",
        privateKey: "private"
      }
    });
    servers.push(relay);
    const url = await relay.ready;

    const daemon = await connect(url, "daemon-1", "daemon");
    daemon.socket.send(
      JSON.stringify({
        type: "control",
        control: {
          type: "push.register",
          deviceId: "mobile-1",
          subscription: fakeSubscription()
        }
      } satisfies RelayWireMessage)
    );
    await waitFor(() => relay.getStats().pushSubscriptions === 1);

    const frame: E2eeRelayMessage = {
      type: "e2ee",
      header: createRelayHeader({
        from: "daemon-1",
        to: "mobile-1",
        kind: "attention",
        seq: 1
      }),
      body: {
        alg: "ECDH-P256+A256GCM",
        nonce: "n",
        ciphertext: "c"
      }
    };

    daemon.socket.send(JSON.stringify(frame));
    await waitFor(() => vi.mocked(webPush.sendNotification).mock.calls.length > 0);

    expect(webPush.sendNotification).toHaveBeenCalledWith(
      fakeSubscription(),
      JSON.stringify({
        title: "Armorer Gauntlet needs you",
        body: "Open Armorer Gauntlet to continue.",
        tag: "armorer-gauntlet-attention"
      })
    );
  });
});

async function connect(url: string, deviceId: string, role: "daemon" | "mobile") {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "control",
      control: {
        type: "hello",
        role,
        deviceId
      }
    } satisfies RelayWireMessage)
  );
  return { socket };
}

async function nextMessage(socket: WebSocket): Promise<RelayWireMessage> {
  return new Promise((resolve) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString()) as RelayWireMessage));
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2_000) {
      throw new Error("Timed out waiting for predicate");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fakeSubscription() {
  return {
    endpoint: "https://push.example.test/subscription",
    keys: {
      p256dh: "p256dh",
      auth: "auth"
    }
  };
}
