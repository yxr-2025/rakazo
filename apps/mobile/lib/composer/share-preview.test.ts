import { describe, expect, it } from "vitest";
import type { IncomingShare } from "./incoming-share";
import { sharePreview } from "./share-preview";

const base: IncomingShare = { text: "", files: [], arrivedAt: 0, generation: 1 };
describe("share preview", () => {
  it.each(["A short note", "https://example.com/article"])("keeps text and links: %s", (text) => {
    expect(sharePreview({ ...base, text })).toEqual({
      text,
      images: [],
      extraImages: 0,
      fileCount: 0,
      fileName: null,
    });
  });
  it("shows thumbnails for local photos without a specific MIME type", () => {
    const camera = { uri: "content://photos/1", name: "camera.jpg", mimeType: null };
    const screenshot = {
      uri: "file:///shared/2",
      name: "screenshot.PNG",
      mimeType: "application/octet-stream",
    };
    const document = {
      uri: "content://docs/3",
      name: "notes.pdf",
      mimeType: "application/octet-stream",
    };
    expect(sharePreview({ ...base, files: [camera, document, screenshot] })).toEqual({
      text: "",
      images: [camera, screenshot],
      extraImages: 0,
      fileCount: 1,
      fileName: "notes.pdf",
    });
  });
  it("does not infer thumbnails for a declared document, non-image extension, or remote URI", () => {
    const preview = sharePreview({
      ...base,
      files: [
        { uri: "content://docs/1", name: "not-a-photo.png", mimeType: "application/pdf" },
        { uri: "content://docs/2", name: "photo.jpg.zip", mimeType: null },
        { uri: "https://example.com/photo.jpg", name: "photo.jpg", mimeType: null },
      ],
    });
    expect(preview.images).toEqual([]);
    expect(preview.fileCount).toBe(3);
    expect(preview.fileName).toBeNull();
  });
  it("limits thumbnails and counts the remaining images separately from files", () => {
    const images = Array.from({ length: 6 }, (_, index) => ({
      uri: `content://photos/${index}`,
      name: index === 0 ? "no-extension" : `${index}.png`,
      mimeType: index % 2 === 0 ? "image/png" : null,
    }));
    const preview = sharePreview({
      ...base,
      files: [
        ...images,
        { uri: "content://docs/1", name: "notes.pdf", mimeType: "application/pdf" },
      ],
    });
    expect(preview.images).toEqual(images.slice(0, 4));
    expect(preview.extraImages).toBe(2);
    expect(preview.fileName).toBe("notes.pdf");
    expect(preview.fileCount).toBe(1);
  });
  it("uses a count for multiple other files", () => {
    const preview = sharePreview({
      ...base,
      files: Array.from({ length: 3 }, (_, i) => ({
        uri: `content://docs/${i}`,
        name: "file",
        mimeType: null,
      })),
    });
    expect(preview.fileCount).toBe(3);
    expect(preview.fileName).toBeNull();
  });
});
