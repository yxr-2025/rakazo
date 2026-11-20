import { inferAttachmentMimeType } from "@rakazo/core";
import type { IncomingShare } from "./incoming-share";

function isPreviewImage({ mimeType, name, uri }: IncomingShare["files"][number]): boolean {
  if (mimeType?.startsWith("image/")) return true;
  if (mimeType && mimeType !== "application/octet-stream") return false;
  // Only infer from names for local files handed over by the share sheet.
  if (!uri.startsWith("file:///") && !uri.startsWith("content://")) return false;
  return inferAttachmentMimeType(name)?.startsWith("image/") ?? false;
}

/** Preview source URIs directly: choosing a target must not copy or read entire files. */
export function sharePreview(share: IncomingShare) {
  const images: IncomingShare["files"] = [];
  const files: IncomingShare["files"] = [];
  for (const file of share.files) {
    (isPreviewImage(file) ? images : files).push(file);
  }
  return {
    text: share.text,
    images: images.slice(0, 4),
    extraImages: Math.max(0, images.length - 4),
    fileCount: files.length,
    fileName: files.length === 1 ? (files[0]?.name ?? null) : null,
  };
}
