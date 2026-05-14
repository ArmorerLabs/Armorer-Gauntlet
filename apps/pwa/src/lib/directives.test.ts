import { describe, expect, it } from "vitest";
import { parseDirectiveLine, renderDirectiveLine } from "./directives.js";

describe("Codex directive parsing", () => {
  it("parses multiple known directives on one line", () => {
    expect(
      parseDirectiveLine(
        '::git-stage{cwd="/repo"} ::git-commit{cwd="/repo"} ::git-push{cwd="/repo" branch="main"}'
      )
    ).toEqual([
      { name: "git-stage", attrs: { cwd: "/repo" } },
      { name: "git-commit", attrs: { cwd: "/repo" } },
      { name: "git-push", attrs: { cwd: "/repo", branch: "main" } }
    ]);
  });

  it("parses unknown directives and escaped quoted attributes", () => {
    expect(parseDirectiveLine('::ship-it{title="say \\"hello\\"" path="/tmp/app"}')).toEqual([
      { name: "ship-it", attrs: { title: 'say "hello"', path: "/tmp/app" } }
    ]);
  });

  it("renders known and unknown directives as safe cards", () => {
    const known = renderDirectiveLine('::git-create-pr{url="https://github.com/ArmorerLabs/Armorer-Gauntlet/pull/1" branch="main"}');
    const unknown = renderDirectiveLine('::danger{body="<script>alert(1)</script>"}');

    expect(known).toContain("Pull request");
    expect(known).toContain("https://github.com/ArmorerLabs/Armorer-Gauntlet/pull/1");
    expect(unknown).toContain("Codex action");
    expect(unknown).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(unknown).not.toContain("<script>");
  });

  it("leaves malformed directives for normal escaped markdown rendering", () => {
    expect(parseDirectiveLine('::git-stage{cwd="/repo"')).toBeNull();
    expect(renderDirectiveLine('before ::git-stage{cwd="/repo"}')).toBeNull();
  });
});
