import {
  createRelayHeader,
  decryptAppMessage,
  deriveSharedAesKey,
  encryptAppMessage,
  parseRelayWireMessage,
  type AppMessage,
  type E2eeRelayMessage,
  type PairingQrPayload,
  type RelayControlMessage,
  type RelayWireMessage
} from "@armorer/gauntlet-shared";
import { WebSocket } from "ws";
import { type DaemonConfig, type MobilePairing, saveConfig } from "./config.js";
import { errorMessage, log } from "./logger.js";

export interface DaemonRelayClientOptions {
  config: DaemonConfig;
  relayUrl: string;
  onMessage: (message: AppMessage, fromMobileId: string) => Promise<void>;
}

export class DaemonRelayClient {
  private socket?: WebSocket;
  private seq = 1;
  private readonly keys = new Map<string, CryptoKey>();

  constructor(private readonly options: DaemonRelayClientOptions) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(this.options.relayUrl);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.on("message", (raw) => {
      this.handleWireMessage(raw.toString()).catch((error) => {
        log.warn("relay message failed", errorMessage(error));
      });
    });
    socket.on("error", (error) => {
      log.error("relay socket error", errorMessage(error));
    });
    socket.on("close", (code, reason) => {
      log.warn("relay socket closed", { code, reason: reason?.toString() });
    });
    this.sendControl({
      type: "hello",
      role: "daemon",
      deviceId: this.options.config.identity.deviceId,
      deviceName: this.options.config.daemonName
    });
  }

  registerPairOffer(pairing: PairingQrPayload): void {
    this.sendControl({
      type: "pair.offer",
      daemonId: pairing.daemonId,
      daemonName: pairing.daemonName,
      daemonPublicKey: pairing.daemonPublicKey,
      pairingToken: pairing.pairingToken,
      expiresAt: pairing.expiresAt
    });
  }

  async sendToMobile(
    mobileId: string,
    message: AppMessage,
    kind: E2eeRelayMessage["header"]["kind"] = "event"
  ): Promise<void> {
    const key = await this.getKey(mobileId);
    const encrypted = await encryptAppMessage(key, message);
    log.debug("relay send", () => ({ to: mobileId, kind, seq: this.seq, message: message.type }));
    this.send({
      type: "e2ee",
      header: createRelayHeader({
        from: this.options.config.identity.deviceId,
        to: mobileId,
        kind,
        seq: this.seq
      }),
      body: encrypted
    });
    this.seq += 1;
  }

  async broadcast(
    message: AppMessage,
    kind: E2eeRelayMessage["header"]["kind"] = "event"
  ): Promise<void> {
    await Promise.all(
      Object.keys(this.options.config.pairings).map((mobileId) =>
        this.sendToMobile(mobileId, message, kind)
      )
    );
  }

  async revokeAllPairings(): Promise<void> {
    this.options.config.pairings = {};
    this.keys.clear();
    await saveConfig(this.options.config);
  }

  private async handleWireMessage(raw: string): Promise<void> {
    const message = parseRelayWireMessage(raw);
    if (message.type === "control") {
      log.debug("relay recv control", () => ({ control: message.control.type }));
      await this.handleControl(message.control);
      return;
    }
    log.debug("relay recv e2ee", () => ({ from: message.header.from, kind: message.header.kind, seq: message.header.seq }));
    const key = await this.getKey(message.header.from);
    const appMessage = await decryptAppMessage(key, message.body);
    await this.options.onMessage(appMessage, message.header.from);
  }

  private async handleControl(control: RelayControlMessage): Promise<void> {
    if (control.type !== "pair.accepted") return;
    if (control.daemonId !== this.options.config.identity.deviceId) return;

    const pairing: MobilePairing = {
      mobileId: control.mobileId,
      mobileName: control.mobileName,
      mobilePublicKey: control.mobilePublicKey,
      pairedAt: new Date().toISOString()
    };
    this.options.config.pairings[control.mobileId] = pairing;
    await saveConfig(this.options.config);
    this.keys.delete(control.mobileId);
    console.log(`Paired mobile device: ${control.mobileName} (${control.mobileId})`);
  }

  private async getKey(mobileId: string): Promise<CryptoKey> {
    const cached = this.keys.get(mobileId);
    if (cached) return cached;
    const pairing = this.options.config.pairings[mobileId];
    if (!pairing) throw new Error(`No pairing for mobile ${mobileId}`);
    const key = await deriveSharedAesKey(
      this.options.config.identity.privateKey,
      pairing.mobilePublicKey
    );
    this.keys.set(mobileId, key);
    return key;
  }

  private sendControl(control: RelayControlMessage): void {
    this.send({ type: "control", control });
  }

  private send(message: RelayWireMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Relay socket is not open");
    }
    socket.send(JSON.stringify(message));
  }
}
