import { describe, expect, it } from "vitest";
import {
  addOptimisticTurn,
  applySessionsSnapshot,
  initialState,
  markThreadInterrupted,
  markPendingTurn,
  mergeThreadSnapshot,
  seedSessionThread,
  setThreadError,
  type RemoteUiState
} from "./remote-state.js";
import type { CodexThreadSnapshot, SessionSummary } from "@armorer/gauntlet-shared";

describe("remote state", () => {
  it("seeds a shell thread when a session is created", () => {
    const session = fakeSession();
    const state = seedSessionThread(initialState, session);

    expect(state.sessions).toHaveLength(1);
    expect(state.threads[session.id]).toMatchObject({
      id: session.id,
      cwd: session.cwd,
      status: session.status,
      turns: []
    });
  });

  it("can seed a created session with its first optimistic message", () => {
    const session = { ...fakeSession(), status: "starting" };
    const state = addOptimisticTurn(seedSessionThread(initialState, session), session.id, "req-create", "Start work");

    expect(state.pendingTurns[session.id]).toMatchObject({
      requestId: "req-create",
      status: "sending",
      text: "Start work"
    });
    expect(userMessages(state.threads[session.id]!)).toEqual(["Start work"]);
  });

  it("keeps one optimistic user message while the snapshot has not caught up", () => {
    const state = addOptimisticTurn(baseState(), "thread-1", "req-1", "I see double");
    const merged = mergeThreadSnapshot(state, fakeThread({ turns: [] }));

    expect(userMessages(merged)).toEqual(["I see double"]);
    expect(merged.status).toBe("starting");
  });

  it("removes the optimistic user message once the authoritative snapshot includes it", () => {
    const state = addOptimisticTurn(baseState(), "thread-1", "req-1", "I see double");
    const merged = mergeThreadSnapshot(
      state,
      fakeThread({
        turns: [
          {
            id: "turn-1",
            status: "running",
            items: [{ id: "user-1", type: "userMessage", text: "I see double" }]
          }
        ]
      })
    );

    expect(userMessages(merged)).toEqual(["I see double"]);
  });

  it("preserves streamed agent deltas until snapshots catch up", () => {
    const state = addOptimisticTurn(baseState(), "thread-1", "req-1", "Hello");
    state.threads["thread-1"]?.turns.push({
      id: "turn-stream",
      status: "running",
      items: [{ id: "agent-1", type: "agentMessage", text: "Working" }]
    });
    const merged = mergeThreadSnapshot(
      state,
      fakeThread({
        turns: [
          {
            id: "turn-1",
            status: "running",
            items: [{ id: "user-1", type: "userMessage", text: "Hello" }]
          }
        ]
      })
    );

    expect(userMessages(merged)).toEqual(["Hello"]);
    expect(agentMessages(merged)).toEqual(["Working"]);
  });

  it("keeps streamed agent text when a metadata-only snapshot arrives", () => {
    const state = baseState();
    state.threads["thread-1"]?.turns.push({
      id: "turn-stream",
      status: "running",
      items: [{ id: "agent-1", type: "agentMessage", text: "Already streaming" }]
    });

    const merged = mergeThreadSnapshot(state, fakeThread({ turns: [] }));

    expect(agentMessages(merged)).toEqual(["Already streaming"]);
    expect(userMessages(merged)).toEqual([]);
  });

  it("injects the optimistic user message ahead of agent items in a running snapshot turn", () => {
    const state = addOptimisticTurn(baseState(), "thread-1", "req-1", "Tell me");
    const merged = mergeThreadSnapshot(
      state,
      fakeThread({
        turns: [
          {
            id: "turn-new",
            status: "running",
            items: [{ id: "agent-1", type: "agentMessage", text: "Looking..." }]
          }
        ]
      })
    );

    const turn = merged.turns.find((entry) => entry.id === "turn-new");
    expect(turn?.items.map((item) => item.type)).toEqual(["userMessage", "agentMessage"]);
    expect(turn?.items[0]?.text).toBe("Tell me");
  });

  it("keeps prior user messages before newer authoritative pending turns", () => {
    const state = addOptimisticTurn(baseState(), "thread-1", "req-2", "second");
    state.threads["thread-1"]?.turns.unshift({
      id: "turn-history",
      status: "completed",
      items: [{ id: "user-old", type: "userMessage", text: "first" }]
    });

    const merged = mergeThreadSnapshot(
      state,
      fakeThread({
        turns: [
          {
            id: "turn-new",
            status: "running",
            items: [{ id: "user-new", type: "userMessage", text: "second" }]
          }
        ]
      })
    );

    expect(userMessages(merged)).toEqual(["first", "second"]);
  });

  it("keeps queued next messages after the currently active turn", () => {
    const state = addOptimisticTurn(
      {
        ...initialState,
        threads: {
          "thread-1": fakeThread({
            status: "active",
            turns: [
              {
                id: "turn-active",
                status: "running",
                items: [{ id: "agent-active", type: "agentMessage", text: "Still working" }]
              }
            ]
          })
        }
      },
      "thread-1",
      "req-next",
      "second queued",
      [],
      "next"
    );
    const merged = mergeThreadSnapshot(
      markPendingTurn(state, "thread-1", "queued"),
      fakeThread({
        status: "active",
        turns: [
          {
            id: "turn-active",
            status: "running",
            items: [{ id: "agent-active", type: "agentMessage", text: "Still working" }]
          }
        ]
      })
    );

    expect(merged.turns.map((turn) => turn.id)).toEqual(["turn-active", "req-next"]);
    expect(merged.turns[0]?.items.map((item) => item.text)).toEqual(["Still working"]);
    expect(merged.turns[1]?.items.map((item) => item.text)).toEqual(["second queued"]);
  });

  it("preserves non-message items in turns missing from the snapshot", () => {
    const state = addOptimisticTurn(baseState(), "thread-1", "req-1", "run it");
    state.threads["thread-1"]?.turns.unshift({
      id: "turn-history",
      status: "completed",
      items: [
        { id: "user-old", type: "userMessage", text: "list the files" },
        { id: "cmd-1", type: "commandExecution", command: "ls -la", output: "README.md" }
      ]
    });

    const merged = mergeThreadSnapshot(state, fakeThread({ turns: [] }));
    const historyTurn = merged.turns.find((turn) => turn.id === "turn-history");

    expect(historyTurn?.items.map((item) => item.type)).toEqual(["userMessage", "commandExecution"]);
  });

  it("keeps queued optimistic turns without duplicating them", () => {
    const state = markPendingTurn(
      addOptimisticTurn(baseState(), "thread-1", "req-1", "Run next", [
        { id: "att-1", name: "notes.txt", mimeType: "text/plain", size: 12, kind: "text" }
      ]),
      "thread-1",
      "queued"
    );
    const merged = mergeThreadSnapshot(state, fakeThread({ status: "idle", turns: [] }));

    expect(merged.status).toBe("starting");
    expect(userMessages(merged)).toEqual(["Run next"]);
    expect(merged.turns.at(-1)?.items.at(0)?.attachments).toEqual([
      { id: "att-1", name: "notes.txt", mimeType: "text/plain", size: 12, kind: "text" }
    ]);
  });

  it("marks stopped pending turns and returns the thread to idle", () => {
    const state = markPendingTurn(
      addOptimisticTurn(
        {
          ...baseState(),
          threads: {
            "thread-1": fakeThread({ status: "active" })
          }
        },
        "thread-1",
        "req-stop",
        "Queued work",
        [],
        "next"
      ),
      "thread-1",
      "queued"
    );

    const stopped = markThreadInterrupted(state, "thread-1");

    expect(stopped.pendingTurns["thread-1"]).toMatchObject({
      requestId: "req-stop",
      status: "interrupted",
      error: "Stopped."
    });
    expect(stopped.threads["thread-1"]?.status).toBe("idle");
  });

  it("prunes stale cached sessions by daemon snapshot but keeps pending work", () => {
    const stateWithPending = addOptimisticTurn(
      {
        ...initialState,
        threads: {
          "thread-1": fakeThread({ id: "thread-1" }),
          stale: fakeThread({ id: "stale" }),
          pending: fakeThread({ id: "pending" })
        },
        threadErrors: {
          stale: { code: "thread_not_found", message: "gone" },
          pending: { code: "thread_not_found", message: "gone" }
        }
      },
      "pending",
      "req-pending",
      "Still sending"
    );
    const state = {
      ...stateWithPending,
      threadErrors: {
        ...stateWithPending.threadErrors,
        pending: { code: "thread_not_found", message: "gone" }
      }
    };

    const next = applySessionsSnapshot(state, [fakeSession()], {
      id: "daemon-1",
      name: "Armorer",
      connectedAt: new Date().toISOString()
    });

    expect(Object.keys(next.threads).sort()).toEqual(["pending", "thread-1"]);
    expect(next.threadErrors).toEqual({
      pending: { code: "thread_not_found", message: "gone" }
    });
  });

  it("stores friendly thread errors outside the global composer error path", () => {
    const state = setThreadError(baseState(), "thread-1", "thread_not_found", "This session is no longer available.");

    expect(state.threadErrors["thread-1"]).toMatchObject({
      code: "thread_not_found",
      message: "This session is no longer available."
    });
    expect(state.error).toBeUndefined();
  });

  it("clears stale thread errors when the daemon snapshot proves the session still exists", () => {
    const next = applySessionsSnapshot(
      setThreadError(baseState(), "thread-1", "thread_not_found", "gone"),
      [fakeSession()],
      {
        id: "daemon-1",
        name: "Armorer",
        connectedAt: new Date().toISOString()
      }
    );

    expect(next.threadErrors["thread-1"]).toBeUndefined();
    expect(next.threads["thread-1"]).toBeDefined();
  });
});

function baseState(): RemoteUiState {
  const thread = fakeThread();
  return {
    ...initialState,
    threads: {
      [thread.id]: thread
    }
  };
}

function fakeSession(): SessionSummary {
  return {
    id: "thread-1",
    name: "Fix mobile",
    preview: "",
    cwd: "/repo",
    updatedAt: 10,
    createdAt: 5,
    status: "idle",
    modelProvider: "openai",
    source: "cli",
    resumeCommand: "codex resume thread-1"
  };
}

function fakeThread(input: Partial<CodexThreadSnapshot> = {}): CodexThreadSnapshot {
  return {
    id: "thread-1",
    name: "Fix mobile",
    preview: "",
    cwd: "/repo",
    status: "idle",
    updatedAt: 10,
    resumeCommand: "codex resume thread-1",
    turns: [],
    ...input
  };
}

function userMessages(thread: CodexThreadSnapshot): string[] {
  return thread.turns.flatMap((turn) =>
    turn.items.filter((item) => item.type === "userMessage").map((item) => item.text ?? "")
  );
}

function agentMessages(thread: CodexThreadSnapshot): string[] {
  return thread.turns.flatMap((turn) =>
    turn.items.filter((item) => item.type === "agentMessage").map((item) => item.text ?? "")
  );
}
