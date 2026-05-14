import {
  type AttentionEvent,
  type CodexEvent,
  type CodexThreadSnapshot,
  type PendingApproval,
  type SessionSummary,
  type ThreadItemSnapshot,
  type ThreadTurnSnapshot,
  randomId,
  textStatusFromCodexStatus,
  toResumeCommand,
  unwrapNestedErrorMessage
} from "@armorer/gauntlet-shared";

export function summarizeThread(thread: unknown): SessionSummary {
  const data = asRecord(thread);
  const id = stringField(data, "id");
  return {
    id,
    name: optionalString(data.name) ?? firstLine(optionalString(data.preview) ?? id),
    preview: optionalString(data.preview) ?? "",
    cwd: optionalString(data.cwd) ?? "",
    updatedAt: numberField(data, "updatedAt"),
    createdAt: numberField(data, "createdAt"),
    status: textStatusFromCodexStatus(data.status),
    modelProvider: optionalString(data.modelProvider) ?? "unknown",
    source: sourceToText(data.source),
    resumeCommand: toResumeCommand(id)
  };
}

export function snapshotThread(thread: unknown): CodexThreadSnapshot {
  const data = asRecord(thread);
  const summary = summarizeThread(thread);
  const turns = Array.isArray(data.turns) ? data.turns.map(snapshotTurn) : [];
  return {
    ...summary,
    turns
  };
}

export function normalizeNotification(message: { method: string; params?: unknown }): CodexEvent | null {
  const params = asRecord(message.params);
  switch (message.method) {
    case "thread/status/changed":
      return {
        type: "thread.status",
        threadId: stringField(params, "threadId"),
        status: textStatusFromCodexStatus(params.status),
        attentionFlags: activeFlagsFromStatus(params.status)
      };
    case "turn/completed": {
      const turn = asRecord(params.turn);
      return {
        type: "turn.completed",
        threadId: stringField(params, "threadId"),
        turnId: stringField(turn, "id"),
        status: optionalString(turn.status) ?? "unknown",
        error: codexErrorMessage(turn.error)
      };
    }
    case "item/agentMessage/delta":
      return {
        type: "agent.delta",
        threadId: stringField(params, "threadId"),
        turnId: stringField(params, "turnId"),
        itemId: stringField(params, "itemId"),
        delta: optionalString(params.delta) ?? ""
      };
    case "turn/diff/updated":
      return {
        type: "diff.updated",
        threadId: stringField(params, "threadId"),
        turnId: stringField(params, "turnId"),
        diff: optionalString(params.diff) ?? ""
      };
    default:
      return null;
  }
}

function codexErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === "string") return unwrapNestedErrorMessage(error);
  const data = asRecord(error);
  const message = optionalString(data.message) ?? optionalString(data.error);
  if (message) return unwrapNestedErrorMessage(message);
  const nested = asRecord(data.error);
  const nestedMessage = optionalString(nested.message);
  if (nestedMessage) return unwrapNestedErrorMessage(nestedMessage);
  return JSON.stringify(error);
}

export function attentionFromEvent(event: CodexEvent): AttentionEvent | null {
  if (event.type === "thread.status") {
    if (event.attentionFlags?.includes("waitingOnApproval")) {
      return createAttention({
        threadId: event.threadId,
        reason: "approval",
        title: "Codex needs approval",
        body: "A session is waiting for your decision."
      });
    }
    if (event.attentionFlags?.includes("waitingOnUserInput")) {
      return createAttention({
        threadId: event.threadId,
        reason: "user_input",
        title: "Codex needs input",
        body: "A session is waiting for more information."
      });
    }
  }
  if (event.type === "turn.completed") {
    if (event.status === "failed") {
      return createAttention({
        threadId: event.threadId,
        reason: "failed",
        title: "Codex turn failed",
        body: event.error ?? "Open the session to inspect the failure."
      });
    }
    if (event.status === "completed") {
      return createAttention({
        threadId: event.threadId,
        reason: "idle",
        title: "Codex is ready",
        body: "A turn completed and the session is idle."
      });
    }
  }
  return null;
}

export function attentionFromStatusTransition(
  event: CodexEvent,
  previousStatus: string | undefined
): AttentionEvent | null {
  if (event.type !== "thread.status") return null;
  if (!previousStatus || !isActiveStatus(previousStatus) || !isIdleStatus(event.status)) return null;
  return createAttention({
    threadId: event.threadId,
    reason: "idle",
    title: "Codex is ready",
    body: "A session finished running and is waiting for instructions."
  });
}

export function isIdleAttention(event: AttentionEvent): boolean {
  return event.reason === "idle";
}

function isActiveStatus(status: string): boolean {
  return status === "active" || status.startsWith("active:");
}

function isIdleStatus(status: string): boolean {
  return status === "idle";
}

export function pendingApprovalFromRequest(request: {
  id: string | number;
  method: string;
  params?: unknown;
}): PendingApproval | null {
  const params = asRecord(request.params);
  if (!request.method.includes("requestApproval") && request.method !== "item/tool/requestUserInput") {
    return null;
  }

  if (request.method === "item/commandExecution/requestApproval") {
    return {
      codexRequestId: request.id,
      method: request.method,
      threadId: optionalString(params.threadId),
      turnId: optionalString(params.turnId),
      itemId: optionalString(params.itemId),
      title: "Approve command?",
      detail: optionalString(params.command) ?? optionalString(params.reason) ?? "Codex requested command approval.",
      params: params as PendingApproval["params"],
      suggestedAcceptResponse: { decision: "accept" },
      suggestedDeclineResponse: { decision: "decline" }
    };
  }

  if (request.method === "item/fileChange/requestApproval") {
    return {
      codexRequestId: request.id,
      method: request.method,
      threadId: optionalString(params.threadId),
      turnId: optionalString(params.turnId),
      itemId: optionalString(params.itemId),
      title: "Approve file change?",
      detail: optionalString(params.reason) ?? optionalString(params.grantRoot) ?? "Codex requested file change approval.",
      params: params as PendingApproval["params"],
      suggestedAcceptResponse: { decision: "accept" },
      suggestedDeclineResponse: { decision: "decline" }
    };
  }

  if (request.method === "item/permissions/requestApproval") {
    return {
      codexRequestId: request.id,
      method: request.method,
      threadId: optionalString(params.threadId),
      turnId: optionalString(params.turnId),
      itemId: optionalString(params.itemId),
      title: "Approve permissions?",
      detail: optionalString(params.reason) ?? "Codex requested additional permissions.",
      params: params as PendingApproval["params"],
      suggestedDeclineResponse: {
        permissions: { filesystem: "readOnly", network: "restricted" },
        scope: "oneTime"
      }
    };
  }

  if (request.method === "item/tool/requestUserInput") {
    return {
      codexRequestId: request.id,
      method: request.method,
      threadId: optionalString(params.threadId),
      turnId: optionalString(params.turnId),
      itemId: optionalString(params.itemId),
      title: "Codex has a question",
      detail: "A tool is waiting for your input.",
      params: params as PendingApproval["params"]
    };
  }

  return null;
}

export function attentionFromApproval(approval: PendingApproval): AttentionEvent {
  return createAttention({
    threadId: approval.threadId,
    reason: approval.method === "item/tool/requestUserInput" ? "user_input" : "approval",
    title: approval.title,
    body: approval.detail,
    pendingApproval: approval
  });
}

function snapshotTurn(turn: unknown): ThreadTurnSnapshot {
  const data = asRecord(turn);
  return {
    id: stringField(data, "id"),
    status: optionalString(data.status) ?? "unknown",
    startedAt: optionalNumber(data.startedAt),
    completedAt: optionalNumber(data.completedAt),
    items: Array.isArray(data.items) ? data.items.map(snapshotItem) : []
  };
}

function snapshotItem(item: unknown): ThreadItemSnapshot {
  const data = asRecord(item);
  const type = optionalString(data.type) ?? "unknown";
  const id = optionalString(data.id) ?? randomId("item");
  if (type === "userMessage") {
    return {
      id,
      type,
      text: extractUserMessageText(data)
    };
  }
  if (type === "agentMessage" || type === "plan") {
    return {
      id,
      type,
      text: optionalString(data.text) ?? ""
    };
  }
  if (type === "reasoning") {
    return {
      id,
      type,
      text: [...stringArray(data.summary), ...stringArray(data.content)].join("\n\n")
    };
  }
  if (type === "commandExecution") {
    return {
      id,
      type,
      command: optionalString(data.command) ?? "",
      output: optionalString(data.aggregatedOutput),
      status: optionalString(data.status)
    };
  }
  if (type === "fileChange") {
    return {
      id,
      type,
      text: "File changes",
      status: optionalString(data.status)
    };
  }
  return { id, type };
}

function extractUserMessageText(data: Record<string, unknown>): string {
  const content = Array.isArray(data.content) ? data.content : [];
  return content
    .map((part) => {
      const item = asRecord(part);
      if (item.type === "text") return optionalString(item.text) ?? "";
      if (item.type === "image") return "[image]";
      if (item.type === "localImage") return `[image: ${optionalString(item.path) ?? ""}]`;
      return `[${optionalString(item.type) ?? "item"}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function createAttention(input: {
  threadId?: string | undefined;
  reason: AttentionEvent["reason"];
  title: string;
  body: string;
  pendingApproval?: PendingApproval | undefined;
}): AttentionEvent {
  return {
    id: randomId("attention"),
    threadId: input.threadId,
    title: input.title,
    body: input.body,
    reason: input.reason,
    createdAt: new Date().toISOString(),
    ...(input.pendingApproval ? { pendingApproval: input.pendingApproval } : {})
  };
}

function sourceToText(source: unknown): string {
  if (typeof source === "string") return source;
  if (source && typeof source === "object" && "kind" in source) {
    return String((source as { kind: unknown }).kind);
  }
  if (source && typeof source === "object" && "type" in source) {
    return String((source as { type: unknown }).type);
  }
  return "unknown";
}

function activeFlagsFromStatus(status: unknown): string[] | undefined {
  const record = asRecord(status);
  const flags = record.type === "active" ? record.activeFlags : undefined;
  return Array.isArray(flags) ? flags.map(String) : undefined;
}

function stringField(data: Record<string, unknown>, key: string): string {
  const value = optionalString(data[key]);
  if (value === undefined) throw new Error(`Missing string field ${key}`);
  return value;
}

function numberField(data: Record<string, unknown>, key: string): number {
  const value = optionalNumber(data[key]);
  if (value === undefined) return 0;
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() || "Untitled session";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
