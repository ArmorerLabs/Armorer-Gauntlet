import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  randomId,
  type AppMessage,
  type CodexThreadSnapshot,
  type SessionSummary,
  type ThreadItemSnapshot,
  type ThreadTurnSnapshot
} from "@armorer/gauntlet-shared";
import { log } from "./logger.js";

export const CLAUDE_THREAD_PREFIX = "claude:";
const DEFAULT_LIMIT = 50;
const activeClaudeTurns = new Map<string, ChildProcess>();
const pendingClaudeTurns = new Set<string>();
const interruptedClaudeTurns = new Set<string>();

type ClaudeRole = "user" | "assistant";

interface ClaudeMessage {
  id: string;
  role: ClaudeRole;
  text: string;
  timestamp: number;
  status?: string | undefined;
}

interface ClaudeSessionStore {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  messages: ClaudeMessage[];
}

export interface ClaudeMobileRelay {
  sendToMobile(mobileId: string, message: AppMessage): Promise<void>;
}

export function isClaudeThreadId(threadId: string): boolean {
  return threadId.startsWith(CLAUDE_THREAD_PREFIX);
}

export async function listClaudeSessions(limit = DEFAULT_LIMIT): Promise<SessionSummary[]> {
  const files = await findClaudeSessionFiles();
  const sessions = await Promise.all(
    files.map(async (file) => {
      try {
        return summarizeClaudeStore(await readClaudeStore(file));
      } catch (error) {
        log.warn("failed to read Claude session", { file, error: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    })
  );
  return sessions
    .filter((session): session is SessionSummary => Boolean(session))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit);
}

export async function readClaudeThread(threadId: string): Promise<CodexThreadSnapshot> {
  const file = await findClaudeSessionFile(threadId);
  if (!file) throw new Error(`Claude session not found: ${threadId}`);
  return snapshotClaudeStore(await readClaudeStore(file));
}

export async function createClaudeSession(cwd: string): Promise<SessionSummary> {
  const now = Date.now() / 1000;
  const store: ClaudeSessionStore = {
    id: randomUUID(),
    cwd,
    createdAt: now,
    updatedAt: now,
    status: "idle",
    messages: []
  };
  const file = claudeSessionFile(store.id);
  await mkdir(dirname(file), { recursive: true });
  await writeClaudeStore(file, store);
  return summarizeClaudeStore(store);
}

export async function startClaudeTurn(
  relay: ClaudeMobileRelay,
  input: {
    fromMobileId: string;
    requestId: string;
    threadId: string;
    text: string;
  }
): Promise<void> {
  const file = await findClaudeSessionFile(input.threadId);
  if (!file) throw new Error(`Claude session not found: ${input.threadId}`);
  if (pendingClaudeTurns.has(input.threadId) || activeClaudeTurns.has(input.threadId)) {
    throw new Error("Claude already has an active turn in this session.");
  }
  pendingClaudeTurns.add(input.threadId);

  const turnId = randomId("claude_turn");
  await relay.sendToMobile(input.fromMobileId, {
    type: "turn.accepted",
    requestId: input.requestId,
    threadId: input.threadId,
    turnId
  });
  await relay.sendToMobile(input.fromMobileId, {
    type: "codex.event",
    event: {
      type: "thread.status",
      threadId: input.threadId,
      status: "active"
    }
  });

  runClaudePrompt(input.threadId, file, input.text)
    .then(async () => {
      await relay.sendToMobile(input.fromMobileId, {
        type: "codex.event",
        event: {
          type: "turn.completed",
          threadId: input.threadId,
          turnId,
          status: "completed"
        }
      });
      await relay.sendToMobile(input.fromMobileId, {
        type: "codex.event",
        event: {
          type: "thread.status",
          threadId: input.threadId,
          status: "idle"
        }
      });
    })
    .catch(async (error) => {
      if (interruptedClaudeTurns.delete(input.threadId)) {
        await markClaudeSessionStatus(file, "idle");
        await relay.sendToMobile(input.fromMobileId, {
          type: "codex.event",
          event: {
            type: "turn.completed",
            threadId: input.threadId,
            turnId,
            status: "interrupted"
          }
        });
        await relay.sendToMobile(input.fromMobileId, {
          type: "codex.event",
          event: {
            type: "thread.status",
            threadId: input.threadId,
            status: "idle"
          }
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      await appendClaudeMessage(file, {
        id: randomId("claude_msg"),
        role: "assistant",
        text: message,
        timestamp: Date.now() / 1000,
        status: "failed"
      }, "failed");
      await relay.sendToMobile(input.fromMobileId, {
        type: "codex.event",
        event: {
          type: "turn.completed",
          threadId: input.threadId,
          turnId,
          status: "failed",
          error: message
        }
      });
      await relay.sendToMobile(input.fromMobileId, {
        type: "codex.event",
        event: {
          type: "thread.status",
          threadId: input.threadId,
          status: "idle"
        }
      });
    })
    .finally(() => {
      pendingClaudeTurns.delete(input.threadId);
    });
}

export async function interruptClaudeTurn(
  relay: ClaudeMobileRelay,
  input: {
    fromMobileId: string;
    requestId: string;
    threadId: string;
  }
): Promise<void> {
  const child = activeClaudeTurns.get(input.threadId);
  if (child || pendingClaudeTurns.has(input.threadId)) {
    interruptedClaudeTurns.add(input.threadId);
    child?.kill("SIGTERM");
  }
  await relay.sendToMobile(input.fromMobileId, {
    type: "turn.interrupted",
    requestId: input.requestId,
    threadId: input.threadId,
    clearedQueuedTurns: 0
  });
}

async function runClaudePrompt(threadId: string, file: string, text: string): Promise<void> {
  const session = await readClaudeStore(file);
  const timestamp = Date.now() / 1000;
  await appendClaudeMessage(
    file,
    {
      id: randomId("claude_msg"),
      role: "user",
      text,
      timestamp
    },
    "active"
  );

  const command = process.env.CLAUDE_CODE_CLI_PATH?.trim() || "claude";
  let spawnedChild: ChildProcess | undefined;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, ["--print", "--output-format", "text", "--session-id", session.id, ...claudeCliArgs(), text], {
      cwd: session.cwd || process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    spawnedChild = child;
    activeClaudeTurns.set(threadId, child);
    if (interruptedClaudeTurns.has(threadId)) child.kill("SIGTERM");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error((stderr || stdout).trim() || `Claude Code exited with code ${code}`));
      }
    });
  }).finally(() => {
    if (spawnedChild && activeClaudeTurns.get(threadId) === spawnedChild) activeClaudeTurns.delete(threadId);
  });

  await appendClaudeMessage(
    file,
    {
      id: randomId("claude_msg"),
      role: "assistant",
      text: output || "Claude Code finished without output.",
      timestamp: Date.now() / 1000
    },
    "idle"
  );
}

async function appendClaudeMessage(file: string, message: ClaudeMessage, status: string): Promise<void> {
  const store = await readClaudeStore(file);
  store.messages.push(message);
  store.status = status;
  store.updatedAt = message.timestamp;
  await writeClaudeStore(file, store);
}

async function markClaudeSessionStatus(file: string, status: string): Promise<void> {
  const store = await readClaudeStore(file);
  store.status = status;
  store.updatedAt = Date.now() / 1000;
  await writeClaudeStore(file, store);
}

async function findClaudeSessionFile(threadId: string): Promise<string | undefined> {
  const id = stripClaudePrefix(threadId);
  const file = claudeSessionFile(id);
  try {
    await readFile(file, "utf8");
    return file;
  } catch {
    return undefined;
  }
}

async function findClaudeSessionFiles(): Promise<string[]> {
  const root = claudeSessionsRoot();
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(root, entry.name));
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function readClaudeStore(file: string): Promise<ClaudeSessionStore> {
  const value = JSON.parse(await readFile(file, "utf8")) as Partial<ClaudeSessionStore>;
  if (!value.id) throw new Error("Claude session is missing an id");
  return {
    id: value.id,
    cwd: value.cwd ?? "",
    createdAt: numberValue(value.createdAt) ?? Date.now() / 1000,
    updatedAt: numberValue(value.updatedAt) ?? numberValue(value.createdAt) ?? Date.now() / 1000,
    status: value.status ?? "idle",
    messages: Array.isArray(value.messages) ? value.messages.map(coerceClaudeMessage) : []
  };
}

async function writeClaudeStore(file: string, store: ClaudeSessionStore): Promise<void> {
  await writeFile(file, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function summarizeClaudeStore(store: ClaudeSessionStore): SessionSummary {
  const snapshot = snapshotClaudeStore(store);
  return {
    id: snapshot.id,
    agent: "claude",
    name: snapshot.name,
    preview: snapshot.preview,
    cwd: snapshot.cwd,
    updatedAt: snapshot.updatedAt,
    createdAt: store.createdAt,
    status: snapshot.status,
    modelProvider: "anthropic",
    source: "claude",
    resumeCommand: `claude --resume ${store.id}`
  };
}

function snapshotClaudeStore(store: ClaudeSessionStore): CodexThreadSnapshot {
  return {
    id: `${CLAUDE_THREAD_PREFIX}${store.id}`,
    agent: "claude",
    name: firstUserText(store.messages) ?? (basename(store.cwd) || store.id),
    preview: lastMessagePreview(store.messages),
    cwd: store.cwd,
    status: store.status,
    updatedAt: store.updatedAt,
    resumeCommand: `claude --resume ${store.id}`,
    turns: claudeTurns(store)
  };
}

function claudeTurns(store: ClaudeSessionStore): ThreadTurnSnapshot[] {
  const turns: ThreadTurnSnapshot[] = [];
  let current: ThreadTurnSnapshot | undefined;
  for (const message of store.messages) {
    if (message.role === "user" || !current) {
      current = {
        id: randomId("claude_turn"),
        status: "completed",
        startedAt: message.timestamp,
        completedAt: undefined,
        items: []
      };
      turns.push(current);
    }
    current.items.push(claudeItem(message));
    current.completedAt = message.timestamp;
    if (message.status === "failed") current.status = "failed";
  }
  if (current && store.status === "active") current.status = "running";
  return turns;
}

function claudeItem(message: ClaudeMessage): ThreadItemSnapshot {
  return {
    id: message.id,
    type: message.role === "user" ? "userMessage" : "agentMessage",
    text: message.text,
    ...(message.status ? { status: message.status } : {})
  };
}

function firstUserText(messages: ClaudeMessage[]): string | undefined {
  const text = messages.find((message) => message.role === "user")?.text.trim();
  return text ? firstLine(text) : undefined;
}

function lastMessagePreview(messages: ClaudeMessage[]): string {
  for (const message of [...messages].reverse()) {
    const text = message.text.trim();
    if (text) return firstLine(text);
  }
  return "";
}

function claudeSessionsRoot(): string {
  return process.env.CLAUDE_GAUNTLET_SESSION_DIR?.trim() || join(homedir(), ".armorer-gauntlet", "claude-sessions");
}

function claudeSessionFile(id: string): string {
  return join(claudeSessionsRoot(), `${id}.json`);
}

function stripClaudePrefix(threadId: string): string {
  return threadId.startsWith(CLAUDE_THREAD_PREFIX) ? threadId.slice(CLAUDE_THREAD_PREFIX.length) : threadId;
}

function claudeCliArgs(): string[] {
  const raw = process.env.CLAUDE_CODE_CLI_ARGS?.trim();
  return raw ? splitCliArgs(raw) : [];
}

function splitCliArgs(raw: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaping = false;
  for (const char of raw) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

function coerceClaudeMessage(value: unknown): ClaudeMessage {
  const record = value && typeof value === "object" ? (value as Partial<ClaudeMessage>) : {};
  return {
    id: typeof record.id === "string" ? record.id : randomId("claude_msg"),
    role: record.role === "assistant" ? "assistant" : "user",
    text: typeof record.text === "string" ? record.text : "",
    timestamp: numberValue(record.timestamp) ?? Date.now() / 1000,
    status: typeof record.status === "string" ? record.status : undefined
  };
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}
