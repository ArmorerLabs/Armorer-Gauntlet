import { describe, expect, it } from "vitest";
import { MAX_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENT_BYTES, fileToTurnAttachment, isTextLikeFile } from "./attachments.js";

describe("mobile attachments", () => {
  it("accepts images as base64 attachments", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "screen.png", { type: "image/png" });

    await expect(fileToTurnAttachment(file)).resolves.toMatchObject({
      name: "screen.png",
      mimeType: "image/png",
      size: 3,
      kind: "image",
      encoding: "base64",
      data: "AQID"
    });
  });

  it("accepts UTF-8 text and code files inline", async () => {
    const file = new File(["const ok = true;\n"], "snippet.ts", { type: "" });

    await expect(fileToTurnAttachment(file)).resolves.toMatchObject({
      name: "snippet.ts",
      mimeType: "text/plain",
      kind: "text",
      encoding: "utf8",
      data: "const ok = true;\n"
    });
  });

  it("rejects oversized, unsupported, and invalid UTF-8 files", async () => {
    await expect(
      fileToTurnAttachment(new File([new Uint8Array(MAX_ATTACHMENT_BYTES + 1)], "huge.png", { type: "image/png" }))
    ).rejects.toThrow("up to 5 MB");
    await expect(
      fileToTurnAttachment(new File([new Uint8Array(MAX_TEXT_ATTACHMENT_BYTES + 1)], "huge.txt", { type: "text/plain" }))
    ).rejects.toThrow("up to 200 KB");
    await expect(fileToTurnAttachment(new File([new Uint8Array([0])], "archive.zip", { type: "application/zip" }))).rejects.toThrow(
      "not supported"
    );
    await expect(fileToTurnAttachment(new File([new Uint8Array([0xff])], "bad.txt", { type: "text/plain" }))).rejects.toThrow(
      "valid UTF-8"
    );
  });

  it("recognizes common text-like files", () => {
    expect(isTextLikeFile(new File([""], ".env", { type: "" }))).toBe(true);
    expect(isTextLikeFile(new File([""], "data.json", { type: "application/json" }))).toBe(true);
    expect(isTextLikeFile(new File([""], "bundle.bin", { type: "application/octet-stream" }))).toBe(false);
  });
});
