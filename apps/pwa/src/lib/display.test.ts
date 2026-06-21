import { describe, expect, it } from "vitest";
import { agentKind, agentLabel, isWorking, statusLabel } from "./display.js";

describe("display helpers", () => {
  it("labels active session states as working", () => {
    expect(isWorking("active")).toBe(true);
    expect(isWorking("running")).toBe(true);
    expect(isWorking("starting")).toBe(true);
    expect(isWorking("queued")).toBe(true);
    expect(statusLabel("active")).toBe("Working");
  });

  it("keeps blocked or terminal states out of working", () => {
    expect(isWorking("active:waitingOnApproval")).toBe(false);
    expect(isWorking("active:waitingOnUserInput")).toBe(false);
    expect(isWorking("failed")).toBe(false);
    expect(isWorking("completed")).toBe(false);
  });

  it("labels supported agents", () => {
    expect(agentKind(undefined)).toBe("codex");
    expect(agentLabel({ agent: "codex" })).toBe("Codex");
    expect(agentLabel({ agent: "pi" })).toBe("Pi");
    expect(agentLabel({ agent: "claude" })).toBe("Claude");
  });
});
