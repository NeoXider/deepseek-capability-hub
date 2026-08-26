import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("package allowlist excludes runtime state and compiled tests", async () => {
  const compiledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageRoot = path.resolve(compiledRoot, "..");
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")) as {
    files?: string[];
  };

  assert.deepEqual(manifest.files, [
    "dist/src",
    "data/catalog.json",
    "data/skills",
    "examples",
    "README.md",
    "LICENSE",
  ]);
});
