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
  type ThreadTurnSnapshot,
  type TurnAttachmentSummary
} from "@armorer/gauntlet-shared";
import { log } from "./logger.js";

export const PI_THREAD_PREFIX = "pi:";
const DEFAULT_LIMIT = 50;
const activePiTurns = new Map<string, ChildProcess>();
const interruptedPiTurns = new Set<string>();

type JsonRecord = Record<string, unknown>;

interface PiSessionFile {
  file: string;
  entries: JsonRecord[];
}

interface PiSessionHeader {
  id: string;
  cwd: string;
  createdAt: number;
}

export interface PiMobileRelay {
  sendToMobile(mobileId: string, message: AppMessage): Promise<void>;
}

export function isPiThreadId(threadId: string): boolean {
  return threadId.startsWith(PI_THREAD_PREFIX);
}

export async function listPiSessions(limit = DEFAULT_LIMIT): Promise<SessionSummary[]> {
  const files = await findPiSessionFiles();
  const sessions = await Promise.all(
    files.map(async (file) => {
      try {
        return summarizePiFile(await readPiFile(file));
      } catch (error) {
        log.warn("failed to read Pi session", { file, error: error instanceof Error ? error.message : String(error) });
        return undefined;
      }
    })
  );
  return sessions
    .filter((session): session is SessionSummary => Boolean(session))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit);
}

export async function readPiThread(threadId: string): Promise<CodexThreadSnapshot> {
  const file = await findPiSessionFile(threadId);
  if (!file) throw new Error(`Pi session not found: ${threadId}`);
  return snapshotPiFile(await readPiFile(file));
}

export async function createPiSession(cwd: string): Promise<SessionSummary> {
  const sessionId = randomUUID();
  const created = new Date();
  const file = join(piSessionDir(cwd), `${created.toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
  await mkdir(dirname(file), { recursive: true });
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: created.toISOString(),
    cwd
  };
  await writeFile(file, `${JSON.stringify(header)}\n`, "utf8");
  return summarizePiFile(await readPiFile(file));
}

export async function startPiTurn(
  relay: PiMobileRelay,
  input: {
    fromMobileId: string;
    requestId: string;
    threadId: string;
    text: string;
  }
): Promise<void> {
  const file = await findPiSessionFile(input.threadId);
  if (!file) throw new Error(`Pi session not found: ${input.threadId}`);
  if (activePiTurns.has(input.threadId)) throw new Error("Pi already has an active turn in this session.");
  const turnId = randomId("pi_turn");
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

  runPiPrompt(input.threadId, file, input.text)
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
      if (interruptedPiTurns.delete(input.threadId)) {
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
    });
}

export async function interruptPiTurn(
  relay: PiMobileRelay,
  input: {
    fromMobileId: string;
    requestId: string;
    threadId: string;
  }
): Promise<void> {
  const child = activePiTurns.get(input.threadId);
  if (child) {
    interruptedPiTurns.add(input.threadId);
    child.kill("SIGTERM");
  }
  await relay.sendToMobile(input.fromMobileId, {
    type: "turn.interrupted",
    requestId: input.requestId,
    threadId: input.threadId,
    clearedQueuedTurns: 0
  });
}

async function runPiPrompt(threadId: string, file: string, text: string): Promise<void> {
  const command = process.env.PI_CLI_PATH?.trim() || "pi";
  const cwd = snapshotPiFile(await readPiFile(file)).cwd || process.cwd();
  let spawnedChild: ChildProcess | undefined;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ["--session", file, ...piCliArgs(), "--print", text], {
      cwd,
      env: piSpawnEnv(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    spawnedChild = child;
    activePiTurns.set(threadId, child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(output.trim() || `Pi exited with code ${code}`));
      }
    });
  }).finally(() => {
    if (spawnedChild && activePiTurns.get(threadId) === spawnedChild) activePiTurns.delete(threadId);
  });
}

function piSpawnEnv(): NodeJS.ProcessEnv {
  const nodeBinDir = process.env.PI_NODE_BIN_DIR?.trim();
  return {
    ...process.env,
    ...(nodeBinDir ? { PATH: `${nodeBinDir}:${process.env.PATH ?? ""}` } : {})
  };
}

function piCliArgs(): string[] {
  const raw = process.env.PI_CLI_ARGS?.trim();
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

async function findPiSessionFile(threadId: string): Promise<string | undefined> {
  const id = stripPiPrefix(threadId);
  const files = await findPiSessionFiles();
  for (const file of files) {
    try {
      const header = piHeader((await readPiFile(file)).entries);
      if (header.id === id) return file;
    } catch {
      // Ignore malformed sessions while searching.
    }
  }
  return undefined;
}

async function findPiSessionFiles(): Promise<string[]> {
  const root = piSessionsRoot();
  try {
    return await walkJsonl(root);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code === "ENOENT") return [];
    throw error;
  }
}

async function walkJsonl(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkJsonl(path)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files;
}

async function readPiFile(file: string): Promise<PiSessionFile> {
  const text = await readFile(file, "utf8");
  const entries = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord);
  return { file, entries };
}

function summarizePiFile(session: PiSessionFile): SessionSummary {
  const snapshot = snapshotPiFile(session);
  return {
    id: snapshot.id,
    agent: "pi",
    name: snapshot.name,
    preview: snapshot.preview,
    cwd: snapshot.cwd,
    updatedAt: snapshot.updatedAt,
    createdAt: snapshot.turns[0]?.startedAt ?? snapshot.updatedAt,
    status: snapshot.status,
    modelProvider: piModelProvider(session.entries),
    source: "pi",
    resumeCommand: `pi --session ${session.file}`
  };
}

function snapshotPiFile(session: PiSessionFile): CodexThreadSnapshot {
  const header = piHeader(session.entries);
  const messages = session.entries.filter((entry) => entry.type === "message");
  const turns = piTurns(messages);
  const updatedAt = Math.max(header.createdAt, ...messages.map(entryTimeSeconds));
  return {
    id: `${PI_THREAD_PREFIX}${header.id}`,
    agent: "pi",
    name: piSessionName(session.entries) ?? firstUserText(messages) ?? (basename(header.cwd) || header.id),
    preview: lastMessagePreview(messages),
    cwd: header.cwd,
    status: piStatus(messages),
    updatedAt,
    resumeCommand: `pi --session ${session.file}`,
    turns
  };
}

function piTurns(messages: JsonRecord[]): ThreadTurnSnapshot[] {
  const turns: ThreadTurnSnapshot[] = [];
  let current: ThreadTurnSnapshot | undefined;
  for (const entry of messages) {
    const message = asRecord(entry.message);
    const role = stringValue(message.role);
    if (role === "user" || !current) {
      current = {
        id: stringValue(entry.id) || randomId("pi_turn"),
        status: "completed",
        startedAt: entryTimeSeconds(entry),
        completedAt: undefined,
        items: []
      };
      turns.push(current);
    }
    current.items.push(...piItems(entry));
    current.completedAt = entryTimeSeconds(entry);
    if (role === "assistant" && stringValue(message.stopReason) === "error") current.status = "failed";
  }
  return turns;
}

function piItems(entry: JsonRecord): ThreadItemSnapshot[] {
  const message = asRecord(entry.message);
  const role = stringValue(message.role);
  const id = stringValue(entry.id) || randomId("pi_item");
  if (role === "user") {
    const content = contentText(message.content);
    return [
      {
        id,
        type: "userMessage",
        text: content.text,
        ...(content.attachments.length ? { attachments: content.attachments } : {})
      }
    ];
  }
  if (role === "toolResult") {
    return [
      {
        id,
        type: stringValue(message.toolName) === "bash" ? "commandExecution" : "dynamicToolCall",
        command: stringValue(message.toolName) || "tool",
        text: `Tool result: ${stringValue(message.toolName) || "tool"}`,
        output: contentText(message.content).text,
        status: message.isError === true ? "failed" : "completed"
      }
    ];
  }
  if (role === "assistant") {
    const items: ThreadItemSnapshot[] = [];
    for (const part of arrayRecords(message.content)) {
      const type = stringValue(part.type);
      if (type === "thinking") {
        items.push({ id: `${id}_thinking_${items.length}`, type: "reasoning", text: stringValue(part.thinking) });
      } else if (type === "text") {
        items.push({ id: `${id}_text_${items.length}`, type: "agentMessage", text: stringValue(part.text) });
      } else if (type === "toolCall") {
        items.push({
          id: stringValue(part.id) || `${id}_tool_${items.length}`,
          type: stringValue(part.name) === "bash" ? "commandExecution" : "dynamicToolCall",
          command: toolCommand(part),
          text: `Tool: ${stringValue(part.name) || "tool"}`,
          output: formatJson(part.arguments),
          status: "running"
        });
      }
    }
    const error = stringValue(message.errorMessage);
    if (error) items.push({ id: `${id}_error`, type: "agentMessage", text: `Error: ${error}`, status: "failed" });
    return items.length ? items : [{ id, type: "agentMessage", text: "" }];
  }
  return [{ id, type: role || "unknown", text: contentText(message.content).text }];
}

function piHeader(entries: JsonRecord[]): PiSessionHeader {
  const header = entries.find((entry) => entry.type === "session");
  if (!header) throw new Error("Pi session is missing a header");
  const id = stringValue(header.id);
  if (!id) throw new Error("Pi session is missing an id");
  return {
    id,
    cwd: stringValue(header.cwd) || "",
    createdAt: entryTimeSeconds(header)
  };
}

function piSessionName(entries: JsonRecord[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "session_info") continue;
    const name = stringValue(entry.name) || stringValue(asRecord(entry.sessionInfo).name);
    if (name) return name;
  }
  return undefined;
}

function piModelProvider(entries: JsonRecord[]): string {
  for (const entry of [...entries].reverse()) {
    if (entry.type === "model_change") return stringValue(entry.provider) || "pi";
    const message = asRecord(entry.message);
    const provider = stringValue(message.provider);
    if (provider) return provider;
  }
  return "pi";
}

function piStatus(messages: JsonRecord[]): string {
  const last = messages.at(-1);
  const message = asRecord(last?.message);
  if (stringValue(message.stopReason) === "error") return "failed";
  return "idle";
}

function firstUserText(messages: JsonRecord[]): string | undefined {
  const first = messages.find((entry) => stringValue(asRecord(entry.message).role) === "user");
  const text = contentText(asRecord(first?.message).content).text.trim();
  return text ? firstLine(text) : undefined;
}

function lastMessagePreview(messages: JsonRecord[]): string {
  for (const entry of [...messages].reverse()) {
    const message = asRecord(entry.message);
    const error = stringValue(message.errorMessage);
    if (error) return error;
    const text = contentText(message.content).text.trim();
    if (text) return firstLine(text);
  }
  return "";
}

function contentText(value: unknown): { text: string; attachments: TurnAttachmentSummary[] } {
  const attachments: TurnAttachmentSummary[] = [];
  const parts = Array.isArray(value) ? value : [];
  const text = parts
    .map((raw) => {
      const part = asRecord(raw);
      const type = stringValue(part.type);
      if (type === "text") return stringValue(part.text);
      if (type === "thinking") return stringValue(part.thinking);
      if (type === "image" || type === "localImage") {
        const path = stringValue(part.path) || stringValue(part.url);
        attachments.push({
          id: stringValue(part.id) || randomId("pi_att"),
          name: path ? basename(path) : "image",
          mimeType: stringValue(part.mimeType) || "image/*",
          size: numberValue(part.size) ?? 0,
          kind: "image"
        });
        return "";
      }
      if (type === "toolCall") return `Tool: ${stringValue(part.name) || "tool"}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return { text, attachments };
}

function toolCommand(part: JsonRecord): string {
  const args = asRecord(part.arguments);
  return stringValue(args.command) || stringValue(part.name) || "tool";
}

function piSessionsRoot(): string {
  return process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || join(piAgentDir(), "sessions");
}

function piSessionDir(cwd: string): string {
  return join(piSessionsRoot(), cwd.replace(/[^A-Za-z0-9._-]/g, "-"));
}

function piAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function stripPiPrefix(threadId: string): string {
  return threadId.startsWith(PI_THREAD_PREFIX) ? threadId.slice(PI_THREAD_PREFIX.length) : threadId;
}

function entryTimeSeconds(entry: JsonRecord): number {
  const messageTime = numberValue(asRecord(entry.message).timestamp);
  if (messageTime) return messageTime > 10_000_000_000 ? messageTime / 1000 : messageTime;
  const parsed = Date.parse(stringValue(entry.timestamp));
  return Number.isFinite(parsed) ? parsed / 1000 : Date.now() / 1000;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function arrayRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" ? (value as JsonRecord) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
