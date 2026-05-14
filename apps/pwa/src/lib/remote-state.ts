import {
  type AttentionEvent,
  type CodexThreadSnapshot,
  type DaemonSummary,
  type DeviceIdentity,
  type PublicKeyJwk,
  type SessionSummary,
  type ThreadTurnSnapshot,
  type TurnAttachmentSummary
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
  status: "sending" | "queued" | "accepted" | "running" | "completed" | "failed" | "interrupted";
  placement?: "current" | "next";
  attachments?: TurnAttachmentSummary[];
  error?: string;
}

export interface ThreadErrorState {
  code: string;
  message: string;
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
  threadErrors: Record<string, ThreadErrorState>;
  events: CodexEvent[];
  attentions: AttentionEvent[];
  pendingTurns: Record<string, PendingTurnState>;
  lastOpenedThreadId?: string;
}

export const initialState: RemoteUiState = {
  ready: false,
  connected: false,
  pairing: false,
  sessions: [],
  threads: {},
  threadErrors: {},
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
    threadErrors: withoutKey(state.threadErrors, session.id),
    error: undefined
  };
}

export function applySessionsSnapshot(
  state: RemoteUiState,
  sessions: SessionSummary[],
  daemon: DaemonSummary
): RemoteUiState {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const pendingThreadIds = new Set(Object.keys(state.pendingTurns));
  return {
    ...state,
    daemon,
    sessions,
    threads: Object.fromEntries(
      Object.entries(state.threads).filter(([threadId]) => sessionIds.has(threadId) || pendingThreadIds.has(threadId))
    ),
    threadErrors: Object.fromEntries(
      Object.entries(state.threadErrors).filter(([threadId]) => !sessionIds.has(threadId) && pendingThreadIds.has(threadId))
    ),
    error: undefined
  };
}

export function setThreadError(
  state: RemoteUiState,
  threadId: string,
  code: string,
  message: string
): RemoteUiState {
  return {
    ...state,
    threadErrors: {
      ...state.threadErrors,
      [threadId]: { code, message }
    }
  };
}

export function rememberOpenedThread(state: RemoteUiState, threadId: string): RemoteUiState {
  return {
    ...state,
    lastOpenedThreadId: threadId
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
  if (!pending) return { ...snapshot, turns: mergeTurnsPreservingTimeline(snapshot, existing) };

  const adjustedSnapshot = pending.placement === "next" || hasUserText(snapshot.turns, pending.text)
    ? snapshot
    : injectPendingUserIntoActiveTurn(snapshot, pending);

  const snapshotHasPendingText = hasUserText(adjustedSnapshot.turns, pending.text);
  const optimisticTurn = snapshotHasPendingText ? undefined : createOptimisticTurn(pending);

  return {
    ...adjustedSnapshot,
    status: optimisticSnapshotStatus(adjustedSnapshot.status, pending.status),
    turns: mergeTurnsPreservingTimeline(adjustedSnapshot, existing, {
      pending,
      snapshotHasPendingText,
      optimisticTurn
    })
  };
}

function injectPendingUserIntoActiveTurn(
  snapshot: CodexThreadSnapshot,
  pending: PendingTurnState
): CodexThreadSnapshot {
  const lastIdx = snapshot.turns.length - 1;
  const lastTurn = snapshot.turns[lastIdx];
  if (!lastTurn) return snapshot;
  if (lastTurn.status === "completed" || lastTurn.status === "failed") return snapshot;
  if (lastTurn.items.some((item) => item.type === "userMessage" && item.text?.trim() === pending.text)) {
    return snapshot;
  }
  const injectedTurn: ThreadTurnSnapshot = {
    ...lastTurn,
    items: [
      {
        id: `${pending.requestId}_user`,
        type: "userMessage",
        text: pending.text,
        ...(pending.attachments?.length ? { attachments: pending.attachments } : {})
      },
      ...lastTurn.items
    ]
  };
  return {
    ...snapshot,
    turns: [...snapshot.turns.slice(0, lastIdx), injectedTurn]
  };
}

function mergeTurnsPreservingTimeline(
  snapshot: CodexThreadSnapshot,
  existing: CodexThreadSnapshot | undefined,
  pendingMerge?: {
    pending: PendingTurnState;
    snapshotHasPendingText: boolean;
    optimisticTurn?: ThreadTurnSnapshot | undefined;
  }
): ThreadTurnSnapshot[] {
  if (!existing) {
    return pendingMerge?.optimisticTurn ? [...snapshot.turns, pendingMerge.optimisticTurn] : snapshot.turns;
  }

  const usedSnapshotTurnIds = new Set<string>();
  const snapshotTurnIds = new Set(snapshot.turns.map((turn) => turn.id));
  const pendingSnapshotTurn = pendingMerge ? findTurnWithUserText(snapshot.turns, pendingMerge.pending.text) : undefined;
  const turns: ThreadTurnSnapshot[] = [];

  for (const existingTurn of existing.turns) {
    const snapshotTurn = snapshot.turns.find((turn) => turn.id === existingTurn.id);
    if (snapshotTurn) {
      turns.push(snapshotTurn);
      usedSnapshotTurnIds.add(snapshotTurn.id);
      continue;
    }

    if (pendingMerge && existingTurn.id === pendingMerge.pending.requestId) {
      if (pendingSnapshotTurn && !usedSnapshotTurnIds.has(pendingSnapshotTurn.id)) {
        turns.push(pendingSnapshotTurn);
        usedSnapshotTurnIds.add(pendingSnapshotTurn.id);
      } else if (pendingMerge.optimisticTurn) {
        turns.push(pendingMerge.optimisticTurn);
      }
      continue;
    }

    if (snapshotTurnIds.has(existingTurn.id)) continue;
    const preserved = pendingMerge
      ? filterPreservableItems(existingTurn, pendingMerge.pending.text, pendingMerge.snapshotHasPendingText)
      : existingTurn;
    if (preserved?.items.length) turns.push(preserved);
  }

  for (const snapshotTurn of snapshot.turns) {
    if (!usedSnapshotTurnIds.has(snapshotTurn.id)) {
      turns.push(snapshotTurn);
      usedSnapshotTurnIds.add(snapshotTurn.id);
    }
  }

  if (
    pendingMerge?.optimisticTurn &&
    !turns.some((turn) => turn.id === pendingMerge.optimisticTurn?.id) &&
    !hasUserText(turns, pendingMerge.pending.text)
  ) {
    turns.push(pendingMerge.optimisticTurn);
  }

  return turns;
}

export function addOptimisticTurn(
  state: RemoteUiState,
  threadId: string,
  requestId: string,
  text: string,
  attachments: TurnAttachmentSummary[] = [],
  placement: PendingTurnState["placement"] = "current"
): RemoteUiState {
  const thread = state.threads[threadId];
  return {
    ...state,
    pendingTurns: {
      ...state.pendingTurns,
      [threadId]: { requestId, text, status: "sending", placement, ...(attachments.length ? { attachments } : {}) }
    },
    threadErrors: withoutKey(state.threadErrors, threadId),
    threads: thread
      ? {
          ...state.threads,
          [threadId]: {
            ...thread,
            turns: [
              ...thread.turns.filter((turn) => turn.id !== requestId),
              createOptimisticTurn({ requestId, text, status: "sending", placement, attachments })
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

export function markThreadInterrupted(
  state: RemoteUiState,
  threadId: string,
  message = "Stopped."
): RemoteUiState {
  const thread = state.threads[threadId];
  const pending = state.pendingTurns[threadId];
  return {
    ...state,
    pendingTurns: pending
      ? {
          ...state.pendingTurns,
          [threadId]: {
            ...pending,
            status: "interrupted",
            error: message
          }
        }
      : state.pendingTurns,
    threads: thread
      ? {
          ...state.threads,
          [threadId]: {
            ...thread,
            status: "idle"
          }
        }
      : state.threads
  };
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

function createOptimisticTurn(
  pending: Pick<PendingTurnState, "requestId" | "text" | "status" | "placement" | "attachments">
): ThreadTurnSnapshot {
  return {
    id: pending.requestId,
    status: pending.status,
    startedAt: Date.now() / 1000,
    items: [
      {
        id: `${pending.requestId}_user`,
        type: "userMessage",
        text: pending.text,
        ...(pending.attachments?.length ? { attachments: pending.attachments } : {})
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
    if (item.type !== "userMessage") return true;
    if (item.text?.trim() === pendingText) return !snapshotHasPendingText;
    return true;
  });
  return items.length ? { ...turn, items } : null;
}

function hasUserText(turns: ThreadTurnSnapshot[], text: string): boolean {
  return turns.some((turn) => turn.items.some((item) => item.type === "userMessage" && item.text?.trim() === text));
}

function findTurnWithUserText(turns: ThreadTurnSnapshot[], text: string): ThreadTurnSnapshot | undefined {
  return turns.find((turn) => turn.items.some((item) => item.type === "userMessage" && item.text?.trim() === text));
}

function optimisticSnapshotStatus(status: string, pendingStatus: PendingTurnState["status"]): string {
  if (pendingStatus === "running") return status.toLowerCase().includes("idle") ? "active" : status;
  if (pendingStatus === "sending" || pendingStatus === "queued" || pendingStatus === "accepted") {
    return status.toLowerCase().includes("idle") ? "starting" : status;
  }
  return status;
}
