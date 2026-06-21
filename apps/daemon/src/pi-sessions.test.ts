import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppMessage } from "@armorer/gauntlet-shared";
import { createPiSession, interruptPiTurn, listPiSessions, readPiThread, startPiTurn } from "./pi-sessions.js";

const originalPiSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const originalPiCliPath = process.env.PI_CLI_PATH;
const originalPiCliArgs = process.env.PI_CLI_ARGS;
const originalPiNodeBinDir = process.env.PI_NODE_BIN_DIR;

describe.sequential("Pi session adapter", () => {
  afterEach(() => {
    restoreEnv("PI_CODING_AGENT_SESSION_DIR", originalPiSessionDir);
    restoreEnv("PI_CLI_PATH", originalPiCliPath);
    restoreEnv("PI_CLI_ARGS", originalPiCliArgs);
    restoreEnv("PI_NODE_BIN_DIR", originalPiNodeBinDir);
  });

  it("lists and reads Pi sessions as first-class Gauntlet threads", async () => {
    const root = await tempPiRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });
    await writePiSession(root, workspace, "session-newer", [
      message("u1", "user", "Can you inspect the release?"),
      {
        type: "model_change",
        provider: "openrouter",
        model: "z-ai/glm-5.2",
        timestamp: "2026-06-21T16:01:00.000Z"
      },
      message("a1", "assistant", "Release notes look ready.", { provider: "openrouter" })
    ]);
    await writePiSession(root, workspace, "session-older", [message("u2", "user", "Older chat")]);

    const sessions = await listPiSessions();
    expect(sessions.map((session) => session.id)).toEqual(["pi:session-newer", "pi:session-older"]);
    expect(sessions[0]).toMatchObject({
      agent: "pi",
      name: "Can you inspect the release?",
      preview: "Release notes look ready.",
      modelProvider: "openrouter",
      source: "pi",
      status: "idle"
    });

    const thread = await readPiThread("pi:session-newer");
    expect(thread.agent).toBe("pi");
    expect(thread.turns).toHaveLength(1);
    expect(thread.turns[0]?.items.map((item) => item.type)).toEqual(["userMessage", "agentMessage"]);
    expect(thread.turns[0]?.items.at(-1)?.text).toBe("Release notes look ready.");
  });

  it("runs a Pi turn and emits the mobile lifecycle events", async () => {
    const root = await tempPiRoot();
    process.env.PI_CLI_PATH = await writeFakePiCli(root, "reply");

    const session = await createPiSession(root);
    const { relay, messages, completed } = relayRecorder((message) => {
      return message.type === "codex.event" && message.event.type === "thread.status" && message.event.status === "idle";
    });

    await startPiTurn(relay, {
      fromMobileId: "mobile-1",
      requestId: "req-1",
      threadId: session.id,
      text: "Reply exactly: PI_TEST_OK"
    });
    await completed;

    expect(messages.map(labelMessage)).toEqual([
      "turn.accepted",
      "thread.status:active",
      "turn.completed:completed",
      "thread.status:idle"
    ]);
    const thread = await readPiThread(session.id);
    expect(thread.turns[0]?.items.map((item) => item.text)).toEqual(["Reply exactly: PI_TEST_OK", "PI_TEST_OK"]);
  });

  it("prevents concurrent Pi turns on the same session", async () => {
    const root = await tempPiRoot();
    process.env.PI_CLI_PATH = await writeFakePiCli(root, "wait");

    const session = await createPiSession(root);
    const { relay, messages, completed: active, waitFor } = relayRecorder((message) => {
      return message.type === "codex.event" && message.event.type === "thread.status" && message.event.status === "active";
    });

    await startPiTurn(relay, {
      fromMobileId: "mobile-1",
      requestId: "req-active",
      threadId: session.id,
      text: "Keep working"
    });
    await active;

    await expect(
      startPiTurn(relay, {
        fromMobileId: "mobile-1",
        requestId: "req-overlap",
        threadId: session.id,
        text: "Overlap"
      })
    ).rejects.toThrow("already has an active turn");

    const interrupted = waitFor((message) => {
      return message.type === "codex.event" && message.event.type === "turn.completed" && message.event.status === "interrupted";
    });
    await interruptPiTurn(relay, {
      fromMobileId: "mobile-1",
      requestId: "req-stop",
      threadId: session.id
    });
    await interrupted;
    expect(messages.map(labelMessage)).toContain("turn.interrupted");
  });
});

async function tempPiRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gauntlet-pi-test-"));
  process.env.PI_CODING_AGENT_SESSION_DIR = root;
  delete process.env.PI_CLI_ARGS;
  delete process.env.PI_NODE_BIN_DIR;
  return root;
}

async function writePiSession(root: string, cwd: string, id: string, entries: unknown[]): Promise<string> {
  const dir = join(root, cwd.replace(/[^A-Za-z0-9._-]/g, "-"));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `2026-06-21T16-00-00-000Z_${id}.jsonl`);
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp: id.endsWith("newer") ? "2026-06-21T16:00:00.000Z" : "2026-06-21T15:00:00.000Z",
    cwd
  };
  await writeFile(file, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return file;
}

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  extraMessage: Record<string, unknown> = {}
): Record<string, unknown> {
  const assistant = role === "assistant";
  return {
    type: "message",
    id,
    timestamp: assistant ? "2026-06-21T16:02:00.000Z" : "2026-06-21T16:00:30.000Z",
    message: {
      role,
      timestamp: assistant ? 1782057720 : 1782057630,
      content: [{ type: "text", text }],
      ...extraMessage
    }
  };
}

async function writeFakePiCli(root: string, mode: "reply" | "wait"): Promise<string> {
  const cli = join(root, `fake-pi-${mode}.mjs`);
  await writeFile(
    cli,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const session = process.argv[process.argv.indexOf("--session") + 1];
const prompt = process.argv.at(-1) ?? "";

if (${JSON.stringify(mode)} === "wait") {
  process.on("SIGTERM", () => setTimeout(() => process.exit(130), 5));
  setInterval(() => {}, 1000);
} else {
  const now = new Date().toISOString();
  const text = prompt.replace(/^Reply exactly:\\s*/i, "");
  const entries = [
    { type: "message", id: "fake-user", timestamp: now, message: { role: "user", timestamp: Date.now() / 1000, content: [{ type: "text", text: prompt }] } },
    { type: "message", id: "fake-assistant", timestamp: now, message: { role: "assistant", timestamp: Date.now() / 1000, content: [{ type: "text", text }] } }
  ];
  appendFileSync(session, entries.map((entry) => JSON.stringify(entry)).join("\\n") + "\\n", "utf8");
}
`,
    "utf8"
  );
  await chmod(cli, 0o755);
  return cli;
}

function relayRecorder(doneWhen: (message: AppMessage) => boolean): {
  relay: { sendToMobile(_mobileId: string, message: AppMessage): Promise<void> };
  messages: AppMessage[];
  completed: Promise<AppMessage>;
  waitFor(doneWhen: (message: AppMessage) => boolean): Promise<AppMessage>;
} {
  const messages: AppMessage[] = [];
  const waiters: Array<{ doneWhen: (message: AppMessage) => boolean; resolve: (message: AppMessage) => void }> = [];
  const completed = waitForMessage(messages, doneWhen, waiters);
  return {
    messages,
    completed,
    waitFor(doneWhen) {
      return waitForMessage(messages, doneWhen, waiters);
    },
    relay: {
      async sendToMobile(_mobileId, message) {
        messages.push(message);
        for (const waiter of [...waiters]) {
          if (waiter.doneWhen(message)) waiter.resolve(message);
        }
      }
    }
  };
}

function waitForMessage(
  messages: AppMessage[],
  doneWhen: (message: AppMessage) => boolean,
  waiters: Array<{ doneWhen: (message: AppMessage) => boolean; resolve: (message: AppMessage) => void }> = []
): Promise<AppMessage> {
  const existing = messages.find(doneWhen);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter = {
      doneWhen,
      resolve(message: AppMessage) {
        clearTimeout(timer);
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        resolve(message);
      }
    };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error("Timed out waiting for Pi adapter message"));
    }, 2000);
    waiters.push(waiter);
  });
}

function labelMessage(message: AppMessage): string {
  if (message.type === "codex.event" && message.event.type === "thread.status") return `thread.status:${message.event.status}`;
  if (message.type === "codex.event" && message.event.type === "turn.completed") return `turn.completed:${message.event.status}`;
  return message.type;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
