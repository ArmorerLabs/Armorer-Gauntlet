import { chmod, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppMessage } from "@armorer/gauntlet-shared";
import {
  createClaudeSession,
  interruptClaudeTurn,
  listClaudeSessions,
  readClaudeThread,
  startClaudeTurn
} from "./claude-sessions.js";

const originalSessionDir = process.env.CLAUDE_GAUNTLET_SESSION_DIR;
const originalCliPath = process.env.CLAUDE_CODE_CLI_PATH;
const originalCliArgs = process.env.CLAUDE_CODE_CLI_ARGS;

describe.sequential("Claude Code session adapter", () => {
  afterEach(() => {
    restoreEnv("CLAUDE_GAUNTLET_SESSION_DIR", originalSessionDir);
    restoreEnv("CLAUDE_CODE_CLI_PATH", originalCliPath);
    restoreEnv("CLAUDE_CODE_CLI_ARGS", originalCliArgs);
  });

  it("creates, lists, and reads Claude sessions as Gauntlet threads", async () => {
    const root = await tempClaudeRoot();
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true });

    const session = await createClaudeSession(workspace);
    expect(session).toMatchObject({
      agent: "claude",
      cwd: workspace,
      modelProvider: "anthropic",
      source: "claude",
      status: "idle"
    });
    expect(session.id).toMatch(/^claude:/);

    const sessions = await listClaudeSessions();
    expect(sessions.map((item) => item.id)).toEqual([session.id]);

    const thread = await readClaudeThread(session.id);
    expect(thread.agent).toBe("claude");
    expect(thread.resumeCommand).toContain("claude --resume");
    expect(thread.turns).toEqual([]);
  });

  it("runs a Claude turn and emits the mobile lifecycle events", async () => {
    const root = await tempClaudeRoot();
    process.env.CLAUDE_CODE_CLI_PATH = await writeFakeClaudeCli(root, "reply");

    const session = await createClaudeSession(root);
    const { relay, messages, completed } = relayRecorder((message) => {
      return message.type === "codex.event" && message.event.type === "thread.status" && message.event.status === "idle";
    });

    await startClaudeTurn(relay, {
      fromMobileId: "mobile-1",
      requestId: "req-1",
      threadId: session.id,
      text: "Reply exactly: CLAUDE_TEST_OK"
    });
    await completed;

    expect(messages.map(labelMessage)).toEqual([
      "turn.accepted",
      "thread.status:active",
      "turn.completed:completed",
      "thread.status:idle"
    ]);
    const thread = await readClaudeThread(session.id);
    expect(thread.turns[0]?.items.map((item) => item.text)).toEqual(["Reply exactly: CLAUDE_TEST_OK", "CLAUDE_TEST_OK"]);
  });

  it("prevents concurrent Claude turns on the same session", async () => {
    const root = await tempClaudeRoot();
    process.env.CLAUDE_CODE_CLI_PATH = await writeFakeClaudeCli(root, "wait");

    const session = await createClaudeSession(root);
    const { relay, messages, completed: active, waitFor } = relayRecorder((message) => {
      return message.type === "codex.event" && message.event.type === "thread.status" && message.event.status === "active";
    });

    await startClaudeTurn(relay, {
      fromMobileId: "mobile-1",
      requestId: "req-active",
      threadId: session.id,
      text: "Keep working"
    });
    await active;

    await expect(
      startClaudeTurn(relay, {
        fromMobileId: "mobile-1",
        requestId: "req-overlap",
        threadId: session.id,
        text: "Overlap"
      })
    ).rejects.toThrow("already has an active turn");

    const interrupted = waitFor((message) => {
      return message.type === "codex.event" && message.event.type === "turn.completed" && message.event.status === "interrupted";
    });
    await interruptClaudeTurn(relay, {
      fromMobileId: "mobile-1",
      requestId: "req-stop",
      threadId: session.id
    });
    await interrupted;
    expect(messages.map(labelMessage)).toContain("turn.interrupted");
  });
});

async function tempClaudeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gauntlet-claude-test-"));
  process.env.CLAUDE_GAUNTLET_SESSION_DIR = root;
  delete process.env.CLAUDE_CODE_CLI_ARGS;
  return root;
}

async function writeFakeClaudeCli(root: string, mode: "reply" | "wait"): Promise<string> {
  const cli = join(root, `fake-claude-${mode}.mjs`);
  await writeFile(
    cli,
    `#!/usr/bin/env node
const prompt = process.argv.at(-1) ?? "";

if (${JSON.stringify(mode)} === "wait") {
  process.on("SIGTERM", () => setTimeout(() => process.exit(130), 5));
  setInterval(() => {}, 1000);
} else {
  console.log(prompt.replace(/^Reply exactly:\\s*/i, ""));
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
      reject(new Error("Timed out waiting for Claude adapter message"));
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
