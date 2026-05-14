import { describe, expect, it } from "vitest";
import { renderMarkdown, renderPlainTextWithDirectives } from "./markdown.js";

describe("markdown rendering", () => {
  it("renders common Codex response markdown", () => {
    expect(
      renderMarkdown(
        [
          "### Done",
          "",
          "This is **bold** and `inline code`.",
          "",
          "- one",
          "- two",
          "",
          "```ts",
          "const ok = true;",
          "```"
        ].join("\n")
      )
    ).toContain("<h3>Done</h3>");
    expect(renderMarkdown("This is **bold** and `inline code`.")).toContain("<strong>bold</strong>");
    expect(renderMarkdown("- one\n- two")).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(renderMarkdown("```ts\nconst ok = true;\n```")).toContain('<code class="language-ts">const ok = true;</code>');
  });

  it("escapes html before rendering markdown", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **safe** [link](javascript:alert(1))');

    expect(html).toContain("&lt;img");
    expect(html).toContain("<strong>safe</strong>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=");
  });

  it("allows http links with safe attributes", () => {
    expect(renderMarkdown("[OpenAI](https://openai.com)")).toContain(
      '<a href="https://openai.com" target="_blank" rel="noreferrer">OpenAI</a>'
    );
  });

  it("renders Codex directives as action cards", () => {
    const html = renderMarkdown('::git-stage{cwd="/repo"} ::git-push{cwd="/repo" branch="main"}');

    expect(html).toContain("directive-card");
    expect(html).toContain("Git stage");
    expect(html).toContain("Git push");
    expect(html).not.toContain("::git-stage");
  });

  it("escapes malformed Codex directives as text", () => {
    const html = renderMarkdown('::git-stage{cwd="<script>"} broken');

    expect(html).toContain("::git-stage");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders user text plainly while still turning directive-only lines into cards", () => {
    const html = renderPlainTextWithDirectives(
      ['MOBILE_PLAYWRIGHT_SEND_OK **not bold**', '::git-stage{cwd="/repo"}'].join("\n")
    );

    expect(html).toContain("MOBILE_PLAYWRIGHT_SEND_OK **not bold**");
    expect(html).toContain("Git stage");
    expect(html).not.toContain("<em>PLAYWRIGHT</em>");
    expect(html).not.toContain("<strong>not bold</strong>");
  });
});
