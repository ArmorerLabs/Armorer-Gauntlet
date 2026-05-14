import { basename } from "node:path";
import {
  type AttentionEvent,
  type CodexEvent,
  type CodexThreadSnapshot,
  type PendingApproval,
  type SessionSummary,
  type ThreadItemSnapshot,
  type ThreadTurnSnapshot,
  type TurnAttachmentSummary,
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
    const content = extractUserMessageContent(data);
    return {
      id,
      type,
      text: content.text,
      ...(content.attachments.length ? { attachments: content.attachments } : {})
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
  if (type === "hookPrompt") {
    return {
      id,
      type,
      text: arrayRecords(data.fragments)
        .map((fragment) => optionalString(fragment.text) ?? "")
        .filter(Boolean)
        .join("\n")
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
    const changes = arrayRecords(data.changes);
    const diff = changes
      .map((change) => optionalString(change.diff) ?? "")
      .filter(Boolean)
      .join("\n\n");
    return {
      id,
      type,
      text: fileChangeSummary(changes),
      ...(diff ? { diff } : {}),
      status: optionalString(data.status)
    };
  }
  if (type === "mcpToolCall") {
    return {
      id,
      type,
      text: [`${optionalString(data.server) ?? "MCP"}.${optionalString(data.tool) ?? "tool"}`, statusLine(data.status)]
        .filter(Boolean)
        .join("\n"),
      output: [formatJson(data.result), errorMessage(data.error)].filter(Boolean).join("\n\n") || undefined,
      status: optionalString(data.status)
    };
  }
  if (type === "dynamicToolCall") {
    const content = dynamicContentText(data.contentItems);
    return {
      id,
      type,
      text: [`Tool: ${optionalString(data.tool) ?? "unknown"}`, statusLine(data.status), ...content]
        .filter(Boolean)
        .join("\n"),
      output: formatJson(data.arguments),
      status: optionalString(data.status)
    };
  }
  if (type === "collabAgentToolCall") {
    return {
      id,
      type,
      text: [
        `Agent tool: ${optionalString(data.tool) ?? "unknown"}`,
        statusLine(data.status),
        optionalString(data.prompt)
      ]
        .filter(Boolean)
        .join("\n"),
      output: formatJson(data.agentsStates),
      status: optionalString(data.status)
    };
  }
  if (type === "webSearch") {
    return {
      id,
      type,
      text: [`Search: ${optionalString(data.query) ?? ""}`, formatJson(data.action)].filter(Boolean).join("\n")
    };
  }
  if (type === "imageView") {
    const path = optionalString(data.path) ?? "";
    return {
      id,
      type,
      text: path ? `Image: ${path}` : "Image",
      attachments: path
        ? [
            {
              id: randomId("att"),
              name: basename(path),
              mimeType: "image/*",
              size: 0,
              kind: "image"
            }
          ]
        : undefined
    };
  }
  if (type === "imageGeneration") {
    return {
      id,
      type,
      text: [
        `Image generation: ${optionalString(data.status) ?? "unknown"}`,
        optionalString(data.revisedPrompt),
        optionalString(data.savedPath) ? `Saved: ${optionalString(data.savedPath)}` : "",
        optionalString(data.result)
      ]
        .filter(Boolean)
        .join("\n"),
      status: optionalString(data.status)
    };
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    return {
      id,
      type,
      text: optionalString(data.review) ?? ""
    };
  }
  if (type === "contextCompaction") {
    return {
      id,
      type,
      text: "Context compacted."
    };
  }
  return { id, type };
}

function fileChangeSummary(changes: Array<Record<string, unknown>>): string {
  if (!changes.length) return "File changes";
  return changes
    .map((change) => {
      const path = optionalString(change.path) ?? "file";
      const kind = asRecord(change.kind);
      const type = optionalString(kind.type) ?? "update";
      const moved = optionalString(kind.move_path);
      return moved ? `${type}: ${moved} -> ${path}` : `${type}: ${path}`;
    })
    .join("\n");
}

function dynamicContentText(value: unknown): string[] {
  return arrayRecords(value)
    .map((item) => {
      if (item.type === "inputText") return optionalString(item.text) ?? "";
      if (item.type === "inputImage") return `[image: ${optionalString(item.imageUrl) ?? ""}]`;
      return `[${optionalString(item.type) ?? "content"}]`;
    })
    .filter(Boolean);
}

function statusLine(value: unknown): string {
  const status = optionalString(value);
  return status ? `Status: ${status}` : "";
}

function errorMessage(value: unknown): string | undefined {
  const message = optionalString(asRecord(value).message);
  return message ? `Error: ${message}` : undefined;
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

function extractUserMessageContent(data: Record<string, unknown>): {
  text: string;
  attachments: TurnAttachmentSummary[];
} {
  const content = Array.isArray(data.content) ? data.content : [];
  const attachments: TurnAttachmentSummary[] = [];
  const text = content
    .map((part) => {
      const item = asRecord(part);
      if (item.type === "text") return optionalString(item.text) ?? "";
      if (item.type === "image" || item.type === "localImage") {
        const path = optionalString(item.path) ?? optionalString(item.url) ?? "";
        attachments.push({
          id: optionalString(item.id) ?? randomId("att"),
          name: path ? basename(path) : "image",
          mimeType: optionalString(item.mimeType) ?? "image/*",
          size: optionalNumber(item.size) ?? 0,
          kind: "image"
        });
        return "";
      }
      return `[${optionalString(item.type) ?? "item"}]`;
    })
    .filter(Boolean)
    .join("\n");
  return { text, attachments };
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

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function firstLine(value: string): string {
  return value.split(/\r?\n/)[0]?.trim() || "Untitled session";
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
