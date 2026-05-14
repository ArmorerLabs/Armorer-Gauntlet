import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppMessage } from "@armorer/gauntlet-shared";
import {
  classifyDaemonError,
  createTurnRuntime,
  drainQueuedTurns,
  handleTurnInterrupt,
  handleTurnStart
} from "./turns.js";

describe("mobile turn runtime", () => {
  it("starts idle next turns immediately", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const messages: AppMessage[] = [];
    const runtime = createTurnRuntime();

    await handleTurnStart(
      {
        async request(method, params) {
          calls.push({ method, params: params as Record<string, unknown> });
          return { turn: { id: "turn-1" } };
        }
      },
      { async sendToMobile(_mobileId, message) { messages.push(message); } },
      runtime,
      {
        fromMobileId: "mobile-1",
        requestId: "req-1",
        threadId: "thread-1",
        text: "Run tests",
        attachments: [],
        mode: "next"
      }
    );

    expect(calls).toEqual([
      {
        method: "turn/start",
        params: {
          threadId: "thread-1",
          input: [{ type: "text", text: "Run tests", text_elements: [] }]
        }
      }
    ]);
    expect(runtime.threadStatuses.get("thread-1")).toBe("active");
    expect(messages).toEqual([{ type: "turn.accepted", requestId: "req-1", threadId: "thread-1", turnId: "turn-1" }]);
  });

  it("retries transient Codex turn-start thread lookup misses", async () => {
    let attempts = 0;
    const messages: AppMessage[] = [];
    const runtime = createTurnRuntime(undefined, [0, 0]);

    await handleTurnStart(
      {
        async request(method) {
          if (method === "thread/resume") return {};
          attempts += 1;
          if (attempts < 3) throw new Error("thread not found: thread-1");
          return { turn: { id: "turn-after-retry" } };
        }
      },
      { async sendToMobile(_mobileId, message) { messages.push(message); } },
      runtime,
      {
        fromMobileId: "mobile-1",
        requestId: "req-1",
        threadId: "thread-1",
        text: "Run tests",
        attachments: [],
        mode: "next"
      }
    );

    expect(attempts).toBe(3);
    expect(messages).toEqual([
      { type: "turn.accepted", requestId: "req-1", threadId: "thread-1", turnId: "turn-after-retry" }
    ]);
  });

  it("resumes unloaded existing threads before retrying turn start", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const messages: AppMessage[] = [];
    const runtime = createTurnRuntime(undefined, [0]);
    let turnStartAttempts = 0;

    await handleTurnStart(
      {
        async request(method, params) {
          calls.push({ method, params: params as Record<string, unknown> });
          if (method === "thread/resume") return { thread: { id: "thread-1" } };
          turnStartAttempts += 1;
          if (turnStartAttempts === 1) throw new Error("thread not found: thread-1");
          return { turn: { id: "turn-after-resume" } };
        }
      },
      { async sendToMobile(_mobileId, message) { messages.push(message); } },
      runtime,
      {
        fromMobileId: "mobile-1",
        requestId: "req-resume",
        threadId: "thread-1",
        text: "Can you still hear me?",
        attachments: [],
        mode: "next",
        model: "gpt-test"
      }
    );

    expect(calls.map((call) => call.method)).toEqual(["turn/start", "thread/resume", "turn/start"]);
    expect(calls[1]?.params).toEqual({
      threadId: "thread-1",
      model: "gpt-test",
      persistExtendedHistory: true
    });
    expect(messages).toEqual([
      { type: "turn.accepted", requestId: "req-resume", threadId: "thread-1", turnId: "turn-after-resume" }
    ]);
  });

  it("coalesces concurrent thread resumes for the same unloaded thread", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const messages: AppMessage[] = [];
    const runtime = createTurnRuntime(undefined, [0]);
    let resumed = false;
    let turnIndex = 0;

    await Promise.all(
      ["req-one", "req-two"].map((requestId) =>
        handleTurnStart(
          {
            async request(method, params) {
              calls.push({ method, params: params as Record<string, unknown> });
              if (method === "thread/resume") {
                await Promise.resolve();
                resumed = true;
                return { thread: { id: "thread-1" } };
              }
              if (!resumed) throw new Error("unknown thread thread-1");
              turnIndex += 1;
              return { turn: { id: `turn-${turnIndex}` } };
            }
          },
          { async sendToMobile(_mobileId, message) { messages.push(message); } },
          runtime,
          {
            fromMobileId: "mobile-1",
            requestId,
            threadId: "thread-1",
            text: `Message ${requestId}`,
            attachments: [],
            mode: "next"
          }
        )
      )
    );

    expect(calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "turn/start")).toHaveLength(4);
    expect(messages).toEqual([
      { type: "turn.accepted", requestId: "req-one", threadId: "thread-1", turnId: "turn-1" },
      { type: "turn.accepted", requestId: "req-two", threadId: "thread-1", turnId: "turn-2" }
    ]);
  });

  it("returns thread_not_found after bounded turn-start lookup retries", async () => {
    const messages: AppMessage[] = [];
    const runtime = createTurnRuntime(undefined, [0]);

    await expect(
      handleTurnStart(
        {
          async request() {
            throw new Error("thread not found: stale-thread");
          }
        },
        { async sendToMobile(_mobileId, message) { messages.push(message); } },
        runtime,
        {
          fromMobileId: "mobile-1",
          requestId: "req-stale",
          threadId: "stale-thread",
          text: "Hello",
          attachments: [],
          mode: "next"
        }
      )
    ).rejects.toThrow("thread not found");
  });

  it("returns thread_not_found when resume cannot load the thread", async () => {
    const runtime = createTurnRuntime(undefined, [0]);

    await expect(
      handleTurnStart(
        {
          async request(method) {
            if (method === "thread/resume") throw new Error("thread not found while resuming stale-thread");
            throw new Error("thread not found: stale-thread");
          }
        },
        { async sendToMobile() {} },
        runtime,
        {
          fromMobileId: "mobile-1",
          requestId: "req-stale",
          threadId: "stale-thread",
          text: "Hello",
          attachments: [],
          mode: "next"
        }
      )
    ).rejects.toThrow("thread not found while resuming");
  });

  it("queues default next turns while the thread is active and drains them when idle", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const messages: AppMessage[] = [];
    const runtime = createTurnRuntime();
    runtime.threadStatuses.set("thread-1", "active");

    await handleTurnStart(
      {
        async request(method, params) {
          calls.push({ method, params: params as Record<string, unknown> });
          return { turn: { id: "turn-queued" } };
        }
      },
      { async sendToMobile(_mobileId, message) { messages.push(message); } },
      runtime,
      {
        fromMobileId: "mobile-1",
        requestId: "req-queued",
        threadId: "thread-1",
        text: "Next instruction",
        attachments: [],
        mode: "next"
      }
    );

    expect(calls).toEqual([]);
    expect(messages).toEqual([{ type: "turn.queued", requestId: "req-queued", threadId: "thread-1", queueDepth: 1 }]);

    runtime.threadStatuses.set("thread-1", "idle");
    await drainQueuedTurns(
      {
        async request(method, params) {
          calls.push({ method, params: params as Record<string, unknown> });
          return { turn: { id: "turn-queued" } };
        }
      },
      { async sendToMobile(_mobileId, message) { messages.push(message); } },
      runtime,
      "thread-1"
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("turn/start");
    expect(messages.at(-1)).toEqual({
      type: "turn.accepted",
      requestId: "req-queued",
      threadId: "thread-1",
      turnId: "turn-queued"
    });
  });

  it("resumes unloaded threads while draining queued turns", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const messages: AppMessage[] = [];
    const runtime = createTurnRuntime(undefined, [0]);
    runtime.threadStatuses.set("thread-1", "active");
    let resumed = false;

    await handleTurnStart(
      {
        async request() {
          throw new Error("unexpected immediate start");
        }
      },
      { async sendToMobile(_mobileId, message) { messages.push(message); } },
      runtime,
      {
        fromMobileId: "mobile-1",
        requestId: "req-queued",
        threadId: "thread-1",
        text: "Next instruction",
        attachments: [],
        mode: "next"
      }
    );

    runtime.threadStatuses.set("thread-1", "idle");
    await drainQueuedTurns(
      {
        async request(method, params) {
          calls.push({ method, params: params as Record<string, unknown> });
          if (method === "thread/resume") {
            resumed = true;
            return { thread: { id: "thread-1" } };
          }
          if (!resumed) throw new Error("unknown thread thread-1");
          return { turn: { id: "turn-queued-after-resume" } };
        }
      },
      { async sendToMobile(_mobileId, message) { messages.push(message); } },
      runtime,
      "thread-1",
      "gpt-test"
    );

    expect(calls.map((call) => call.method)).toEqual(["turn/start", "thread/resume", "turn/start"]);
    expect(messages.at(-1)).toEqual({
      type: "turn.accepted",
      requestId: "req-queued",
      threadId: "thread-1",
      turnId: "turn-queued-after-resume"
    });
  });

  it("force steers an active turn when Codex reported the active turn id", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const messages: AppMessage[] = [];
    const runtime = createTurnRuntime();
    runtime.threadStatuses.set("thread-1", "active");
    runtime.activeTurnIds.set("thread-1", "turn-active");

    await handleTurnStart(
      {
        async request(method, params) {
          calls.push({ method, params: params as Record<string, unknown> });
          return {};
        }
      },
      { async sendToMobile(_mobileId, message) { messages.push(message); } },
      runtime,
      {
        fromMobileId: "mobile-1",
        requestId: "req-steer",
        threadId: "thread-1",
        text: "Please adjust course",
        attachments: [],
        mode: "steer"
      }
    );

    expect(calls).toEqual([
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-active",
          input: [{ type: "text", text: "Please adjust course", text_elements: [] }]
        }
      }
    ]);
    expect(messages).toEqual([
      { type: "turn.accepted", requestId: "req-steer", threadId: "thread-1", turnId: "turn-active" }
    ]);
  });

  it("interrupts the active turn and clears queued next turns", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const messages: AppMessage[] = [];
    const runtime = createTurnRuntime();
    runtime.threadStatuses.set("thread-1", "active");
    runtime.activeTurnIds.set("thread-1", "turn-active");
    runtime.queuedTurns.set("thread-1", [
      {
        fromMobileId: "mobile-1",
        requestId: "req-queued",
        threadId: "thread-1",
        text: "Run later",
        attachments: []
      }
    ]);

    await handleTurnInterrupt(
      {
        async request(method, params) {
          calls.push({ method, params: params as Record<string, unknown> });
          return {};
        }
      },
      { async sendToMobile(_mobileId, message) { messages.push(message); } },
      runtime,
      {
        fromMobileId: "mobile-1",
        requestId: "req-stop",
        threadId: "thread-1"
      }
    );

    expect(calls).toEqual([
      {
        method: "turn/interrupt",
        params: {
          threadId: "thread-1",
          turnId: "turn-active"
        }
      }
    ]);
    expect(runtime.activeTurnIds.has("thread-1")).toBe(false);
    expect(runtime.queuedTurns.has("thread-1")).toBe(false);
    expect(runtime.threadStatuses.get("thread-1")).toBe("idle");
    expect(messages).toEqual([
      {
        type: "turn.interrupted",
        requestId: "req-stop",
        threadId: "thread-1",
        turnId: "turn-active",
        clearedQueuedTurns: 1
      }
    ]);
  });

  it("rejects interrupt when an active thread has no reported turn id", async () => {
    const runtime = createTurnRuntime();
    runtime.threadStatuses.set("thread-1", "active");

    await expect(
      handleTurnInterrupt(
        {
          async request() {
            throw new Error("unexpected interrupt");
          }
        },
        { async sendToMobile() {} },
        runtime,
        {
          fromMobileId: "mobile-1",
          requestId: "req-stop",
          threadId: "thread-1"
        }
      )
    ).rejects.toThrow("interruptible turn");
  });

  it("saves phone attachments and passes text plus local images to Codex", async () => {
    const uploadRoot = await mkdtemp(join(tmpdir(), "gauntlet-uploads-"));
    const runtime = createTurnRuntime(uploadRoot);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

    await handleTurnStart(
      {
        async request(method, params) {
          calls.push({ method, params: params as Record<string, unknown> });
          return { turn: { id: "turn-1" } };
        }
      },
      { async sendToMobile() {} },
      runtime,
      {
        fromMobileId: "mobile-1",
        requestId: "req-1",
        threadId: "thread-1",
        text: "Review these",
        attachments: [
          {
            id: "att-text",
            name: "notes.md",
            mimeType: "text/markdown",
            size: 8,
            kind: "text",
            encoding: "utf8",
            data: "# Notes"
          },
          {
            id: "att-image",
            name: "../screen shot.png",
            mimeType: "image/png",
            size: 3,
            kind: "image",
            encoding: "base64",
            data: "AQID"
          }
        ],
        mode: "next"
      }
    );

    const input = calls[0]?.params.input as Array<Record<string, unknown>>;
    expect(input[0]?.text).toContain("Attached file: notes.md");
    expect(input[0]?.text).toContain("# Notes");
    expect(input[1]).toMatchObject({ type: "localImage" });

    const imagePath = String(input[1]?.path);
    expect(imagePath).toContain("att-image-screen shot.png");
    await expect(readFile(imagePath)).resolves.toEqual(Buffer.from([1, 2, 3]));
  });

  it("classifies stale, busy, and preparing daemon errors", () => {
    expect(classifyDaemonError(new Error("thread not found: abc"))).toMatchObject({ code: "thread_not_found" });
    expect(classifyDaemonError(new Error("turn already active"))).toMatchObject({ code: "thread_busy" });
    expect(classifyDaemonError(new Error("no rollout found for thread id abc"))).toMatchObject({
      code: "thread_preparing"
    });
  });
});
