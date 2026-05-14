import {
  type AttentionEvent,
  type CodexThreadSnapshot,
  type DaemonSummary,
  type DeviceIdentity,
  type PublicKeyJwk,
  type SessionSummary,
  type ThreadTurnSnapshot
} from "@armorer/gauntlet-shared";
import type { CodexEvent } from "@armorer/gauntlet-shared";

export interface MobilePeer {
  relayUrl: string;
  daemonId: string;
  daemonName: string;
  daemonPublicKey: PublicKeyJwk;
  pairedAt: string;
}

export interface PendingTurnState {
  requestId: string;
  text: string;
  status: "sending" | "accepted" | "running" | "completed" | "failed";
  error?: string;
}

export interface RemoteUiState {
  ready: boolean;
  connected: boolean;
  pairing: boolean;
  error?: string;
  identity?: DeviceIdentity;
  peer?: MobilePeer;
  daemon?: DaemonSummary;
  sessions: SessionSummary[];
  threads: Record<string, CodexThreadSnapshot>;
  events: CodexEvent[];
  attentions: AttentionEvent[];
  pendingTurns: Record<string, PendingTurnState>;
}

export const initialState: RemoteUiState = {
  ready: false,
  connected: false,
  pairing: false,
  sessions: [],
  threads: {},
  events: [],
  attentions: [],
  pendingTurns: {}
};

export function upsertSession(sessions: SessionSummary[], session: SessionSummary): SessionSummary[] {
  return [session, ...sessions.filter((item) => item.id !== session.id)].sort(
    (left, right) => right.updatedAt - left.updatedAt
  );
}

export function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export function seedSessionThread(state: RemoteUiState, session: SessionSummary): RemoteUiState {
  return {
    ...state,
    sessions: upsertSession(state.sessions, session),
    threads: {
      ...state.threads,
      [session.id]: state.threads[session.id] ?? sessionToThreadSnapshot(session)
    },
    error: undefined
  };
}

export function sessionToThreadSnapshot(session: SessionSummary): CodexThreadSnapshot {
  return {
    id: session.id,
    name: session.name,
    preview: session.preview,
    cwd: session.cwd,
    status: session.status,
    updatedAt: session.updatedAt,
    resumeCommand: session.resumeCommand,
    turns: []
  };
}

export function mergeThreadSnapshot(state: RemoteUiState, snapshot: CodexThreadSnapshot): CodexThreadSnapshot {
  const pending = state.pendingTurns[snapshot.id];
  const existing = state.threads[snapshot.id];
  if (!pending) return mergePreservedAgentTurns(snapshot, existing);

  const snapshotTurnIds = new Set(snapshot.turns.map((turn) => turn.id));
  const snapshotHasPendingText = hasUserText(snapshot.turns, pending.text);
  const preservedTurns = existing
    ? existing.turns
        .filter((turn) => !snapshotTurnIds.has(turn.id))
        .map((turn) => filterPreservableItems(turn, pending.text, snapshotHasPendingText))
        .filter((turn): turn is ThreadTurnSnapshot => Boolean(turn))
    : [];
  const needsOptimisticTurn = !snapshotHasPendingText && !hasUserText(preservedTurns, pending.text);

  return {
    ...snapshot,
    status: optimisticSnapshotStatus(snapshot.status, pending.status),
    turns: [
      ...snapshot.turns,
      ...(needsOptimisticTurn ? [createOptimisticTurn(pending)] : []),
      ...preservedTurns
    ]
  };
}

function mergePreservedAgentTurns(
  snapshot: CodexThreadSnapshot,
  existing: CodexThreadSnapshot | undefined
): CodexThreadSnapshot {
  if (!existing) return snapshot;
  const snapshotTurnIds = new Set(snapshot.turns.map((turn) => turn.id));
  const preservedTurns = existing.turns
    .filter((turn) => !snapshotTurnIds.has(turn.id))
    .map((turn) => ({
      ...turn,
      items: turn.items.filter((item) => item.type === "agentMessage")
    }))
    .filter((turn) => turn.items.length);
  return {
    ...snapshot,
    turns: [...snapshot.turns, ...preservedTurns]
  };
}

export function addOptimisticTurn(
  state: RemoteUiState,
  threadId: string,
  requestId: string,
  text: string
): RemoteUiState {
  const thread = state.threads[threadId];
  return {
    ...state,
    pendingTurns: {
      ...state.pendingTurns,
      [threadId]: { requestId, text, status: "sending" }
    },
    threads: thread
      ? {
          ...state.threads,
          [threadId]: {
            ...thread,
            turns: [
              ...thread.turns.filter((turn) => turn.id !== requestId),
              createOptimisticTurn({ requestId, text, status: "sending" })
            ]
          }
        }
      : state.threads
  };
}

export function markPendingTurn(
  state: RemoteUiState,
  threadId: string,
  status: PendingTurnState["status"],
  error?: string
): RemoteUiState {
  const pending = state.pendingTurns[threadId];
  if (!pending) return state;
  return {
    ...state,
    pendingTurns: {
      ...state.pendingTurns,
      [threadId]: {
        ...pending,
        status,
        ...(error ? { error } : {})
      }
    }
  };
}

export function markPendingTurnByRequest(
  state: RemoteUiState,
  requestId: string,
  status: PendingTurnState["status"],
  error?: string
): RemoteUiState {
  const threadId = Object.entries(state.pendingTurns).find(([, pending]) => pending.requestId === requestId)?.[0];
  return threadId ? markPendingTurn(state, threadId, status, error) : state;
}

export function appendAgentDelta(
  state: RemoteUiState,
  threadId: string,
  turnId: string,
  itemId: string,
  delta: string
): RemoteUiState {
  const thread = state.threads[threadId];
  if (!thread) return state;
  const turns = [...thread.turns];
  let turnIndex = turns.findIndex((turn) => turn.id === turnId);
  if (turnIndex === -1) {
    turns.push({
      id: turnId,
      status: "running",
      startedAt: Date.now() / 1000,
      items: []
    });
    turnIndex = turns.length - 1;
  }
  const turn = turns[turnIndex];
  if (!turn) return state;
  const items = [...turn.items];
  const itemIndex = items.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) {
    items.push({ id: itemId, type: "agentMessage", text: delta });
  } else {
    const item = items[itemIndex];
    if (item) items[itemIndex] = { ...item, text: `${item.text ?? ""}${delta}` };
  }
  turns[turnIndex] = { ...turn, status: "running", items };
  return {
    ...state,
    threads: {
      ...state.threads,
      [threadId]: { ...thread, turns }
    }
  };
}

function createOptimisticTurn(pending: Pick<PendingTurnState, "requestId" | "text" | "status">): ThreadTurnSnapshot {
  return {
    id: pending.requestId,
    status: pending.status,
    startedAt: Date.now() / 1000,
    items: [
      {
        id: `${pending.requestId}_user`,
        type: "userMessage",
        text: pending.text
      }
    ]
  };
}

function filterPreservableItems(
  turn: ThreadTurnSnapshot,
  pendingText: string,
  snapshotHasPendingText: boolean
): ThreadTurnSnapshot | null {
  const items = turn.items.filter((item) => {
    if (item.type === "agentMessage") return true;
    return !snapshotHasPendingText && item.type === "userMessage" && item.text?.trim() === pendingText;
  });
  return items.length ? { ...turn, items } : null;
}

function hasUserText(turns: ThreadTurnSnapshot[], text: string): boolean {
  return turns.some((turn) => turn.items.some((item) => item.type === "userMessage" && item.text?.trim() === text));
}

function optimisticSnapshotStatus(status: string, pendingStatus: PendingTurnState["status"]): string {
  if (pendingStatus === "running") return status.toLowerCase().includes("idle") ? "active" : status;
  if (pendingStatus === "sending" || pendingStatus === "accepted") {
    return status.toLowerCase().includes("idle") ? "starting" : status;
  }
  return status;
}
