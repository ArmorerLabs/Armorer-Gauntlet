export const PROTOCOL_VERSION = 1;
export const DEFAULT_QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_CODEX_CLI_VERSION = "0.121.0";

export const DEFAULT_PUSH_PAYLOAD = {
  title: "Armorer Gauntlet needs you",
  body: "Open Armorer Gauntlet to continue.",
  tag: "armorer-gauntlet-attention"
} as const;

export type DeviceRole = "daemon" | "mobile";
export type RelayMessageKind = "control" | "e2ee";
export type RelayFrameKind =
  | "pairing"
  | "request"
  | "response"
  | "event"
  | "attention"
  | "push";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type TurnMode = "next" | "steer";
export type AgentKind = "codex" | "pi" | "claude";
export type AppErrorCode = "thread_not_found" | "thread_busy" | "thread_preparing" | "daemon_request_failed";
export type TurnAttachmentKind = "image" | "text";
export type TurnAttachmentEncoding = "base64" | "utf8";

export interface TurnAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: TurnAttachmentKind;
  encoding: TurnAttachmentEncoding;
  data: string;
}

export interface TurnAttachmentSummary {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: TurnAttachmentKind;
}

export interface PublicKeyJwk {
  crv: string;
  ext: boolean;
  key_ops?: string[];
  kty: string;
  x: string;
  y: string;
}

export interface PrivateKeyJwk extends PublicKeyJwk {
  d: string;
}

export interface DeviceIdentity {
  deviceId: string;
  role: DeviceRole;
  publicKey: PublicKeyJwk;
  privateKey: PrivateKeyJwk;
  createdAt: string;
}

export interface PairingQrPayload {
  version: typeof PROTOCOL_VERSION;
  relayUrl: string;
  daemonId: string;
  daemonName: string;
  daemonPublicKey: PublicKeyJwk;
  pairingToken: string;
  expiresAt: string;
}

export interface RelayHeader {
  version: typeof PROTOCOL_VERSION;
  id: string;
  from: string;
  to: string;
  kind: RelayFrameKind;
  sentAt: string;
  seq: number;
}

export interface EncryptedPayload {
  alg: "ECDH-P256+A256GCM";
  nonce: string;
  ciphertext: string;
}

export interface E2eeRelayMessage {
  type: "e2ee";
  header: RelayHeader;
  body: EncryptedPayload;
}

export type RelayControlMessage =
  | {
      type: "hello";
      role: DeviceRole;
      deviceId: string;
      deviceName?: string;
    }
  | {
      type: "pair.offer";
      daemonId: string;
      daemonName: string;
      daemonPublicKey: PublicKeyJwk;
      pairingToken: string;
      expiresAt: string;
    }
  | {
      type: "pair.claim";
      daemonId: string;
      mobileId: string;
      mobileName: string;
      mobilePublicKey: PublicKeyJwk;
      pairingToken: string;
    }
  | {
      type: "pair.accepted";
      daemonId: string;
      mobileId: string;
      mobileName: string;
      mobilePublicKey: PublicKeyJwk;
    }
  | {
      type: "push.register";
      deviceId: string;
      subscription: WebPushSubscriptionJson;
    }
  | {
      type: "push.test";
      to: string;
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export interface ControlRelayMessage {
  type: "control";
  control: RelayControlMessage;
}

export type RelayWireMessage = ControlRelayMessage | E2eeRelayMessage;

export interface WebPushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
}

export type AppMessage =
  | {
      type: "sessions.list";
      requestId: string;
      archived?: boolean;
    }
  | {
      type: "sessions.snapshot";
      requestId: string;
      sessions: SessionSummary[];
      daemon: DaemonSummary;
    }
  | {
      type: "daemon.status";
      requestId?: string | undefined;
      daemon: DaemonSummary;
    }
  | {
      type: "thread.read";
      requestId: string;
      threadId: string;
    }
  | {
      type: "thread.snapshot";
      requestId: string;
      thread: CodexThreadSnapshot;
    }
  | {
      type: "session.create";
      requestId: string;
      cwd: string;
      agent?: AgentKind | undefined;
      initialMessage?: string | undefined;
    }
  | {
      type: "session.created";
      requestId: string;
      session: SessionSummary;
    }
  | {
      type: "turn.start";
      requestId: string;
      threadId: string;
      text: string;
      mode?: TurnMode | undefined;
      attachments?: TurnAttachment[] | undefined;
    }
  | {
      type: "turn.queued";
      requestId: string;
      threadId: string;
      queueDepth: number;
    }
  | {
      type: "turn.accepted";
      requestId: string;
      threadId: string;
      turnId?: string | undefined;
    }
  | {
      type: "turn.interrupt";
      requestId: string;
      threadId: string;
    }
  | {
      type: "turn.interrupted";
      requestId: string;
      threadId: string;
      turnId?: string | undefined;
      clearedQueuedTurns: number;
    }
  | {
      type: "approval.respond";
      requestId: string;
      codexRequestId: string | number;
      response: JsonValue;
    }
  | {
      type: "approval.settled";
      requestId: string;
      codexRequestId: string | number;
    }
  | {
      type: "pairings.revoke_all";
      requestId: string;
    }
  | {
      type: "pairings.revoked";
      requestId: string;
    }
  | {
      type: "codex.event";
      event: CodexEvent;
    }
  | {
      type: "attention";
      event: AttentionEvent;
    }
  | {
      type: "error";
      requestId?: string;
      code: AppErrorCode | string;
      message: string;
    };

export interface DaemonSummary {
  id: string;
  name: string;
  cwd?: string;
  codexVersion?: string;
  connectedAt: string;
  pairedDeviceCount?: number;
}

export interface SessionSummary {
  id: string;
  agent?: AgentKind | undefined;
  name: string;
  preview: string;
  cwd: string;
  updatedAt: number;
  createdAt: number;
  status: string;
  modelProvider: string;
  source: string;
  resumeCommand: string;
}

export interface CodexThreadSnapshot {
  id: string;
  agent?: AgentKind | undefined;
  name: string;
  preview: string;
  cwd: string;
  status: string;
  updatedAt: number;
  resumeCommand: string;
  turns: ThreadTurnSnapshot[];
}

export interface ThreadTurnSnapshot {
  id: string;
  status: string;
  startedAt?: number | null | undefined;
  completedAt?: number | null | undefined;
  items: ThreadItemSnapshot[];
}

export interface ThreadItemSnapshot {
  id: string;
  type: string;
  text?: string | undefined;
  attachments?: TurnAttachmentSummary[] | undefined;
  command?: string | undefined;
  output?: string | null | undefined;
  diff?: string | undefined;
  status?: string | undefined;
}

export type CodexEvent =
  | {
      type: "thread.status";
      threadId: string;
      status: string;
      attentionFlags?: string[] | undefined;
    }
  | {
      type: "turn.completed";
      threadId: string;
      turnId: string;
      status: string;
      error?: string | undefined;
    }
  | {
      type: "agent.delta";
      threadId: string;
      turnId: string;
      itemId: string;
      delta: string;
    }
  | {
      type: "diff.updated";
      threadId: string;
      turnId: string;
      diff: string;
    }
  | {
      type: "approval.requested";
      request: PendingApproval;
    };

export interface PendingApproval {
  codexRequestId: string | number;
  method: string;
  threadId?: string | undefined;
  turnId?: string | undefined;
  itemId?: string | undefined;
  title: string;
  detail: string;
  params: JsonValue;
  suggestedAcceptResponse?: JsonValue;
  suggestedDeclineResponse?: JsonValue;
}

export interface AttentionEvent {
  id: string;
  threadId?: string | undefined;
  title: string;
  body: string;
  reason: "approval" | "user_input" | "failed" | "idle";
  createdAt: string;
  pendingApproval?: PendingApproval | undefined;
}

export function createRelayHeader(input: {
  from: string;
  to: string;
  kind: RelayFrameKind;
  seq: number;
}): RelayHeader {
  return {
    version: PROTOCOL_VERSION,
    id: randomId("frame"),
    from: input.from,
    to: input.to,
    kind: input.kind,
    seq: input.seq,
    sentAt: new Date().toISOString()
  };
}

export function randomId(prefix = "id"): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return `${prefix}_${cryptoApi.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function textStatusFromCodexStatus(status: unknown): string {
  if (typeof status === "string") {
    return status;
  }
  if (status && typeof status === "object" && "type" in status) {
    const type = String((status as { type: unknown }).type);
    const activeFlags = (status as { activeFlags?: unknown }).activeFlags;
    if (type === "active" && Array.isArray(activeFlags)) {
      const flags = activeFlags.join(", ");
      return flags ? `active: ${flags}` : "active";
    }
    return type;
  }
  return "unknown";
}

export function toResumeCommand(threadId: string): string {
  return `codex resume ${threadId}`;
}
