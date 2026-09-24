import { describe, expect, it } from "vitest";
import { fileToImagePart } from "../web/image";

describe("fileToImagePart", () => {
  it("converts an image blob into a base64 ACP image part", async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const file = new Blob([bytes], { type: "image/jpeg" });
    const part = await fileToImagePart(file);
    expect(part.type).toBe("image");
    expect(part.mimeType).toBe("image/jpeg");
    expect(part.data).toBe(btoa(String.fromCharCode(...bytes)));
  });

  it("falls back to image/png when the blob has no type", async () => {
    const file = new Blob([new Uint8Array([1, 2, 3])]);
    const part = await fileToImagePart(file);
    expect(part.mimeType).toBe("image/png");
  });

  it("rejects non-image files", async () => {
    const file = new Blob(["not an image"], { type: "text/plain" });
    await expect(fileToImagePart(file)).rejects.toThrow("Only image files");
  });

  it("rejects images larger than 4 MB", async () => {
    const file = new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "image/png" });
    await expect(fileToImagePart(file)).rejects.toThrow("larger than 4 MB");
  });
});
