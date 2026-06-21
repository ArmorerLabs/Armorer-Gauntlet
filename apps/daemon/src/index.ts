#!/usr/bin/env node
import { Command } from "commander";
import qrcode from "qrcode-terminal";
import {
  assertNever,
  PROTOCOL_VERSION,
  encodePairingQrPayload,
  type AppMessage,
  type PairingQrPayload
} from "@armorer/gauntlet-shared";
import { randomBytes } from "node:crypto";
import { CodexAppServer } from "./codex-app-server.js";
import {
  asRecord,
  attentionFromApproval,
  attentionFromEvent,
  attentionFromStatusTransition,
  isIdleAttention,
  normalizeNotification,
  optionalString,
  pendingApprovalFromRequest,
  snapshotThread,
  summarizeThread
} from "./codex-normalize.js";
import { assertCodexReady } from "./codex-version.js";
import {
  createClaudeSession,
  interruptClaudeTurn,
  isClaudeThreadId,
  listClaudeSessions,
  readClaudeThread,
  startClaudeTurn
} from "./claude-sessions.js";
import { getConfigPath, loadOrCreateConfig, type DaemonConfig } from "./config.js";
import { initLogger, log } from "./logger.js";
import {
  createPiSession,
  interruptPiTurn,
  isPiThreadId,
  listPiSessions,
  readPiThread,
  startPiTurn
} from "./pi-sessions.js";
import { DaemonRelayClient } from "./relay-client.js";
import { readThreadWithRetry } from "./thread-read.js";
import {
  classifyDaemonError,
  createTurnRuntime,
  drainQueuedTurns,
  handleTurnInterrupt,
  handleTurnStart
} from "./turns.js";

const program = new Command();
const IDLE_ATTENTION_DEDUPE_MS = 5_000;

program
  .name("armorer-gauntlet-daemon")
  .description("Bridge local Codex app-server sessions to Armorer Gauntlet")
  .command("start")
  .requiredOption("--relay <url>", "Relay websocket URL, e.g. ws://127.0.0.1:8787")
  .option("--mobile-relay <url>", "Relay websocket URL encoded for the mobile app")
  .option("--app-url <url>", "Mobile PWA URL to encode in the pairing QR")
  .option("--name <name>", "Display name for this dev machine")
  .option("--pair", "Open a new 10-minute mobile pairing window", true)
  .option("--debug", "Trace relay messages and turn lifecycle (also GAUNTLET_DEBUG=1)")
  .option("--log-file <path>", "Tee stdout+stderr to a file (also GAUNTLET_LOG_FILE=<path>)")
  .action(
    async (options: {
      relay: string;
      mobileRelay?: string;
      appUrl?: string;
      name?: string;
      pair: boolean;
      debug?: boolean;
      logFile?: string;
    }) => {
      initLogger({
        debug: Boolean(options.debug) || process.env.GAUNTLET_DEBUG === "1",
        logFile: options.logFile ?? process.env.GAUNTLET_LOG_FILE ?? undefined
      });
      await startDaemon(options);
    }
  );

program
  .command("where")
  .description("Print daemon config path")
  .action(() => {
    console.log(getConfigPath());
  });

program.parse(process.argv);

async function startDaemon(options: {
  relay: string;
  mobileRelay?: string;
  appUrl?: string;
  name?: string;
  pair: boolean;
}): Promise<void> {
  const config = await loadOrCreateConfig({
    ...(options.name ? { daemonName: options.name } : {}),
    relayUrl: options.relay
  });
  const codexHealth = await assertCodexReady();
  console.log(`codex-cli ${codexHealth.version} ready`);
  console.log(codexHealth.loginStatus || "codex login status unavailable");

  const appServer = new CodexAppServer();
  const turnRuntime = createTurnRuntime();
  const relay = new DaemonRelayClient({
    config,
    relayUrl: options.relay,
    onMessage: async (message, fromMobileId) => {
      await handleMobileMessage(message, fromMobileId, appServer, relay, config, turnRuntime);
    }
  });

  const init = await appServer.start();
  console.log(`Codex app-server connected (${init.userAgent})`);
  await relay.connect();
  console.log(`Relay connected: ${options.relay}`);

  if (options.pair || Object.keys(config.pairings).length === 0) {
    const pairing = createPairingPayload(config, options.mobileRelay ?? options.relay);
    relay.registerPairOffer(pairing);
    printPairing(pairing, options.appUrl);
  }

  const idleAttentionAt = new Map<string, number>();
  const broadcastAttention = async (attention: ReturnType<typeof attentionFromEvent>) => {
    if (!attention) return;
    if (isIdleAttention(attention)) {
      const key = attention.threadId ?? "__global__";
      const now = Date.now();
      const lastSentAt = idleAttentionAt.get(key) ?? 0;
      if (now - lastSentAt < IDLE_ATTENTION_DEDUPE_MS) return;
      idleAttentionAt.set(key, now);
    }
    await relay.broadcast({ type: "attention", event: attention }, "attention");
  };

  appServer.on("notification", async (notification) => {
    log.debug("codex notification", () => ({ method: notification.method }));
    const startedTurn = activeTurnFromNotification(notification);
    if (startedTurn) {
      turnRuntime.activeTurnIds.set(startedTurn.threadId, startedTurn.turnId);
      turnRuntime.threadStatuses.set(startedTurn.threadId, "active");
    }
    const event = normalizeNotification(notification);
    if (!event) return;
    log.debug("relay broadcast", () => ({ event: event.type, threadId: "threadId" in event ? event.threadId : undefined }));
    await relay.broadcast({ type: "codex.event", event }, "event");
    if (event.type === "thread.status") {
      await broadcastAttention(attentionFromStatusTransition(event, turnRuntime.threadStatuses.get(event.threadId)));
      turnRuntime.threadStatuses.set(event.threadId, event.status);
      if (!event.status.startsWith("active")) {
        await drainQueuedTurns(appServer, relay, turnRuntime, event.threadId, codexModelOverride());
      }
    }
    if (event.type === "turn.completed") {
      if (turnRuntime.activeTurnIds.get(event.threadId) === event.turnId) {
        turnRuntime.activeTurnIds.delete(event.threadId);
      }
      turnRuntime.threadStatuses.set(event.threadId, "idle");
      await drainQueuedTurns(appServer, relay, turnRuntime, event.threadId, codexModelOverride());
    }
    await broadcastAttention(attentionFromEvent(event));
  });

  appServer.on("request", async (request) => {
    const approval = pendingApprovalFromRequest(request);
    if (!approval) {
      appServer.respondError(request.id, -32601, `Armorer Gauntlet cannot handle ${request.method}`);
      return;
    }
    await relay.broadcast(
      {
        type: "codex.event",
        event: {
          type: "approval.requested",
          request: approval
        }
      },
      "event"
    );
    await relay.broadcast({ type: "attention", event: attentionFromApproval(approval) }, "attention");
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      appServer.stop();
      process.exit(0);
    });
  }
}

async function handleMobileMessage(
  message: AppMessage,
  fromMobileId: string,
  appServer: CodexAppServer,
  relay: DaemonRelayClient,
  config: DaemonConfig,
  turnRuntime: ReturnType<typeof createTurnRuntime>
): Promise<void> {
  log.debug("mobile message", () => ({
    type: message.type,
    fromMobileId,
    threadId: "threadId" in message ? message.threadId : undefined,
    requestId: "requestId" in message ? message.requestId : undefined
  }));
  try {
    switch (message.type) {
      case "sessions.list": {
        const response = (await appServer.request("thread/list", {
          archived: message.archived ?? false,
          limit: 50,
          sortKey: "updated_at"
        })) as { data?: unknown[] };
        const codexSessions = (response.data ?? []).map(summarizeThread);
        const [piSessions, claudeSessions] = await Promise.all([listPiSessions(), listClaudeSessions()]);
        const sessions = [...codexSessions, ...piSessions, ...claudeSessions].sort((left, right) => right.updatedAt - left.updatedAt);
        for (const session of sessions) {
          turnRuntime.threadStatuses.set(session.id, session.status);
        }
        await relay.sendToMobile(fromMobileId, {
          type: "sessions.snapshot",
          requestId: message.requestId,
          sessions,
          daemon: daemonSummary(config)
        });
        return;
      }
      case "thread.read": {
        const thread = isPiThreadId(message.threadId)
          ? await readPiThread(message.threadId)
          : isClaudeThreadId(message.threadId)
            ? await readClaudeThread(message.threadId)
            : snapshotThread((await readThreadWithRetry(appServer, message.threadId)).thread);
        turnRuntime.threadStatuses.set(thread.id, thread.status);
        await relay.sendToMobile(fromMobileId, {
          type: "thread.snapshot",
          requestId: message.requestId,
          thread
        });
        return;
      }
      case "session.create": {
        const initialMessage = message.initialMessage?.trim();
        if (message.agent === "pi") {
          const session = await createPiSession(message.cwd);
          await relay.sendToMobile(fromMobileId, {
            type: "session.created",
            requestId: message.requestId,
            session
          });
          if (initialMessage) {
            await startPiTurn(relay, {
              fromMobileId,
              requestId: message.requestId,
              threadId: session.id,
              text: initialMessage
            });
          }
          return;
        }
        if (message.agent === "claude") {
          const session = await createClaudeSession(message.cwd);
          await relay.sendToMobile(fromMobileId, {
            type: "session.created",
            requestId: message.requestId,
            session
          });
          if (initialMessage) {
            await startClaudeTurn(relay, {
              fromMobileId,
              requestId: message.requestId,
              threadId: session.id,
              text: initialMessage
            });
          }
          return;
        }

        const model = codexModelOverride();
        const response = (await appServer.request("thread/start", {
          cwd: message.cwd,
          ...(model ? { model } : {}),
          experimentalRawEvents: false,
          persistExtendedHistory: true
        })) as { thread?: unknown };
        const thread = response.thread;
        if (!thread) throw new Error("Codex did not return a new thread");
        const session = summarizeThread(thread);
        await relay.sendToMobile(fromMobileId, {
          type: "session.created",
          requestId: message.requestId,
          session
        });
        if (initialMessage) {
          await handleTurnStart(appServer, relay, turnRuntime, {
            fromMobileId,
            requestId: message.requestId,
            threadId: session.id,
            text: initialMessage,
            attachments: [],
            mode: "next",
            ...(model ? { model } : {})
          });
        }
        return;
      }
      case "turn.start": {
        if (isPiThreadId(message.threadId)) {
          if (message.attachments?.length) throw new Error("Pi sessions do not support mobile attachments yet.");
          await startPiTurn(relay, {
            fromMobileId,
            requestId: message.requestId,
            threadId: message.threadId,
            text: message.text
          });
          return;
        }
        if (isClaudeThreadId(message.threadId)) {
          if (message.attachments?.length) throw new Error("Claude sessions do not support mobile attachments yet.");
          await startClaudeTurn(relay, {
            fromMobileId,
            requestId: message.requestId,
            threadId: message.threadId,
            text: message.text
          });
          return;
        }
        const model = codexModelOverride();
        await handleTurnStart(appServer, relay, turnRuntime, {
          fromMobileId,
          requestId: message.requestId,
          threadId: message.threadId,
          text: message.text,
          attachments: message.attachments ?? [],
          mode: message.mode ?? "next",
          ...(model ? { model } : {})
        });
        return;
      }
      case "turn.interrupt":
        if (isPiThreadId(message.threadId)) {
          await interruptPiTurn(relay, {
            fromMobileId,
            requestId: message.requestId,
            threadId: message.threadId
          });
          return;
        }
        if (isClaudeThreadId(message.threadId)) {
          await interruptClaudeTurn(relay, {
            fromMobileId,
            requestId: message.requestId,
            threadId: message.threadId
          });
          return;
        }
        await handleTurnInterrupt(appServer, relay, turnRuntime, {
          fromMobileId,
          requestId: message.requestId,
          threadId: message.threadId
        });
        return;
      case "approval.respond":
        appServer.respond(message.codexRequestId, message.response);
        await relay.sendToMobile(fromMobileId, {
          type: "approval.settled",
          requestId: message.requestId,
          codexRequestId: message.codexRequestId
        });
        return;
      case "pairings.revoke_all":
        await relay.sendToMobile(fromMobileId, {
          type: "pairings.revoked",
          requestId: message.requestId
        });
        await relay.revokeAllPairings();
        return;
      case "sessions.snapshot":
      case "daemon.status":
      case "thread.snapshot":
      case "turn.accepted":
      case "turn.queued":
      case "turn.interrupted":
      case "session.created":
      case "codex.event":
      case "attention":
      case "approval.settled":
      case "pairings.revoked":
      case "error":
        return;
      default:
        return assertNever(message);
    }
  } catch (error) {
    const requestId = "requestId" in message ? message.requestId : undefined;
    const classified = classifyDaemonError(error);
    log.warn("mobile message failed", { type: message.type, code: classified.code, message: classified.message });
    await relay.sendToMobile(fromMobileId, {
      type: "error",
      ...(requestId ? { requestId } : {}),
      code: classified.code,
      message: classified.message
    });
  }
}

function daemonSummary(config: DaemonConfig) {
  return {
    id: config.identity.deviceId,
    name: config.daemonName,
    connectedAt: new Date().toISOString(),
    pairedDeviceCount: Object.keys(config.pairings).length
  };
}

function codexModelOverride(): string | undefined {
  return process.env.ARMORER_CODEX_MODEL?.trim() || undefined;
}

function createPairingPayload(
  config: DaemonConfig,
  relayUrl: string
): PairingQrPayload {
  return {
    version: PROTOCOL_VERSION,
    relayUrl,
    daemonId: config.identity.deviceId,
    daemonName: config.daemonName,
    daemonPublicKey: config.identity.publicKey,
    pairingToken: createPairingToken(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
  };
}

function printPairing(pairing: PairingQrPayload, appUrl?: string): void {
  const payload = encodePairingQrPayload(pairing);
  if (appUrl) {
    const pairUrl = createPairingUrl(appUrl, payload);
    console.log("Scan this QR with your phone camera to open Armorer Gauntlet. It expires in 10 minutes.");
    qrcode.generate(pairUrl, { small: true });
    console.log(pairUrl);
    console.log("");
    console.log("Paste fallback payload:");
    console.log(payload);
    return;
  }

  console.log("Scan or paste this pairing payload in the PWA. It expires in 10 minutes.");
  qrcode.generate(payload, { small: true });
  console.log(payload);
}

function createPairingUrl(appUrl: string, payload: string): string {
  const url = new URL(appUrl);
  url.searchParams.set("p", Buffer.from(payload, "utf8").toString("base64url"));
  return url.toString();
}

function createPairingToken(): string {
  return `p_${randomBytes(12).toString("base64url")}`;
}

function activeTurnFromNotification(notification: { method: string; params?: unknown }): { threadId: string; turnId: string } | null {
  if (notification.method !== "turn/started") return null;
  const params = asRecord(notification.params);
  const turn = asRecord(params.turn);
  const threadId = optionalString(params.threadId);
  const turnId = optionalString(turn.id);
  return threadId && turnId ? { threadId, turnId } : null;
}
