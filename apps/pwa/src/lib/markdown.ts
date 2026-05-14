const INLINE_CODE_PLACEHOLDER = "\u0000CODE";

export function renderMarkdown(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  let quote: string[] = [];
  let codeFence: { lang: string; lines: string[] } | undefined;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const tag = list.ordered ? "ol" : "ul";
    blocks.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
    list = undefined;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    blocks.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
    quote = [];
  };
  const flushOpenBlocks = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const fence = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      if (codeFence) {
        const langClass = codeFence.lang ? ` class="language-${escapeAttribute(codeFence.lang)}"` : "";
        blocks.push(`<pre><code${langClass}>${escapeHtml(codeFence.lines.join("\n"))}</code></pre>`);
        codeFence = undefined;
      } else {
        flushOpenBlocks();
        codeFence = { lang: fence[1] ?? "", lines: [] };
      }
      continue;
    }

    if (codeFence) {
      codeFence.lines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushOpenBlocks();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushOpenBlocks();
      const level = heading[1]?.length ?? 1;
      blocks.push(`<h${level}>${renderInline(heading[2] ?? "")}</h${level}>`);
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(line.trim())) {
      flushOpenBlocks();
      blocks.push("<hr>");
      continue;
    }

    const quoteLine = line.match(/^>\s?(.*)$/);
    if (quoteLine) {
      flushParagraph();
      flushList();
      quote.push(quoteLine[1] ?? "");
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      flushQuote();
      const orderedList = Boolean(ordered);
      if (list && list.ordered !== orderedList) flushList();
      list ??= { ordered: orderedList, items: [] };
      list.items.push((unordered?.[1] ?? ordered?.[1] ?? "").trim());
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  if (codeFence) {
    const langClass = codeFence.lang ? ` class="language-${escapeAttribute(codeFence.lang)}"` : "";
    blocks.push(`<pre><code${langClass}>${escapeHtml(codeFence.lines.join("\n"))}</code></pre>`);
  }
  flushOpenBlocks();

  return blocks.join("");
}

function renderInline(markdown: string): string {
  const codeSegments: string[] = [];
  let html = escapeHtml(markdown).replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = codeSegments.push(`<code>${code}</code>`) - 1;
    return `${INLINE_CODE_PLACEHOLDER}${index}\u0000`;
  });

  html = html
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, href: string) => {
      return `<a href="${escapeAttribute(href)}" target="_blank" rel="noreferrer">${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\s][^*]*?)\*/g, "<em>$1</em>")
    .replace(/_([^_\s][^_]*?)_/g, "<em>$1</em>");

  return html.replace(new RegExp(`${INLINE_CODE_PLACEHOLDER}(\\d+)\\u0000`, "g"), (_match, index: string) => {
    return codeSegments[Number(index)] ?? "";
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/[\u0000-\u001f\u007f]/g, "");
}
