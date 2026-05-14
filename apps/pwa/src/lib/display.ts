import type { CodexThreadSnapshot, SessionSummary } from "@armorer/gauntlet-shared";

type SessionLike = Pick<SessionSummary | CodexThreadSnapshot, "name" | "preview" | "cwd" | "status" | "updatedAt">;

export function displayTitle(session: SessionLike | undefined): string {
  if (!session) return "Session";
  return clean(session.name) || firstLine(session.preview) || workspaceName(session.cwd) || "Untitled session";
}

export function displaySubtitle(session: SessionLike | undefined): string {
  if (!session) return "";
  const repo = workspaceName(session.cwd);
  const path = truncateMiddle(session.cwd, 38);
  return [repo, path].filter(Boolean).join(" · ");
}

export function compactPath(path: string | undefined, maxLength = 34): string {
  return truncateMiddle(path ?? "", maxLength);
}

export function workspaceName(path: string | undefined): string {
  const cleaned = clean(path);
  if (!cleaned) return "";
  return cleaned.split("/").filter(Boolean).at(-1) ?? cleaned;
}

export function statusLabel(status: string | undefined): string {
  const value = (status ?? "").toLowerCase();
  if (value.includes("completed")) return "Done";
  if (value.includes("approval")) return "Approval";
  if (value.includes("input")) return "Input";
  if (value.includes("active") || value.includes("running")) return "Running";
  if (value.includes("interrupted")) return "Stopped";
  if (value.includes("failed")) return "Failed";
  if (!value || value === "unknown") return "Idle";
  return titleCase(value.split(":")[0] ?? value);
}

export function isCompleted(status: string | undefined): boolean {
  return (status ?? "").toLowerCase().includes("completed");
}

export function needsAttention(status: string | undefined): boolean {
  const value = (status ?? "").toLowerCase();
  return value.includes("approval") || value.includes("input") || value.includes("failed");
}

export function relativeTime(seconds: number | undefined): string {
  if (!seconds) return "";
  const delta = Math.max(0, Date.now() / 1000 - seconds);
  if (delta < 60) return "now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

function firstLine(text: string | undefined): string {
  return clean(text).split(/\r?\n/).find(Boolean) ?? "";
}

function truncateMiddle(text: string | undefined, maxLength: number): string {
  const value = clean(text);
  if (value.length <= maxLength) return value;
  const headLength = Math.max(8, Math.floor(maxLength * 0.45));
  const tailLength = Math.max(8, maxLength - headLength - 1);
  return `${value.slice(0, headLength)}...${value.slice(-tailLength)}`;
}

function titleCase(text: string): string {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function clean(text: string | undefined): string {
  return (text ?? "").trim();
}
