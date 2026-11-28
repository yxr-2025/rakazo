import path from "node:path";

export function isolatedTestFiles(
  files: string[],
  processFiles: string[],
  needsIsolation: (file: string) => boolean,
  separator = path.sep,
): string[] {
  // The process manifest and Vitest's include/exclude patterns use forward slashes.
  return files
    .map((file) => file.replaceAll(separator, "/"))
    .filter((file) => !processFiles.includes(file) && needsIsolation(file));
}
