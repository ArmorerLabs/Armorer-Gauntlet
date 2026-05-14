import { browser } from "$app/environment";
import { goto } from "$app/navigation";
import { env } from "$env/dynamic/public";
import { get, writable } from "svelte/store";
import {
  addOptimisticTurn,
  applySessionsSnapshot,
  appendAgentDelta,
  initialState,
  markThreadInterrupted,
  markPendingTurn,
  markPendingTurnByRequest,
  mergeThreadSnapshot,
  rememberOpenedThread,
  seedSessionThread,
  setThreadError,
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
  type TurnAttachment,
  type WebPushSubscriptionJson
} from "@armorer/gauntlet-shared";
import type { CodexEvent } from "@armorer/gauntlet-shared";

const STORAGE_KEY = "armorer-gauntlet-state-v1";
const CACHE_PREFIX = "armorer-gauntlet-cache-v1";

interface PersistedState {
  identity: DeviceIdentity;
  peer?: MobilePeer;
  vapidPublicKey?: string;
}

interface CachedUiState {
  daemon?: RemoteUiState["daemon"];
  daemonId?: string;
  sessions: RemoteUiState["sessions"];
  threads: RemoteUiState["threads"];
  attentions: RemoteUiState["attentions"];
  lastOpenedThreadId?: string;
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
  private pendingInterruptRequests = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private pendingThreadReads = new Map<string, string>();
  private threadReadRetryCounts = new Map<string, number>();
  private mockSoftReadMisses = new Set<string>();
  private mockUnloadedSendMisses = new Set<string>();
  private pendingSessionCreates = new Map<
    string,
    { resolve: (session: SessionSummary) => void; reject: (error: Error) => void; initialMessage?: string }
  >();
  private autoOpenLatestAfterNextSessions = false;
  private mockInterruptedThreads = new Set<string>();

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
    const cached = pairingPayload ? undefined : loadCachedUiState(this.persisted.peer?.daemonId);
    remoteState.update((state) => ({
      ...state,
      ...(cached
        ? {
            daemon: cached.daemon,
            sessions: cached.sessions,
            threads: cached.threads,
            attentions: cached.attentions,
            lastOpenedThreadId: cached.lastOpenedThreadId
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
        this.autoOpenLatestAfterNextSessions = isStandaloneDisplay() && window.location.pathname === "/";
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
    this.autoOpenLatestAfterNextSessions = window.location.pathname === "/";
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
    if (this.mockMode) {
      this.mockReadThread(threadId);
      return;
    }
    const requestId = randomId("req");
    this.pendingThreadReads.set(requestId, threadId);
    remoteState.update((state) => rememberOpenedThread(state, threadId));
    await this.sendAppMessage({
      type: "thread.read",
      requestId,
      threadId
    });
  }

  async sendTurn(
    threadId: string,
    text: string,
    attachments: TurnAttachment[] = [],
    mode: "next" | "steer" = "next"
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && !attachments.length) return;
    if (this.mockMode) {
      await this.mockSendTurn(threadId, trimmed, attachments, mode);
      return;
    }
    const requestId = randomId("req");
    remoteState.update((state) =>
      addOptimisticTurn(
        state,
        threadId,
        requestId,
        trimmed,
        attachments.map(({ data, encoding, ...summary }) => summary),
        mode === "next" && isActiveThreadStatus(state.threads[threadId]?.status) ? "next" : "current"
      )
    );
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
        text: trimmed,
        mode,
        ...(attachments.length ? { attachments } : {})
      });
    } catch (error) {
      this.pendingTurnRequests.delete(requestId);
      const message = error instanceof Error ? error.message : "Message failed to send";
      remoteState.update((state) => markPendingTurnByRequest(state, requestId, "failed", message));
      throw error;
    }
    await accepted;
  }

  async interruptTurn(threadId: string): Promise<void> {
    if (this.mockMode) {
      this.mockInterruptTurn(threadId);
      return;
    }
    const requestId = randomId("req");
    const interrupted = new Promise<void>((resolve, reject) => {
      this.pendingInterruptRequests.set(requestId, { resolve, reject });
      window.setTimeout(() => {
        if (!this.pendingInterruptRequests.has(requestId)) return;
        this.pendingInterruptRequests.delete(requestId);
        reject(new Error("Codex did not acknowledge the stop request in time."));
      }, 15_000);
    });
    try {
      await this.sendAppMessage({
        type: "turn.interrupt",
        requestId,
        threadId
      });
    } catch (error) {
      this.pendingInterruptRequests.delete(requestId);
      throw error;
    }
    await interrupted;
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
    removeCachedUiStates();
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
        remoteState.update((state) => persistUiCache(applySessionsSnapshot(state, message.sessions, message.daemon)));
        if (this.autoOpenLatestAfterNextSessions) {
          this.autoOpenLatestAfterNextSessions = false;
          const lastOpenedThreadId = get(remoteState).lastOpenedThreadId;
          const latest = message.sessions.find((session) => session.id === lastOpenedThreadId) ?? message.sessions[0];
          if (latest && window.location.pathname === "/") {
            void goto(`/sessions/${latest.id}`);
          }
        }
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
        this.pendingThreadReads.delete(message.requestId);
        this.threadReadRetryCounts.delete(message.thread.id);
        remoteState.update((state) =>
          persistUiCache({
            ...state,
            threads: {
              ...state.threads,
              [message.thread.id]: mergeThreadSnapshot(state, message.thread)
            },
            threadErrors: withoutKey(state.threadErrors, message.thread.id),
            pendingTurns:
              state.pendingTurns[message.thread.id]?.status === "completed" ||
              state.pendingTurns[message.thread.id]?.status === "failed" ||
              state.pendingTurns[message.thread.id]?.status === "interrupted"
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
      case "turn.queued":
        this.pendingTurnRequests.get(message.requestId)?.resolve();
        this.pendingTurnRequests.delete(message.requestId);
        remoteState.update((state) => markPendingTurn(state, message.threadId, "queued"));
        return;
      case "turn.interrupted":
        this.pendingInterruptRequests.get(message.requestId)?.resolve();
        this.pendingInterruptRequests.delete(message.requestId);
        remoteState.update((state) => persistUiCache(markThreadInterrupted(state, message.threadId)));
        void this.readThread(message.threadId);
        void this.requestSessions();
        return;
      case "error":
        if (message.code === "thread_not_found") {
          if (this.handleSoftThreadNotFound(message.requestId, message.message)) return;
          this.markThreadNotFound(message.requestId, message.message);
          this.rejectPending(message.requestId, "This session is no longer available on this daemon.");
          return;
        }
        this.rejectPending(message.requestId, message.message);
        if (message.code === "thread_preparing" || isThreadPreparingError(message.message)) return;
        remoteState.update((state) => ({ ...state, error: message.message }));
        return;
      case "sessions.list":
      case "thread.read":
      case "turn.start":
      case "turn.interrupt":
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
    this.pendingInterruptRequests.get(requestId)?.reject(error);
    this.pendingInterruptRequests.delete(requestId);
    this.pendingThreadReads.delete(requestId);
    this.pendingSessionCreates.get(requestId)?.reject(error);
    this.pendingSessionCreates.delete(requestId);
    remoteState.update((state) => markPendingTurnByRequest(state, requestId, "failed", message));
  }

  private handleSoftThreadNotFound(requestId: string | undefined, message: string): boolean {
    if (!requestId) return false;
    const state = get(remoteState);
    const readThreadId = this.pendingThreadReads.get(requestId);
    if (readThreadId && isKnownOrPendingThread(state, readThreadId)) {
      this.pendingThreadReads.delete(requestId);
      const retryCount = this.threadReadRetryCounts.get(readThreadId) ?? 0;
      if (retryCount < 4) {
        this.threadReadRetryCounts.set(readThreadId, retryCount + 1);
        window.setTimeout(() => {
          void this.readThread(readThreadId);
        }, 180 + retryCount * 220);
      }
      return true;
    }

    const pendingThreadId = Object.entries(state.pendingTurns).find(([, pending]) => pending.requestId === requestId)?.[0];
    if (pendingThreadId && isKnownThread(state, pendingThreadId)) {
      this.rejectPending(requestId, "Codex could not attach to this session. Refreshing sessions...");
      void this.requestSessions();
      window.setTimeout(() => {
        void this.readThread(pendingThreadId);
      }, 350);
      return true;
    }

    return false;
  }

  private markThreadNotFound(requestId: string | undefined, message: string): void {
    const threadId =
      (requestId ? this.pendingThreadReads.get(requestId) : undefined) ??
      (requestId
        ? Object.entries(get(remoteState).pendingTurns).find(([, pending]) => pending.requestId === requestId)?.[0]
        : undefined);
    if (!threadId) return;
    this.pendingThreadReads.delete(requestId ?? "");
    remoteState.update((state) =>
      isKnownThread(state, threadId) ? state : setThreadError(state, threadId, "thread_not_found", message)
    );
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

  private mockReadThread(threadId: string): void {
    const requestId = randomId("mock_read");
    const url = new URL(window.location.href);
    if (url.searchParams.get("softReadMiss") === "1" && !this.mockSoftReadMisses.has(threadId)) {
      this.mockSoftReadMisses.add(threadId);
      this.pendingThreadReads.set(requestId, threadId);
      this.applyAppMessage({
        type: "error",
        requestId,
        code: "thread_not_found",
        message: `thread not found: ${threadId}`
      });
      return;
    }

    const thread = get(remoteState).threads[threadId] ?? mockThread(threadId);
    this.applyAppMessage({
      type: "thread.snapshot",
      requestId,
      thread
    });
  }

  private async mockSendTurn(
    threadId: string,
    text: string,
    attachments: TurnAttachment[] = [],
    mode: "next" | "steer" = "next"
  ): Promise<void> {
    if (threadId.startsWith("mock-stale")) {
      remoteState.update((state) =>
        setThreadError(state, threadId, "thread_not_found", "This session is no longer available on this daemon.")
      );
      throw new Error("This session is no longer available on this daemon.");
    }
    const requestId = randomId("mock_req");
    this.mockInterruptedThreads.delete(threadId);
    const summaries = attachments.map(({ data, encoding, ...summary }) => summary);
    remoteState.update((state) =>
      addOptimisticTurn(
        state,
        threadId,
        requestId,
        text,
        summaries,
        mode === "next" && isActiveThreadStatus(state.threads[threadId]?.status) ? "next" : "current"
      )
    );
    const url = new URL(window.location.href);
    const active = url.searchParams.get("active") === "1";
    const unloadedOnSend =
      url.searchParams.get("unloadedOnSend") === "1" && !this.mockUnloadedSendMisses.has(threadId);
    if (unloadedOnSend) this.mockUnloadedSendMisses.add(threadId);
    if (active && mode === "next") {
      window.setTimeout(() => {
        if (this.mockInterruptedThreads.has(threadId)) return;
        remoteState.update((state) => markPendingTurn(state, threadId, "queued"));
      }, 60);
      window.setTimeout(() => {
        if (this.mockInterruptedThreads.has(threadId)) return;
        remoteState.update((state) => markPendingTurn(state, threadId, "accepted"));
      }, 420);
      window.setTimeout(() => {
        if (this.mockInterruptedThreads.has(threadId)) return;
        remoteState.update((state) => markPendingTurn(state, threadId, "running"));
      }, 520);
    } else {
      window.setTimeout(() => {
        if (this.mockInterruptedThreads.has(threadId)) return;
        remoteState.update((state) => markPendingTurn(state, threadId, mode === "steer" ? "running" : "accepted"));
      }, unloadedOnSend ? 360 : 60);
      window.setTimeout(() => {
        if (this.mockInterruptedThreads.has(threadId)) return;
        remoteState.update((state) => markPendingTurn(state, threadId, "running"));
      }, unloadedOnSend ? 440 : 140);
    }
    window.setTimeout(() => {
      if (this.mockInterruptedThreads.has(threadId)) return;
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
                { id: "mock-authoritative-user", type: "userMessage", text, attachments: summaries },
                {
                  id: "mock-authoritative-agent",
                  type: "agentMessage",
                  text: [
                    "Working **from** the test fixture.",
                    "",
                    "- Markdown is enabled",
                    "- Mobile stays stable",
                    "",
                    "::git-stage{cwd=\"/Users/example/Projects/armorer-gauntlet\"} ::git-commit{cwd=\"/Users/example/Projects/armorer-gauntlet\"} ::git-push{cwd=\"/Users/example/Projects/armorer-gauntlet\" branch=\"main\"}"
                  ].join("\n")
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
          },
          pendingTurns: withoutKey(state.pendingTurns, threadId)
        };
      });
    }, active && mode === "next" ? 720 : unloadedOnSend ? 620 : 260);
  }

  private mockInterruptTurn(threadId: string): void {
    this.mockInterruptedThreads.add(threadId);
    remoteState.update((state) => markThreadInterrupted(state, threadId));
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

function isStandaloneDisplay(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
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

function isActiveThreadStatus(status: string | undefined): boolean {
  return Boolean(status && (status === "active" || status.startsWith("active:") || status === "starting"));
}

function isKnownOrPendingThread(state: RemoteUiState, threadId: string): boolean {
  return Boolean(
    isKnownThread(state, threadId) ||
      state.pendingTurns[threadId]
  );
}

function isKnownThread(state: RemoteUiState, threadId: string): boolean {
  return Boolean(state.threads[threadId] || state.sessions.some((session) => session.id === threadId));
}

function loadCachedUiState(daemonId: string | undefined): CachedUiState | undefined {
  if (!daemonId) return undefined;
  try {
    const raw = localStorage.getItem(cacheKey(daemonId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<CachedUiState>;
    if (parsed.daemonId && parsed.daemonId !== daemonId) return undefined;
    return {
      daemonId,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      threads: parsed.threads && typeof parsed.threads === "object" ? parsed.threads : {},
      attentions: Array.isArray(parsed.attentions) ? parsed.attentions : [],
      ...(parsed.daemon ? { daemon: parsed.daemon } : {}),
      ...(typeof parsed.lastOpenedThreadId === "string" ? { lastOpenedThreadId: parsed.lastOpenedThreadId } : {}),
      cachedAt: typeof parsed.cachedAt === "string" ? parsed.cachedAt : new Date(0).toISOString()
    };
  } catch {
    return undefined;
  }
}

function persistUiCache(state: RemoteUiState): RemoteUiState {
  if (!browser) return state;
  const daemonId = state.peer?.daemonId ?? state.daemon?.id;
  if (!daemonId) return state;
  try {
    localStorage.setItem(
      cacheKey(daemonId),
      JSON.stringify({
        daemonId,
        daemon: state.daemon,
        sessions: state.sessions.slice(0, 80),
        threads: Object.fromEntries(Object.entries(state.threads).slice(0, 80)),
        attentions: state.attentions.slice(0, 20),
        lastOpenedThreadId: state.lastOpenedThreadId,
        cachedAt: new Date().toISOString()
      } satisfies CachedUiState)
    );
  } catch {
    // Cache is best-effort; live relay state remains the source of truth.
  }
  return state;
}

function cacheKey(daemonId: string): string {
  return `${CACHE_PREFIX}:${daemonId}`;
}

function removeCachedUiStates(): void {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
  }
}

function createMockState(): RemoteUiState {
  const url = new URL(window.location.href);
  const activeThread = url.searchParams.get("active") === "1";
  const session = mockSession({
    id: "mock-existing-session",
    name: "Reply with exactly MOBILE_E2E_OK",
    preview: "Hi.",
    cwd: "/Users/example/Projects/armorer-gauntlet-e2e-workspace",
    status: activeThread ? "active" : "idle",
    updatedAt: Date.now() / 1000
  });
  const approval = url.searchParams.get("approval") === "1";
  const readyAttention = url.searchParams.get("ready") === "1";
  const longThread = url.searchParams.get("long") === "1";
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
  if (url.searchParams.get("autoLatest") === "1" && window.location.pathname === "/") {
    queueMicrotask(() => {
      void goto(`/sessions/${session.id}`);
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
    next = markPendingTurn(
      next,
      event.threadId,
      event.status === "failed" ? "failed" : event.status === "interrupted" ? "interrupted" : "completed",
      event.error
    );
    queueMicrotask(() => {
      void remoteClient.readThread(event.threadId);
      void remoteClient.requestSessions();
    });
  }
  return next;
}
