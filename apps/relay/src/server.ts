import { createServer, type Server as HttpServer } from "node:http";
import {
  assertNever,
  DEFAULT_PUSH_PAYLOAD,
  DEFAULT_QUEUE_TTL_MS,
  parseRelayWireMessage,
  type ControlRelayMessage,
  type E2eeRelayMessage,
  type PublicKeyJwk,
  type RelayControlMessage,
  type RelayWireMessage,
  type WebPushSubscriptionJson
} from "@armorer/gauntlet-shared";
import webPush from "web-push";
import { WebSocket, WebSocketServer } from "ws";

const QUEUE_CLEANUP_INTERVAL_MS = 60_000;

export interface RelayServerOptions {
  host?: string;
  port?: number;
  queueTtlMs?: number;
  queueLimitPerDevice?: number;
  vapid?: {
    subject: string;
    publicKey: string;
    privateKey: string;
  };
}

interface ConnectedClient {
  deviceId: string;
  role: "daemon" | "mobile";
  deviceName?: string;
  socket: WebSocket;
}

interface PairOffer {
  daemonId: string;
  daemonName: string;
  daemonPublicKey: PublicKeyJwk;
  pairingToken: string;
  expiresAt: number;
}

interface QueuedFrame {
  expiresAt: number;
  message: E2eeRelayMessage;
}

export interface RunningRelayServer {
  ready: Promise<string>;
  close: () => Promise<void>;
  getStats: () => {
    clients: number;
    pairOffers: number;
    queuedFrames: number;
    pushSubscriptions: number;
  };
}

export function startRelayServer(options: RelayServerOptions = {}): RunningRelayServer {
  const relay = new RelayServer(options);
  relay.start();
  return relay;
}

class RelayServer implements RunningRelayServer {
  readonly ready: Promise<string>;

  private readonly httpServer: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly sockets = new Map<WebSocket, ConnectedClient>();
  private readonly pairOffers = new Map<string, PairOffer>();
  private readonly queued = new Map<string, QueuedFrame[]>();
  private readonly pushSubscriptions = new Map<string, WebPushSubscriptionJson>();
  private cleanupTimer?: NodeJS.Timeout;
  private resolveReady!: (address: string) => void;

  constructor(private readonly options: RelayServerOptions) {
    this.httpServer = createServer((request, response) => {
      if (request.url === "/healthz" || request.url === "/readyz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404);
      response.end("not found");
    });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });

    if (options.vapid) {
      webPush.setVapidDetails(
        options.vapid.subject,
        options.vapid.publicKey,
        options.vapid.privateKey
      );
    }
  }

  start(): void {
    this.wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        this.handleMessage(socket, raw).catch((error) => {
          this.sendControl(socket, {
            type: "error",
            code: "relay_message_failed",
            message: error instanceof Error ? error.message : "Unknown relay error"
          });
        });
      });
      socket.on("close", () => {
        const client = this.sockets.get(socket);
        if (!client) return;
        this.clients.delete(client.deviceId);
        this.sockets.delete(socket);
      });
    });

    this.httpServer.listen(this.options.port ?? 8787, this.options.host ?? "0.0.0.0", () => {
      const address = this.httpServer.address();
      if (address && typeof address !== "string") {
        this.resolveReady(`ws://${address.address}:${address.port}`);
      } else {
        this.resolveReady(String(address));
      }
    });

    this.cleanupTimer = setInterval(() => this.cleanupExpiredQueue(), QUEUE_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const client of this.clients.values()) {
      client.socket.close();
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
  }

  getStats() {
    let queuedFrames = 0;
    for (const frames of this.queued.values()) queuedFrames += frames.length;
    return {
      clients: this.clients.size,
      pairOffers: this.pairOffers.size,
      queuedFrames,
      pushSubscriptions: this.pushSubscriptions.size
    };
  }

  private async handleMessage(socket: WebSocket, raw: WebSocket.RawData): Promise<void> {
    const message = parseRelayWireMessage(raw.toString());
    if (message.type === "control") {
      await this.handleControl(socket, message.control);
      return;
    }
    await this.routeEncryptedFrame(message);
  }

  private async handleControl(socket: WebSocket, control: RelayControlMessage): Promise<void> {
    switch (control.type) {
      case "hello":
        this.registerClient(socket, control);
        return;
      case "pair.offer":
        this.registerPairOffer(control);
        return;
      case "pair.claim":
        this.acceptPairClaim(socket, control);
        return;
      case "push.register":
        this.pushSubscriptions.set(control.deviceId, control.subscription);
        return;
      case "push.test":
        await this.sendPush(control.to);
        return;
      case "pair.accepted":
      case "error":
        return;
      default:
        return assertNever(control);
    }
  }

  private registerClient(
    socket: WebSocket,
    control: Extract<RelayControlMessage, { type: "hello" }>
  ): void {
    const existing = this.clients.get(control.deviceId);
    existing?.socket.close();

    const client: ConnectedClient = {
      deviceId: control.deviceId,
      role: control.role,
      socket,
      ...(control.deviceName ? { deviceName: control.deviceName } : {})
    };
    this.clients.set(control.deviceId, client);
    this.sockets.set(socket, client);
    this.flushQueue(control.deviceId);
  }

  private registerPairOffer(control: Extract<RelayControlMessage, { type: "pair.offer" }>): void {
    const expiresAt = Date.parse(control.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("Pair offer is expired or invalid");
    }
    this.pairOffers.set(control.pairingToken, {
      daemonId: control.daemonId,
      daemonName: control.daemonName,
      daemonPublicKey: control.daemonPublicKey,
      pairingToken: control.pairingToken,
      expiresAt
    });
  }

  private acceptPairClaim(
    socket: WebSocket,
    control: Extract<RelayControlMessage, { type: "pair.claim" }>
  ): void {
    const offer = this.pairOffers.get(control.pairingToken);
    if (!offer || offer.expiresAt <= Date.now() || offer.daemonId !== control.daemonId) {
      throw new Error("Pairing token is invalid or expired");
    }
    this.pairOffers.delete(control.pairingToken);

    const accepted: ControlRelayMessage = {
      type: "control",
      control: {
        type: "pair.accepted",
        daemonId: offer.daemonId,
        mobileId: control.mobileId,
        mobileName: control.mobileName,
        mobilePublicKey: control.mobilePublicKey
      }
    };

    this.send(socket, accepted);
    const daemon = this.clients.get(offer.daemonId);
    if (daemon) {
      this.send(daemon.socket, accepted);
    } else {
      throw new Error("Daemon is not connected");
    }
  }

  private async routeEncryptedFrame(message: E2eeRelayMessage): Promise<void> {
    const target = this.clients.get(message.header.to);
    if (target) {
      this.send(target.socket, message);
    } else {
      this.queueFrame(message.header.to, message);
    }

    if (message.header.kind === "attention" || message.header.kind === "push") {
      await this.sendPush(message.header.to);
    }
  }

  private queueFrame(deviceId: string, message: E2eeRelayMessage): void {
    const ttl = this.options.queueTtlMs ?? DEFAULT_QUEUE_TTL_MS;
    const queueLimit = this.options.queueLimitPerDevice ?? 200;
    let frames = this.queued.get(deviceId);
    if (!frames) {
      frames = [];
      this.queued.set(deviceId, frames);
    }
    frames.push({
      expiresAt: Date.now() + ttl,
      message
    });
    while (frames.length > queueLimit) frames.shift();
  }

  private flushQueue(deviceId: string): void {
    const client = this.clients.get(deviceId);
    if (!client) return;
    const now = Date.now();
    const frames = this.queued.get(deviceId) ?? [];
    this.queued.delete(deviceId);
    for (const frame of frames) {
      if (frame.expiresAt > now) {
        this.send(client.socket, frame.message);
      }
    }
  }

  private cleanupExpiredQueue(): void {
    const now = Date.now();
    for (const [deviceId, frames] of this.queued.entries()) {
      const fresh = frames.filter((frame) => frame.expiresAt > now);
      if (fresh.length) {
        this.queued.set(deviceId, fresh);
      } else {
        this.queued.delete(deviceId);
      }
    }
    for (const [token, offer] of this.pairOffers.entries()) {
      if (offer.expiresAt <= now) this.pairOffers.delete(token);
    }
  }

  private async sendPush(deviceId: string): Promise<void> {
    if (!this.options.vapid) return;
    const subscription = this.pushSubscriptions.get(deviceId);
    if (!subscription) return;
    try {
      await webPush.sendNotification(subscription, JSON.stringify(DEFAULT_PUSH_PAYLOAD));
    } catch (error) {
      if (isGonePush(error)) {
        this.pushSubscriptions.delete(deviceId);
      } else {
        console.warn("push failed", error);
      }
    }
  }

  private sendControl(socket: WebSocket, control: RelayControlMessage): void {
    this.send(socket, {
      type: "control",
      control
    });
  }

  private send(socket: WebSocket, message: RelayWireMessage): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}

function isGonePush(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    [404, 410].includes(Number((error as { statusCode: unknown }).statusCode))
  );
}
