import { describe, expect, it } from "vitest";
import {
  addOptimisticTurn,
  initialState,
  mergeThreadSnapshot,
  seedSessionThread,
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
