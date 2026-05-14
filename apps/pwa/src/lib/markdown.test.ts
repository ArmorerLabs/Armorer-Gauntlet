import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown.js";

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
});
