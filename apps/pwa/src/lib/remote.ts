import { browser } from "$app/environment";
import { env } from "$env/dynamic/public";
import { writable } from "svelte/store";
import {
  addOptimisticTurn,
  appendAgentDelta,
  initialState,
  markPendingTurn,
  markPendingTurnByRequest,
  mergeThreadSnapshot,
  seedSessionThread,
  withoutKey,
  type MobilePeer,
  type RemoteUiState
} from "$lib/remote-state";
import {
  assertNever,
  base64UrlToBytes,
  createDeviceIdentity,
  createRelayHeader,
  decryptAppMessage,
  deriveSharedAesKey,
  encryptAppMessage,
  parsePairingQrPayload,
  parseRelayWireMessage,
  randomId,
  toArrayBuffer,
  type AppMessage,
  type AttentionEvent,
  type DeviceIdentity,
  type PublicKeyJwk,
  type RelayControlMessage,
  type RelayWireMessage,
  type SessionSummary,
  type WebPushSubscriptionJson
} from "@armorer/gauntlet-shared";
import type { CodexEvent } from "@armorer/gauntlet-shared";

const STORAGE_KEY = "armorer-gauntlet-state-v1";
const CACHE_KEY = "armorer-gauntlet-cache-v1";

interface PersistedState {
  identity: DeviceIdentity;
  peer?: MobilePeer;
  vapidPublicKey?: string;
}

interface CachedUiState {
  daemon?: RemoteUiState["daemon"];
  sessions: RemoteUiState["sessions"];
  threads: RemoteUiState["threads"];
  attentions: RemoteUiState["attentions"];
  cachedAt: string;
}

export const remoteState = writable<RemoteUiState>(initialState);

class RemoteClient {
  private persisted?: PersistedState;
  private socket?: WebSocket;
  private sharedKey?: CryptoKey;
  private connectPromise?: Promise<void>;
  private reconnectTimer?: number;
  private reconnectAttempt = 0;
  private lifecycleListenersRegistered = false;
  private mockMode = false;
  private seq = 1;
  private pendingTurnRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private pendingSessionCreates = new Map<
    string,
    { resolve: (session: SessionSummary) => void; reject: (error: Error) => void; initialMessage?: string }
  >();

  async initialize(): Promise<void> {
    if (!browser) return;
    this.registerLifecycleReconnects();
    if (isMockRemoteEnabled()) {
      this.mockMode = true;
      remoteState.set(createMockState());
      return;
    }
    this.persisted = await this.loadOrCreateState();
    const pairingPayload = consumePairingPayloadFromUrl();
    const cached = loadCachedUiState();
    remoteState.update((state) => ({
      ...state,
      ...(cached
        ? {
            daemon: cached.daemon,
            sessions: cached.sessions,
            threads: cached.threads,
            attentions: cached.attentions
          }
        : {}),
      ready: true,
      identity: this.persisted?.identity,
      peer: this.persisted?.peer
    }));
    if (pairingPayload) {
      try {
        await this.pair(pairingPayload);
      } catch (error) {
        remoteState.update((state) => ({
          ...state,
          pairing: false,
          error: error instanceof Error ? error.message : "Pairing failed"
        }));
      }
    } else if (this.persisted.peer) {
      try {
        await this.connect();
        this.requestSessions();
      } catch {
        remoteState.update((state) => ({
          ...state,
          connected: false,
          error: cached
            ? "Relay is offline. Showing the last synced sessions."
            : "Relay connection failed. If you restarted make start, scan the latest QR."
        }));
        this.scheduleReconnect();
      }
    }
    await this.registerServiceWorker();
  }

  async pair(text: string): Promise<void> {
    if (!this.persisted) this.persisted = await this.loadOrCreateState();
    const payload = parsePairingQrPayload(normalizePairingText(text));
    remoteState.update((state) => ({ ...state, pairing: true, error: undefined }));
    this.persisted.peer = {
      relayUrl: payload.relayUrl,
      daemonId: payload.daemonId,
      daemonName: payload.daemonName,
      daemonPublicKey: payload.daemonPublicKey,
      pairedAt: new Date().toISOString()
    };
    this.saveState();
    await this.connect();
    this.sendControl({
      type: "pair.claim",
      daemonId: payload.daemonId,
      mobileId: this.persisted.identity.deviceId,
      mobileName: mobileName(),
      mobilePublicKey: this.persisted.identity.publicKey,
      pairingToken: payload.pairingToken
    });
  }

  async requestSessions(): Promise<void> {
    if (this.mockMode) return;
    await this.sendAppMessage({
      type: "sessions.list",
      requestId: randomId("req"),
      archived: false
    });
  }

  async readThread(threadId: string): Promise<void> {
    if (this.mockMode) return;
    await this.sendAppMessage({
      type: "thread.read",
      requestId: randomId("req"),
      threadId
    });
  }

  async sendTurn(threadId: string, text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.mockMode) {
      await this.mockSendTurn(threadId, trimmed);
      return;
    }
    const requestId = randomId("req");
    remoteState.update((state) => addOptimisticTurn(state, threadId, requestId, trimmed));
    const accepted = new Promise<void>((resolve, reject) => {
      this.pendingTurnRequests.set(requestId, { resolve, reject });
      window.setTimeout(() => {
        if (!this.pendingTurnRequests.has(requestId)) return;
        this.pendingTurnRequests.delete(requestId);
        remoteState.update((state) =>
          markPendingTurnByRequest(state, requestId, "failed", "Codex did not acknowledge the message in time.")
        );
        reject(new Error("Codex did not acknowledge the message in time."));
      }, 20_000);
    });
    try {
      await this.sendAppMessage({
        type: "turn.start",
        requestId,
        threadId,
        text: trimmed
      });
    } catch (error) {
      this.pendingTurnRequests.delete(requestId);
      const message = error instanceof Error ? error.message : "Message failed to send";
      remoteState.update((state) => markPendingTurnByRequest(state, requestId, "failed", message));
      throw error;
    }
    await accepted;
  }

  async createSession(cwd: string, initialMessage?: string): Promise<SessionSummary> {
    if (this.mockMode) return this.mockCreateSession(cwd, initialMessage);
    const requestId = randomId("req");
    const trimmedInitialMessage = initialMessage?.trim() ?? "";
    const created = new Promise<SessionSummary>((resolve, reject) => {
      this.pendingSessionCreates.set(requestId, {
        resolve,
        reject,
        ...(trimmedInitialMessage ? { initialMessage: trimmedInitialMessage } : {})
      });
      window.setTimeout(() => {
        if (!this.pendingSessionCreates.has(requestId)) return;
        this.pendingSessionCreates.delete(requestId);
        reject(new Error("Codex did not create the session in time."));
      }, 25_000);
    });
    await this.sendAppMessage({
      type: "session.create",
      requestId,
      cwd: cwd.trim(),
      ...(trimmedInitialMessage ? { initialMessage: trimmedInitialMessage } : {})
    });
    return created;
  }

  async respondToApproval(attention: AttentionEvent, accept: boolean): Promise<void> {
    if (this.mockMode) return;
    const approval = attention.pendingApproval;
    if (!approval) return;
    const response = accept ? approval.suggestedAcceptResponse : approval.suggestedDeclineResponse;
    if (!response) {
      remoteState.update((state) => ({
        ...state,
        error: "This approval needs a structured response that the MVP UI cannot create yet."
      }));
      return;
    }
    await this.sendAppMessage({
      type: "approval.respond",
      requestId: randomId("req"),
      codexRequestId: approval.codexRequestId,
      response
    });
  }

  async enablePush(vapidPublicKey: string): Promise<void> {
    if (this.mockMode) return;
    if (
      !browser ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window)
    ) {
      throw new Error("Push is not available in this browser");
    }
    const permission =
      Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") {
      throw new Error("Notification permission was not granted.");
    }
    const subscription = await this.ensurePushSubscription(vapidPublicKey);
    this.persisted = await this.loadOrCreateState();
    this.persisted.vapidPublicKey = vapidPublicKey;
    this.saveState();
    await this.connect();
    this.sendPushRegistration(subscription);
  }

  async testPush(): Promise<void> {
    if (this.mockMode) return;
    this.persisted = await this.loadOrCreateState();
    await this.connect();
    await this.registerExistingPushSubscription();
    this.sendControl({
      type: "push.test",
      to: this.persisted.identity.deviceId
    });
  }

  clear(): void {
    localStorage.removeItem(STORAGE_KEY);
    this.cancelReconnect();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.mockMode = false;
    this.persisted = undefined;
    this.sharedKey = undefined;
    remoteState.set(initialState);
    void this.initialize();
  }

  async revokePairedPhones(): Promise<void> {
    if (this.mockMode) {
      this.clear();
      return;
    }
    await this.sendAppMessage({
      type: "pairings.revoke_all",
      requestId: randomId("req")
    });
    this.clear();
  }

  private async connect(): Promise<void> {
    if (!this.persisted?.peer) throw new Error("Pair a daemon before connecting");
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise && this.socket?.readyState === WebSocket.CONNECTING) return this.connectPromise;
    this.cancelReconnect();
    this.sharedKey = await deriveSharedAesKey(
      this.persisted.identity.privateKey,
      this.persisted.peer.daemonPublicKey
    );
    const socket = new WebSocket(this.persisted.peer.relayUrl);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      remoteState.update((state) => ({ ...state, connected: true, error: undefined }));
      this.sendControl({
        type: "hello",
        role: "mobile",
        deviceId: this.persisted?.identity.deviceId ?? "",
        deviceName: mobileName()
      });
      void this.registerExistingPushSubscription();
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      remoteState.update((state) => ({ ...state, connected: false }));
      this.scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      remoteState.update((state) => ({ ...state, connected: false, error: "Relay connection dropped. Reconnecting..." }));
    });
    socket.addEventListener("message", (event) => {
      this.handleMessage(event.data).catch((error) => {
        remoteState.update((state) => ({
          ...state,
          error: error instanceof Error ? error.message : "Message handling failed"
        }));
      });
    });
    const connection = new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("Relay connection failed")), { once: true });
      socket.addEventListener("close", () => {
        if (socket.readyState !== WebSocket.OPEN) reject(new Error("Relay connection closed"));
      }, { once: true });
    });
    const trackedConnection = connection.finally(() => {
      if (this.connectPromise === trackedConnection) this.connectPromise = undefined;
    });
    this.connectPromise = trackedConnection;
    return trackedConnection;
  }

  private async reconnectNow(): Promise<void> {
    if (this.mockMode || !this.persisted?.peer) return;
    this.cancelReconnect();
    try {
      await this.connect();
      await this.registerExistingPushSubscription();
      await this.requestSessions();
    } catch {
      remoteState.update((state) => ({
        ...state,
        connected: false,
        error: "Relay connection dropped. Reconnecting..."
      }));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!browser || this.mockMode || !this.persisted?.peer || this.reconnectTimer) return;
    const delays = [500, 1_000, 2_000, 5_000, 10_000, 30_000] as const;
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)] ?? 30_000;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnectNow();
    }, delay);
  }

  private cancelReconnect(): void {
    if (!this.reconnectTimer) return;
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private registerLifecycleReconnects(): void {
    if (this.lifecycleListenersRegistered) return;
    this.lifecycleListenersRegistered = true;
    const reconnect = () => {
      if (document.visibilityState === "hidden") return;
      void this.reconnectNow();
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    document.addEventListener("visibilitychange", reconnect);
  }

  private async registerExistingPushSubscription(): Promise<void> {
    const vapidPublicKey = this.persisted?.vapidPublicKey;
    if (
      !vapidPublicKey ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !("Notification" in window) ||
      Notification.permission !== "granted"
    ) {
      return;
    }
    try {
      const subscription = await this.ensurePushSubscription(vapidPublicKey);
      this.sendPushRegistration(subscription);
    } catch {
      // Reconnect should not fail just because the browser declined to refresh push state.
    }
  }

  private async ensurePushSubscription(vapidPublicKey: string): Promise<PushSubscription> {
    await this.registerServiceWorker();
    const registration = await navigator.serviceWorker.ready;
    return (
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toArrayBuffer(base64UrlToBytes(vapidPublicKey))
      }))
    );
  }

  private sendPushRegistration(subscription: PushSubscription): void {
    if (!this.persisted || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.sendControl({
      type: "push.register",
      deviceId: this.persisted.identity.deviceId,
      subscription: subscription.toJSON() as WebPushSubscriptionJson
    });
  }

  private async handleMessage(data: string): Promise<void> {
    const message = parseRelayWireMessage(data);
    if (message.type === "control") {
      const control = message.control;
      if (control.type === "pair.accepted") {
        remoteState.update((state) => ({
          ...state,
          pairing: false,
          peer: this.persisted?.peer,
          error: undefined
        }));
        await this.requestSessions();
      } else if (control.type === "error") {
        remoteState.update((state) => ({ ...state, pairing: false, error: control.message }));
      }
      return;
    }
    if (!this.sharedKey) throw new Error("No shared key for encrypted message");
    const appMessage = await decryptAppMessage(this.sharedKey, message.body);
    this.applyAppMessage(appMessage);
  }

  private applyAppMessage(message: AppMessage): void {
    switch (message.type) {
      case "sessions.snapshot":
        remoteState.update((state) =>
          persistUiCache({
            ...state,
            daemon: message.daemon,
            sessions: message.sessions,
            error: undefined
          })
        );
        return;
      case "daemon.status":
        remoteState.update((state) =>
          persistUiCache({
            ...state,
            daemon: message.daemon,
            error: undefined
          })
        );
        return;
      case "thread.snapshot":
        remoteState.update((state) =>
          persistUiCache({
            ...state,
            threads: {
              ...state.threads,
              [message.thread.id]: mergeThreadSnapshot(state, message.thread)
            },
            pendingTurns:
              state.pendingTurns[message.thread.id]?.status === "completed" ||
              state.pendingTurns[message.thread.id]?.status === "failed"
                ? withoutKey(state.pendingTurns, message.thread.id)
                : state.pendingTurns,
            error: undefined
          })
        );
        return;
      case "session.created": {
        const pendingCreate = this.pendingSessionCreates.get(message.requestId);
        const initialMessage = pendingCreate?.initialMessage;
        pendingCreate?.resolve(message.session);
        this.pendingSessionCreates.delete(message.requestId);
        remoteState.update((state) => {
          const session = initialMessage ? { ...message.session, status: "starting" } : message.session;
          const seeded = seedSessionThread(state, session);
          return persistUiCache(
            initialMessage ? addOptimisticTurn(seeded, message.session.id, message.requestId, initialMessage) : seeded
          );
        });
        return;
      }
      case "codex.event":
        remoteState.update((state) => persistUiCache(applyCodexEvent(state, message.event)));
        return;
      case "attention":
        remoteState.update((state) =>
          persistUiCache({
            ...state,
            attentions: [message.event, ...state.attentions.filter((item) => item.id !== message.event.id)]
          })
        );
        return;
      case "approval.settled":
        remoteState.update((state) =>
          persistUiCache({
            ...state,
            attentions: state.attentions.filter(
              (item) => item.pendingApproval?.codexRequestId !== message.codexRequestId
            )
          })
        );
        void this.requestSessions();
        return;
      case "pairings.revoked":
        this.clear();
        return;
      case "turn.accepted":
        this.pendingTurnRequests.get(message.requestId)?.resolve();
        this.pendingTurnRequests.delete(message.requestId);
        remoteState.update((state) => markPendingTurn(state, message.threadId, "accepted"));
        void this.readThread(message.threadId);
        return;
      case "error":
        this.rejectPending(message.requestId, message.message);
        if (isThreadPreparingError(message.message)) return;
        remoteState.update((state) => ({ ...state, error: message.message }));
        return;
      case "sessions.list":
      case "thread.read":
      case "turn.start":
      case "session.create":
      case "pairings.revoke_all":
      case "approval.respond":
        return;
      default:
        return assertNever(message);
    }
  }

  private rejectPending(requestId: string | undefined, message: string): void {
    if (!requestId) return;
    const error = new Error(message);
    this.pendingTurnRequests.get(requestId)?.reject(error);
    this.pendingTurnRequests.delete(requestId);
    this.pendingSessionCreates.get(requestId)?.reject(error);
    this.pendingSessionCreates.delete(requestId);
    remoteState.update((state) => markPendingTurnByRequest(state, requestId, "failed", message));
  }

  private async sendAppMessage(message: AppMessage): Promise<void> {
    if (!this.persisted?.peer) throw new Error("Pair a daemon first");
    await this.connect();
    if (!this.sharedKey) throw new Error("No shared key for daemon");
    const encrypted = await encryptAppMessage(this.sharedKey, message);
    this.send({
      type: "e2ee",
      header: createRelayHeader({
        from: this.persisted.identity.deviceId,
        to: this.persisted.peer.daemonId,
        kind: "request",
        seq: this.seq
      }),
      body: encrypted
    });
    this.seq += 1;
  }

  private sendControl(control: RelayControlMessage): void {
    this.send({ type: "control", control });
  }

  private send(message: RelayWireMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Relay socket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }

  private async loadOrCreateState(): Promise<PersistedState> {
    if (this.persisted) return this.persisted;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PersistedState;
    const identity = await createDeviceIdentity("mobile");
    const state: PersistedState = { identity };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state;
  }

  private saveState(): void {
    if (this.persisted) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.persisted));
    }
  }

  private async registerServiceWorker(): Promise<void> {
    if (!browser || !("serviceWorker" in navigator)) return;
    await navigator.serviceWorker.register("/service-worker.js", { type: "module" });
  }

  private async mockCreateSession(cwd: string, initialMessage?: string): Promise<SessionSummary> {
    const trimmedInitialMessage = initialMessage?.trim() ?? "";
    const session = mockSession({
      id: "mock-new-session",
      name: "Mobile race fix",
      preview: trimmedInitialMessage,
      cwd: cwd.trim() || "/Users/example/Projects/armorer-gauntlet",
      status: trimmedInitialMessage ? "starting" : "idle",
      updatedAt: Date.now() / 1000
    });
    remoteState.update((state) => {
      const seeded = seedSessionThread(state, session);
      return trimmedInitialMessage
        ? addOptimisticTurn(seeded, session.id, "mock-create-session-request", trimmedInitialMessage)
        : seeded;
    });
    window.setTimeout(() => {
      remoteState.update((state) => ({
        ...state,
        threads: {
          ...state.threads,
          [session.id]: {
            ...session,
            status: "idle",
            turns: trimmedInitialMessage
              ? [
                  {
                    id: "mock-new-turn",
                    status: "completed",
                    items: [
                      { id: "mock-new-user", type: "userMessage", text: trimmedInitialMessage },
                      { id: "mock-new-agent", type: "agentMessage", text: "Session is ready on mobile." }
                    ]
                  }
                ]
              : []
          }
        }
      }));
    }, 650);
    return session;
  }

  private async mockSendTurn(threadId: string, text: string): Promise<void> {
    const requestId = randomId("mock_req");
    remoteState.update((state) => addOptimisticTurn(state, threadId, requestId, text));
    window.setTimeout(() => {
      remoteState.update((state) => markPendingTurn(state, threadId, "accepted"));
    }, 60);
    window.setTimeout(() => {
      remoteState.update((state) => markPendingTurn(state, threadId, "running"));
    }, 140);
    window.setTimeout(() => {
      remoteState.update((state) => {
        const snapshot = {
          ...(state.threads[threadId] ?? mockThread(threadId)),
          status: "active",
          turns: [
            ...(state.threads[threadId]?.turns.filter((turn) => turn.id !== requestId) ?? []),
            {
              id: "mock-authoritative-turn",
              status: "running",
              items: [
                { id: "mock-authoritative-user", type: "userMessage", text },
                {
                  id: "mock-authoritative-agent",
                  type: "agentMessage",
                  text: "Working **from** the test fixture.\n\n- Markdown is enabled\n- Mobile stays stable"
                }
              ]
            }
          ]
        };
        return {
          ...state,
          threads: {
            ...state.threads,
            [threadId]: mergeThreadSnapshot(state, snapshot)
          }
        };
      });
    }, 260);
  }
}

export const remoteClient = new RemoteClient();

const MOBILE_NAME_LOOKUP: ReadonlyArray<readonly [string, string]> = [
  ["iPhone", "iPhone"],
  ["Android", "Android phone"]
];

function mobileName(): string {
  const ua = navigator.userAgent;
  return MOBILE_NAME_LOOKUP.find(([needle]) => ua.includes(needle))?.[1] ?? "Mobile browser";
}

function consumePairingPayloadFromUrl(): string | undefined {
  const url = new URL(window.location.href);
  const encodedPairing = url.searchParams.get("p") ?? url.searchParams.get("pair");
  if (!encodedPairing) return undefined;
  url.searchParams.delete("p");
  url.searchParams.delete("pair");
  window.history.replaceState({}, document.title, `${url.pathname}${url.search}${url.hash}`);
  return decodePairingParam(encodedPairing);
}

function normalizePairingText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return trimmed;
  const pairUrl = new URL(trimmed);
  const pair = pairUrl.searchParams.get("p") ?? pairUrl.searchParams.get("pair");
  if (!pair) return trimmed;
  return decodePairingParam(pair);
}

function decodePairingParam(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function isMockRemoteEnabled(): boolean {
  return env.PUBLIC_GAUNTLET_E2E_MOCK === "true" || new URL(window.location.href).searchParams.get("mock") === "e2e";
}

function isThreadPreparingError(message: string): boolean {
  return (
    message.includes("no rollout found for thread id") ||
    message.includes("is not materialized yet") ||
    message.includes("includeTurns is unavailable before first user message") ||
    /rollout (?:at )?.*\.jsonl is empty/i.test(message) ||
    /failed to read thread.*rollout (?:at )?.*is empty/i.test(message)
  );
}

function loadCachedUiState(): CachedUiState | undefined {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<CachedUiState>;
    return {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      threads: parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {},
      attentions: Array.isArray(parsed.attentions) ? parsed.attentions : [],
      ...(parsed.daemon ? { daemon: parsed.daemon } : {}),
      cachedAt: typeof parsed.cachedAt === "string" ? parsed.cachedAt : new Date(0).toISOString()
    };
  } catch {
    return undefined;
  }
}

function persistUiCache(state: RemoteUiState): RemoteUiState {
  if (!browser) return state;
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        daemon: state.daemon,
        sessions: state.sessions.slice(0, 80),
        threads: Object.fromEntries(Object.entries(state.threads).slice(0, 80)),
        attentions: state.attentions.slice(0, 20),
        cachedAt: new Date().toISOString()
      } satisfies CachedUiState)
    );
  } catch {
    // Cache is best-effort; live relay state remains the source of truth.
  }
  return state;
}

function createMockState(): RemoteUiState {
  const session = mockSession({
    id: "mock-existing-session",
    name: "Reply with exactly MOBILE_E2E_OK",
    preview: "Hi.",
    cwd: "/Users/example/Projects/armorer-gauntlet-e2e-workspace",
    status: "idle",
    updatedAt: Date.now() / 1000
  });
  const approval = new URL(window.location.href).searchParams.get("approval") === "1";
  const readyAttention = new URL(window.location.href).searchParams.get("ready") === "1";
  const longThread = new URL(window.location.href).searchParams.get("long") === "1";
  const attentions: AttentionEvent[] = [];
  if (approval) {
    attentions.push({
      id: "mock-approval",
      threadId: session.id,
      title: "Approve command?",
      body: "Codex requested command approval.",
      reason: "approval",
      createdAt: new Date().toISOString(),
      pendingApproval: {
        codexRequestId: "mock-command-approval",
        method: "item/commandExecution/requestApproval",
        threadId: session.id,
        title: "Approve command?",
        detail: "npm test",
        params: {},
        suggestedAcceptResponse: { decision: "accept" },
        suggestedDeclineResponse: { decision: "decline" }
      }
    });
  }
  if (readyAttention) {
    attentions.push({
      id: "mock-ready",
      threadId: session.id,
      title: "Codex is ready",
      body: "A session finished running and is waiting for instructions.",
      reason: "idle",
      createdAt: new Date().toISOString()
    });
  }
  return {
    ...initialState,
    ready: true,
    connected: true,
    identity: {
      deviceId: "mock-mobile",
      role: "mobile",
      publicKey: mockPublicKey(),
      privateKey: { ...mockPublicKey(), d: "mock" },
      createdAt: new Date().toISOString()
    },
    peer: {
      relayUrl: "ws://mock-relay",
      daemonId: "mock-daemon",
      daemonName: "Armorer Gauntlet",
      daemonPublicKey: mockPublicKey(),
      pairedAt: new Date().toISOString()
    },
    daemon: {
      id: "mock-daemon",
      name: "Armorer Gauntlet",
      connectedAt: new Date().toISOString(),
      pairedDeviceCount: 1
    },
    sessions: [session],
    attentions,
    threads: {
      [session.id]: {
        ...session,
        turns: [
          {
            id: "mock-turn-1",
            status: "completed",
            items: [{ id: "mock-agent-1", type: "agentMessage", text: "Hi." }]
          },
          ...(longThread
            ? Array.from({ length: 14 }, (_, index) => ({
                id: `mock-history-${index}`,
                status: "completed",
                items: [
                  {
                    id: `mock-history-agent-${index}`,
                    type: "agentMessage",
                    text: `History update ${index + 1}\n\nCodex completed another chunk of work in the session.`
                  }
                ]
              }))
            : [])
        ]
      }
    }
  };
}

function mockSession(input: Partial<SessionSummary> & Pick<SessionSummary, "id" | "name" | "cwd">): SessionSummary {
  const updatedAt = input.updatedAt ?? Date.now() / 1000;
  return {
    preview: "",
    createdAt: updatedAt,
    status: "idle",
    modelProvider: "openai",
    source: "mock",
    resumeCommand: `codex resume ${input.id}`,
    ...input,
    updatedAt
  };
}

function mockThread(threadId: string) {
  return {
    ...mockSession({
      id: threadId,
      name: "Mock session",
      cwd: "/Users/example/Projects/armorer-gauntlet"
    }),
    turns: []
  };
}

function mockPublicKey(): PublicKeyJwk {
  return {
    crv: "P-256",
    ext: true,
    key_ops: [],
    kty: "EC",
    x: "mock",
    y: "mock"
  };
}

function applyCodexEvent(state: RemoteUiState, event: CodexEvent): RemoteUiState {
  // agent.delta fires per streamed token; skip it from the audit log to avoid recreating the array on every chunk.
  let next: RemoteUiState =
    event.type === "agent.delta"
      ? state
      : { ...state, events: [event, ...state.events].slice(0, 80) };
  if (event.type === "agent.delta") {
    next = appendAgentDelta(next, event.threadId, event.turnId, event.itemId, event.delta);
  }
  if (event.type === "thread.status" && event.status.startsWith("active")) {
    next = markPendingTurn(next, event.threadId, "running");
  }
  if (event.type === "thread.status") {
    queueMicrotask(() => {
      void remoteClient.readThread(event.threadId);
      void remoteClient.requestSessions();
    });
  }
  if (event.type === "turn.completed") {
    next = markPendingTurn(next, event.threadId, event.status === "failed" ? "failed" : "completed", event.error);
    queueMicrotask(() => {
      void remoteClient.readThread(event.threadId);
      void remoteClient.requestSessions();
    });
  }
  return next;
}
