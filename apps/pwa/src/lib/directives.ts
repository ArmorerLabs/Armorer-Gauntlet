export interface CodexDirective {
  name: string;
  attrs: Record<string, string>;
}

const DIRECTIVE_LABELS: Record<string, string> = {
  archive: "Archive thread",
  "code-comment": "Code comment",
  "git-commit": "Git commit",
  "git-create-branch": "Git branch",
  "git-create-pr": "Pull request",
  "git-push": "Git push",
  "git-stage": "Git stage"
};

export function parseDirectiveLine(line: string): CodexDirective[] | null {
  const directives: CodexDirective[] = [];
  let index = 0;
  while (index < line.length) {
    index = skipWhitespace(line, index);
    if (index >= line.length) break;
    if (!line.startsWith("::", index)) return null;
    index += 2;

    const nameMatch = /^[A-Za-z][A-Za-z0-9_-]*/.exec(line.slice(index));
    if (!nameMatch) return null;
    const name = nameMatch[0];
    index += name.length;
    index = skipWhitespace(line, index);
    if (line[index] !== "{") return null;
    index += 1;

    const attrs: Record<string, string> = {};
    while (index < line.length) {
      index = skipWhitespace(line, index);
      if (line[index] === "}") {
        index += 1;
        directives.push({ name, attrs });
        break;
      }

      const keyMatch = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(line.slice(index));
      if (!keyMatch) return null;
      const key = keyMatch[0];
      index += key.length;
      index = skipWhitespace(line, index);
      if (line[index] !== "=") return null;
      index += 1;
      index = skipWhitespace(line, index);

      const quoted = readQuotedValue(line, index);
      if (!quoted) return null;
      attrs[key] = quoted.value;
      index = quoted.nextIndex;
    }

    if (!directives.length || directives.at(-1)?.name !== name) return null;
  }
  return directives.length ? directives : null;
}

export function renderDirectiveLine(line: string): string | null {
  const directives = parseDirectiveLine(line);
  if (!directives) return null;
  return `<div class="directive-stack">${directives.map(renderDirectiveCard).join("")}</div>`;
}

function renderDirectiveCard(directive: CodexDirective): string {
  const title = DIRECTIVE_LABELS[directive.name] ?? "Codex action";
  const primary = primaryAttrs(directive)
    .map(([key, value]) => renderAttr(key, value, key === "url"))
    .join("");
  const secondary = Object.entries(directive.attrs)
    .filter(([key]) => !new Set(primaryAttrs(directive).map(([primaryKey]) => primaryKey)).has(key))
    .map(([key, value]) => renderAttr(key, value, key === "url"))
    .join("");
  return [
    `<section class="directive-card" data-directive="${escapeAttribute(directive.name)}">`,
    `<span>${escapeHtml(title)}</span>`,
    primary ? `<dl>${primary}</dl>` : "",
    secondary ? `<details><summary>Details</summary><dl>${secondary}</dl></details>` : "",
    "</section>"
  ].join("");
}

function primaryAttrs(directive: CodexDirective): [string, string][] {
  const keysByDirective: Record<string, string[]> = {
    "git-stage": ["cwd"],
    "git-commit": ["cwd"],
    "git-push": ["branch", "cwd"],
    "git-create-branch": ["branch", "cwd"],
    "git-create-pr": ["url", "branch"],
    archive: ["reason"],
    "code-comment": ["title", "file", "start"]
  };
  const keys = keysByDirective[directive.name] ?? Object.keys(directive.attrs).slice(0, 3);
  return keys.flatMap((key) => (directive.attrs[key] ? [[key, directive.attrs[key]] as [string, string]] : []));
}

function renderAttr(key: string, value: string, link: boolean): string {
  const escapedKey = escapeHtml(labelForKey(key));
  const escapedValue = escapeHtml(value);
  const safeHref = value.startsWith("http://") || value.startsWith("https://") ? escapeAttribute(value) : "";
  return `<div><dt>${escapedKey}</dt><dd>${
    link && safeHref ? `<a href="${safeHref}" target="_blank" rel="noreferrer">${escapedValue}</a>` : escapedValue
  }</dd></div>`;
}

function labelForKey(key: string): string {
  return key.replaceAll("_", " ");
}

function readQuotedValue(line: string, index: number): { value: string; nextIndex: number } | null {
  const quote = line[index];
  if (quote !== '"' && quote !== "'") return null;
  let value = "";
  for (let cursor = index + 1; cursor < line.length; cursor += 1) {
    const char = line[cursor];
    if (char === "\\") {
      const next = line[cursor + 1];
      if (next === undefined) return null;
      value += next;
      cursor += 1;
      continue;
    }
    if (char === quote) return { value, nextIndex: cursor + 1 };
    value += char;
  }
  return null;
}

function skipWhitespace(line: string, index: number): number {
  let cursor = index;
  while (/\s/.test(line[cursor] ?? "")) cursor += 1;
  return cursor;
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
