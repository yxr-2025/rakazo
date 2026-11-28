import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { isolatedTestFiles } from "../vitest-project-paths.ts";

for (const [platform, paths] of [
  ["Windows", path.win32],
  ["POSIX", path.posix],
]) {
  test(`Vitest uses manifest and project paths for ${platform} glob results`, () => {
    const files = ["process.test.ts", "mocked.test.ts", "shared.test.ts"].map((name) =>
      paths.join("tests", name),
    );
    const isolated = isolatedTestFiles(
      files,
      ["tests/process.test.ts"],
      (file) => !file.endsWith("shared.test.ts"),
      paths.sep,
    );
    assert.deepEqual(isolated, ["tests/mocked.test.ts"]);
  });
}
