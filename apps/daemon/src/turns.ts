import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AppErrorCode,
  type AppMessage,
  type TurnAttachment,
  type TurnMode
} from "@armorer/gauntlet-shared";
import { log } from "./logger.js";
import { THREAD_PREPARING_MESSAGE, isTransientThreadReadError } from "./thread-read.js";

const DEFAULT_TURN_START_RETRY_DELAYS = [150, 300, 600] as const;

export interface CodexTurnRequester {
  request(method: "turn/start" | "turn/steer" | "turn/interrupt" | "thread/resume", params: unknown): Promise<unknown>;
}

export interface MobileTurnRelay {
  sendToMobile(mobileId: string, message: AppMessage): Promise<void>;
}

export interface QueuedTurn {
  fromMobileId: string;
  requestId: string;
  threadId: string;
  text: string;
  attachments: TurnAttachment[];
}

export interface TurnRuntime {
  threadStatuses: Map<string, string>;
  activeTurnIds: Map<string, string>;
  queuedTurns: Map<string, QueuedTurn[]>;
  resumingThreads: Map<string, Promise<void>>;
  uploadRoot: string;
  turnStartRetryDelays: readonly number[];
}

export interface ClassifiedDaemonError {
  code: AppErrorCode;
  message: string;
}

type StartTurnInput = QueuedTurn & {
  mode: TurnMode;
  model?: string | undefined;
};

interface InterruptTurnInput {
  fromMobileId: string;
  requestId: string;
  threadId: string;
}

export function createTurnRuntime(
  uploadRoot = join(homedir(), ".armorer-gauntlet", "uploads"),
  turnStartRetryDelays: readonly number[] = DEFAULT_TURN_START_RETRY_DELAYS
): TurnRuntime {
  return {
    threadStatuses: new Map(),
    activeTurnIds: new Map(),
    queuedTurns: new Map(),
    resumingThreads: new Map(),
    uploadRoot,
    turnStartRetryDelays
  };
}

export async function handleTurnStart(
  appServer: CodexTurnRequester,
  relay: MobileTurnRelay,
  runtime: TurnRuntime,
  turn: StartTurnInput
): Promise<void> {
  log.debug("turn start", () => ({
    threadId: turn.threadId,
    mode: turn.mode,
    requestId: turn.requestId,
    currentStatus: runtime.threadStatuses.get(turn.threadId)
  }));
  if (turn.mode === "steer") {
    await steerActiveTurn(appServer, relay, runtime, turn);
    return;
  }

  if (isActiveStatus(runtime.threadStatuses.get(turn.threadId))) {
    const queue = runtime.queuedTurns.get(turn.threadId) ?? [];
    queue.push(turn);
    runtime.queuedTurns.set(turn.threadId, queue);
    log.debug("turn queued", () => ({ threadId: turn.threadId, depth: queue.length }));
    await relay.sendToMobile(turn.fromMobileId, {
      type: "turn.queued",
      requestId: turn.requestId,
      threadId: turn.threadId,
      queueDepth: queue.length
    });
    return;
  }

  await startTurnNow(appServer, relay, runtime, turn);
}

export async function drainQueuedTurns(
  appServer: CodexTurnRequester,
  relay: MobileTurnRelay,
  runtime: TurnRuntime,
  threadId: string,
  model?: string | undefined
): Promise<void> {
  if (isActiveStatus(runtime.threadStatuses.get(threadId))) return;
  const queue = runtime.queuedTurns.get(threadId);
  if (!queue?.length) return;
  const next = queue.shift();
  if (!next) return;
  if (!queue.length) runtime.queuedTurns.delete(threadId);
  log.debug("turn drain", () => ({ threadId, remaining: queue.length }));
  try {
    await startTurnNow(appServer, relay, runtime, { ...next, mode: "next", model });
  } catch (error) {
    const classified = classifyDaemonError(error);
    log.warn("turn drain failed", { threadId, code: classified.code, message: classified.message });
    await relay.sendToMobile(next.fromMobileId, {
      type: "error",
      requestId: next.requestId,
      code: classified.code,
      message: classified.message
    });
  }
}

export async function handleTurnInterrupt(
  appServer: CodexTurnRequester,
  relay: MobileTurnRelay,
  runtime: TurnRuntime,
  interrupt: InterruptTurnInput
): Promise<void> {
  const status = runtime.threadStatuses.get(interrupt.threadId);
  const activeTurnId = runtime.activeTurnIds.get(interrupt.threadId);
  log.debug("turn interrupt", () => ({ threadId: interrupt.threadId, status, activeTurnId }));
  if (isActiveStatus(status) && !activeTurnId) {
    throw new Error("Codex has not reported an interruptible turn yet. Try again in a moment.");
  }

  const clearedQueuedTurns = runtime.queuedTurns.get(interrupt.threadId)?.length ?? 0;
  runtime.queuedTurns.delete(interrupt.threadId);

  if (activeTurnId) {
    await appServer.request("turn/interrupt", {
      threadId: interrupt.threadId,
      turnId: activeTurnId
    });
    runtime.activeTurnIds.delete(interrupt.threadId);
  }
  runtime.threadStatuses.set(interrupt.threadId, "idle");

  await relay.sendToMobile(interrupt.fromMobileId, {
    type: "turn.interrupted",
    requestId: interrupt.requestId,
    threadId: interrupt.threadId,
    ...(activeTurnId ? { turnId: activeTurnId } : {}),
    clearedQueuedTurns
  });
}

export function isActiveStatus(status: string | undefined): boolean {
  return Boolean(status && (status === "active" || status.startsWith("active:") || status === "starting"));
}

export function classifyDaemonError(error: unknown): ClassifiedDaemonError {
  const raw = error instanceof Error ? error.message : String(error);
  if (isTransientThreadReadError(error) || raw === THREAD_PREPARING_MESSAGE) {
    return { code: "thread_preparing", message: "Codex is still preparing this session. Try again in a moment." };
  }
  if (/thread not found/i.test(raw) || /no thread found/i.test(raw) || /unknown thread/i.test(raw)) {
    return { code: "thread_not_found", message: "This session is no longer available on this daemon." };
  }
  if (/already.*active/i.test(raw) || /thread.*busy/i.test(raw) || /turn.*in progress/i.test(raw)) {
    return { code: "thread_busy", message: "Codex is already working in this session." };
  }
  return { code: "daemon_request_failed", message: raw || "Daemon request failed." };
}

async function steerActiveTurn(
  appServer: CodexTurnRequester,
  relay: MobileTurnRelay,
  runtime: TurnRuntime,
  turn: StartTurnInput
): Promise<void> {
  const activeTurnId = runtime.activeTurnIds.get(turn.threadId);
  if (!activeTurnId) {
    throw new Error("Cannot force steer because Codex has not reported the active turn yet.");
  }
  await appServer.request("turn/steer", {
    threadId: turn.threadId,
    expectedTurnId: activeTurnId,
    input: await buildCodexInput(turn, runtime)
  });
  await relay.sendToMobile(turn.fromMobileId, {
    type: "turn.accepted",
    requestId: turn.requestId,
    threadId: turn.threadId,
    turnId: activeTurnId
  });
}

async function startTurnNow(
  appServer: CodexTurnRequester,
  relay: MobileTurnRelay,
  runtime: TurnRuntime,
  turn: StartTurnInput
): Promise<void> {
  const response = (await requestTurnStartWithRetry(appServer, runtime, {
    threadId: turn.threadId,
    ...(turn.model ? { model: turn.model } : {}),
    input: await buildCodexInput(turn, runtime)
  })) as { turn?: { id?: string } };
  if (response.turn?.id) {
    runtime.activeTurnIds.set(turn.threadId, response.turn.id);
    runtime.threadStatuses.set(turn.threadId, "active");
  }
  await relay.sendToMobile(turn.fromMobileId, {
    type: "turn.accepted",
    requestId: turn.requestId,
    threadId: turn.threadId,
    turnId: response.turn?.id
  });
}

async function requestTurnStartWithRetry(
  appServer: CodexTurnRequester,
  runtime: TurnRuntime,
  params: Record<string, unknown>
): Promise<unknown> {
  let lastError: unknown;
  let attemptedResume = false;
  for (let attempt = 0; attempt <= runtime.turnStartRetryDelays.length; attempt += 1) {
    try {
      return await appServer.request("turn/start", params);
    } catch (error) {
      lastError = error;
      if (!isTransientTurnStartError(error)) {
        throw error;
      }
      if (!attemptedResume) {
        attemptedResume = true;
        log.debug("turn start resume", () => ({ threadId: params.threadId }));
        await resumeThreadForTurn(appServer, runtime, params);
        continue;
      }
      if (attempt >= runtime.turnStartRetryDelays.length) {
        throw error;
      }
      log.debug("turn start retry", () => ({ attempt, threadId: params.threadId }));
      await sleep(runtime.turnStartRetryDelays[attempt] ?? 0);
    }
  }
  throw lastError;
}

function isTransientTurnStartError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  return /thread not found/i.test(raw) || /no thread found/i.test(raw) || /unknown thread/i.test(raw);
}

async function resumeThreadForTurn(
  appServer: CodexTurnRequester,
  runtime: TurnRuntime,
  params: Record<string, unknown>
): Promise<void> {
  const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
  if (!threadId) return;
  const existing = runtime.resumingThreads.get(threadId);
  if (existing) {
    await existing;
    return;
  }

  const resume = appServer
    .request("thread/resume", {
      threadId,
      ...(typeof params.model === "string" ? { model: params.model } : {}),
      persistExtendedHistory: true
    })
    .then(() => undefined)
    .finally(() => {
      runtime.resumingThreads.delete(threadId);
    });
  runtime.resumingThreads.set(threadId, resume);
  await resume;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function buildCodexInput(
  turn: Pick<QueuedTurn, "requestId" | "threadId" | "text" | "attachments">,
  runtime: TurnRuntime
): Promise<Array<Record<string, unknown>>> {
  const savedAttachments = await saveAttachments(turn, runtime);
  const textBlocks = [turn.text.trim()].filter(Boolean);
  for (const attachment of turn.attachments.filter((item) => item.kind === "text")) {
    textBlocks.push(formatTextAttachment(attachment));
  }

  const input: Array<Record<string, unknown>> = [];
  if (textBlocks.length) {
    input.push({
      type: "text",
      text: textBlocks.join("\n\n"),
      text_elements: []
    });
  }
  for (const saved of savedAttachments.filter((item) => item.attachment.kind === "image")) {
    input.push({
      type: "localImage",
      path: saved.path
    });
  }
  return input;
}

async function saveAttachments(
  turn: Pick<QueuedTurn, "requestId" | "threadId" | "attachments">,
  runtime: TurnRuntime
): Promise<Array<{ attachment: TurnAttachment; path: string }>> {
  if (!turn.attachments.length) return [];
  const dir = join(runtime.uploadRoot, safePathSegment(turn.threadId), safePathSegment(turn.requestId));
  await mkdir(dir, { recursive: true });
  const saved: Array<{ attachment: TurnAttachment; path: string }> = [];
  for (const attachment of turn.attachments) {
    const filename = safeFilename(attachment.name);
    const path = join(dir, `${attachment.id}-${filename}`);
    const body =
      attachment.encoding === "base64" ? Buffer.from(attachment.data, "base64url") : Buffer.from(attachment.data, "utf8");
    await writeFile(path, body);
    saved.push({ attachment, path });
  }
  return saved;
}

function formatTextAttachment(attachment: TurnAttachment): string {
  const fence = attachment.data.includes("```") ? "````" : "```";
  return [
    `Attached file: ${attachment.name}`,
    `MIME type: ${attachment.mimeType || "text/plain"}`,
    "",
    fence,
    attachment.data,
    fence
  ].join("\n");
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 120) || "item";
}

function safeFilename(value: string): string {
  const cleaned = value.split(/[\\/]/).at(-1)?.replace(/[^A-Za-z0-9_. -]+/g, "_").trim() ?? "";
  return cleaned.slice(0, 120) || "attachment";
}
