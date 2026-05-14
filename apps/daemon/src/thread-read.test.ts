import { describe, expect, it } from "vitest";
import { THREAD_PREPARING_MESSAGE, isTransientThreadReadError, readThreadWithRetry } from "./thread-read.js";

describe("thread read retry", () => {
  it("uses thread/read with turns instead of resuming the thread", async () => {
    const calls: unknown[] = [];
    const appServer = {
      async request(method: "thread/read", params: { threadId: string; includeTurns: boolean }) {
        calls.push({ method, params });
        return { thread: { id: params.threadId } };
      }
    };

    await expect(readThreadWithRetry(appServer, "thread-1", [])).resolves.toMatchObject({
      thread: { id: "thread-1" }
    });
    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true }
      }
    ]);
  });

  it("retries transient new-rollout read failures", async () => {
    let attempts = 0;
    const appServer = {
      async request() {
        attempts += 1;
        if (attempts < 3) throw new Error("no rollout found for thread id 123");
        return { thread: { id: "123" } };
      }
    };

    await expect(readThreadWithRetry(appServer, "123", [0, 0])).resolves.toMatchObject({
      thread: { id: "123" }
    });
    expect(attempts).toBe(3);
  });

  it("retries empty rollout files while a new session is being written", async () => {
    let attempts = 0;
    const emptyRolloutError =
      "failed to read thread: thread-store internal error: failed to read thread " +
      "/home/example/.codex/sessions/2026/05/13/rollout-019e245a.jsonl: rollout at " +
      "/home/example/.codex/sessions/2026/05/13/rollout-019e245a.jsonl is empty";
    const appServer = {
      async request() {
        attempts += 1;
        if (attempts < 2) {
          throw new Error(emptyRolloutError);
        }
        return { thread: { id: "019e245a" } };
      }
    };

    await expect(readThreadWithRetry(appServer, "019e245a", [0])).resolves.toMatchObject({
      thread: { id: "019e245a" }
    });
    expect(attempts).toBe(2);
  });

  it("falls back to metadata after bounded transient history retries", async () => {
    const calls: unknown[] = [];
    const appServer = {
      async request(method: "thread/read", params: { threadId: string; includeTurns: boolean }) {
        calls.push({ method, params });
        if (params.includeTurns) throw new Error("no rollout found for thread id 123");
        return { thread: { id: params.threadId, turns: undefined } };
      }
    };

    await expect(readThreadWithRetry(appServer, "123", [0])).resolves.toMatchObject({
      thread: { id: "123" }
    });
    expect(calls).toEqual([
      { method: "thread/read", params: { threadId: "123", includeTurns: true } },
      { method: "thread/read", params: { threadId: "123", includeTurns: true } },
      { method: "thread/read", params: { threadId: "123", includeTurns: false } }
    ]);
  });

  it("returns a friendly error if metadata fallback also hits the materialization race", async () => {
    const appServer = {
      async request() {
        throw new Error("thread 123 is not materialized yet; includeTurns is unavailable before first user message");
      }
    };

    await expect(readThreadWithRetry(appServer, "123", [])).rejects.toThrow(THREAD_PREPARING_MESSAGE);
  });

  it("does not retry unrelated read errors", async () => {
    let attempts = 0;
    const appServer = {
      async request() {
        attempts += 1;
        throw new Error("permission denied");
      }
    };

    await expect(readThreadWithRetry(appServer, "123", [0, 0])).rejects.toThrow("permission denied");
    expect(attempts).toBe(1);
  });

  it("recognizes rollout registration races", () => {
    expect(isTransientThreadReadError(new Error("no rollout found for thread id abc"))).toBe(true);
    expect(isTransientThreadReadError(new Error("rollout at /tmp/rollout-abc.jsonl is empty"))).toBe(true);
    expect(
      isTransientThreadReadError(
        new Error("thread abc is not materialized yet; includeTurns is unavailable before first user message")
      )
    ).toBe(true);
    expect(isTransientThreadReadError(new Error("thread archived"))).toBe(false);
  });
});
