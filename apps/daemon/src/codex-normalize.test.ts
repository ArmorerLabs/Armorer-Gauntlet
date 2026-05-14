import { describe, expect, it } from "vitest";
import {
  attentionFromEvent,
  attentionFromStatusTransition,
  normalizeNotification,
  pendingApprovalFromRequest,
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
});
