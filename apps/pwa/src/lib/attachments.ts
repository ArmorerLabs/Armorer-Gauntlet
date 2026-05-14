import { bytesToBase64Url, randomId, type TurnAttachment, type TurnAttachmentSummary } from "@armorer/gauntlet-shared";

export const MAX_ATTACHMENTS_PER_TURN = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 200 * 1024;

const TEXT_MIME_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "image/svg+xml"
]);
const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".log",
  ".md",
  ".mjs",
  ".py",
  ".rs",
  ".sh",
  ".svelte",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml"
]);

export async function fileToTurnAttachment(file: File): Promise<TurnAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is too large. Attach files up to 5 MB.`);
  }
  if (file.type.startsWith("image/")) {
    return {
      id: randomId("att"),
      name: file.name || "image",
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      kind: "image",
      encoding: "base64",
      data: bytesToBase64Url(new Uint8Array(await file.arrayBuffer()))
    };
  }
  if (!isTextLikeFile(file)) {
    throw new Error(`${file.name} is not supported yet. Attach images or UTF-8 text/code files.`);
  }
  if (file.size > MAX_TEXT_ATTACHMENT_BYTES) {
    throw new Error(`${file.name} is too large for text upload. Text/code files can be up to 200 KB.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${file.name} is not valid UTF-8 text.`);
  }

  return {
    id: randomId("att"),
    name: file.name || "attachment.txt",
    mimeType: file.type || "text/plain",
    size: file.size,
    kind: "text",
    encoding: "utf8",
    data: text
  };
}

export function summarizeAttachment(attachment: TurnAttachment): TurnAttachmentSummary {
  return {
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind
  };
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / (1024 * 102.4)) / 10} MB`;
}

export function isTextLikeFile(file: File): boolean {
  const mimeType = file.type.toLowerCase();
  if (mimeType.startsWith("text/") || TEXT_MIME_TYPES.has(mimeType)) return true;
  const lowerName = file.name.toLowerCase();
  return [...TEXT_EXTENSIONS].some((extension) => lowerName.endsWith(extension));
}
