import { describe, expect, it } from "vitest";
import {
  attentionFromEvent,
  attentionFromStatusTransition,
  normalizeNotification,
  pendingApprovalFromRequest,
  snapshotThread,
  summarizeThread
} from "./codex-normalize.js";

describe("codex normalization", () => {
  it("summarizes Codex threads for mobile", () => {
    expect(
      summarizeThread({
        id: "abc",
        name: null,
        preview: "Fix the build\nplease",
        cwd: "/repo",
        updatedAt: 10,
        createdAt: 1,
        status: { type: "idle" },
        modelProvider: "openai",
        source: { kind: "cli" }
      })
    ).toMatchObject({
      id: "abc",
      name: "Fix the build",
      status: "idle",
      resumeCommand: "codex resume abc"
    });
  });

  it("classifies waiting-on-approval status as attention", () => {
    const event = normalizeNotification({
      method: "thread/status/changed",
      params: {
        threadId: "t1",
        status: {
          type: "active",
          activeFlags: ["waitingOnApproval"]
        }
      }
    });

    expect(event).toMatchObject({ type: "thread.status", threadId: "t1" });
    expect(event && attentionFromEvent(event)).toMatchObject({
      reason: "approval",
      title: "Codex needs approval"
    });
  });

  it("builds command approval response suggestions", () => {
    expect(
      pendingApprovalFromRequest({
        id: 4,
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: "t1",
          turnId: "u1",
          itemId: "i1",
          command: "npm test"
        }
      })
    ).toMatchObject({
      codexRequestId: 4,
      title: "Approve command?",
      suggestedAcceptResponse: { decision: "accept" },
      suggestedDeclineResponse: { decision: "decline" }
    });
  });

  it("creates ready attention when a thread transitions from active to idle", () => {
    const event = normalizeNotification({
      method: "thread/status/changed",
      params: {
        threadId: "t1",
        status: { type: "idle" }
      }
    });

    expect(event && attentionFromStatusTransition(event, "active")).toMatchObject({
      reason: "idle",
      title: "Codex is ready",
      body: "A session finished running and is waiting for instructions."
    });
  });

  it("does not create ready attention for initial idle status", () => {
    const event = normalizeNotification({
      method: "thread/status/changed",
      params: {
        threadId: "t1",
        status: { type: "idle" }
      }
    });

    expect(event && attentionFromStatusTransition(event, undefined)).toBeNull();
  });

  it("normalizes the broader Codex structured item set for mobile", () => {
    const thread = snapshotThread({
      id: "abc",
      cwd: "/repo",
      updatedAt: 1,
      createdAt: 1,
      status: "idle",
      turns: [
        {
          id: "turn-1",
          status: "completed",
          items: [
            { type: "hookPrompt", id: "hook", fragments: [{ text: "Hook says hi", hookRunId: "run-1" }] },
            {
              type: "fileChange",
              id: "files",
              status: "completed",
              changes: [{ path: "src/app.ts", kind: { type: "update", move_path: null }, diff: "@@ diff" }]
            },
            {
              type: "mcpToolCall",
              id: "mcp",
              server: "github",
              tool: "create_issue",
              status: "completed",
              arguments: {},
              result: { content: ["ok"], structuredContent: null, _meta: null },
              error: null
            },
            {
              type: "dynamicToolCall",
              id: "tool",
              tool: "browser",
              status: "completed",
              arguments: { url: "https://example.com" },
              contentItems: [{ type: "inputText", text: "Loaded page" }],
              success: true
            },
            { type: "webSearch", id: "search", query: "armorer", action: null },
            { type: "imageView", id: "image", path: "/tmp/screen.png" },
            {
              type: "imageGeneration",
              id: "generated",
              status: "completed",
              revisedPrompt: "A clean app icon",
              result: "ok",
              savedPath: "/tmp/icon.png"
            },
            { type: "contextCompaction", id: "compact" }
          ]
        }
      ]
    });

    const items = thread.turns[0]?.items ?? [];
    expect(items.map((item) => item.type)).toEqual([
      "hookPrompt",
      "fileChange",
      "mcpToolCall",
      "dynamicToolCall",
      "webSearch",
      "imageView",
      "imageGeneration",
      "contextCompaction"
    ]);
    expect(items.find((item) => item.type === "fileChange")).toMatchObject({
      text: "update: src/app.ts",
      diff: "@@ diff"
    });
    expect(items.find((item) => item.type === "mcpToolCall")?.text).toContain("github.create_issue");
    expect(items.find((item) => item.type === "dynamicToolCall")?.text).toContain("Loaded page");
    expect(items.find((item) => item.type === "imageView")?.attachments?.[0]).toMatchObject({
      name: "screen.png",
      kind: "image"
    });
  });
});
