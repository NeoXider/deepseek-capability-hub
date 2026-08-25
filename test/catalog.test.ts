import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogRepository } from "../src/catalog.js";

test("catalog rejects duplicate capability names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-catalog-"));
  const catalogPath = path.join(root, "catalog.json");
  const entry = {
    kind: "skill",
    name: "duplicate-skill",
    description: "Duplicate test skill",
    trusted: true,
    skill: { type: "file", path: "unused.md" },
  };
  await writeFile(catalogPath, JSON.stringify({ version: 1, entries: [entry, entry] }), "utf8");
  const repository = new CatalogRepository(catalogPath, path.join(root, "state"));
  await assert.rejects(repository.load(), /Duplicate capability name/);
});

test("catalog search is compact and tag-aware", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-search-"));
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "skill",
          name: "experiment-review",
          description: "Review experiments",
          tags: ["ml", "evidence"],
          trusted: true,
          skill: { type: "file", path: "unused.md" },
        },
      ],
    }),
    "utf8",
  );
  const repository = new CatalogRepository(catalogPath, path.join(root, "state"));
  await repository.load();
  assert.equal(repository.search("ml evidence")[0]?.name, "experiment-review");
  assert.equal(repository.search("unity").length, 0);
});
