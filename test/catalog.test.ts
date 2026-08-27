import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CatalogRepository } from "../src/catalog.js";
import { capabilityEntrySchema } from "../src/schema.js";

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

test("proposal approval is hidden from pending results and appears only after reload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-approval-"));
  const catalogPath = path.join(root, "catalog.json");
  const stateDir = path.join(root, "state");
  await writeFile(catalogPath, JSON.stringify({ version: 1, entries: [] }), "utf8");
  const repository = new CatalogRepository(catalogPath, stateDir);
  await repository.load();

  const proposal = await repository.saveProposal({
    kind: "skill",
    name: "approved-skill",
    description: "Approved test skill",
    trusted: false,
    skill: { type: "file", path: "${catalogDir}/SKILL.md" },
  });
  assert.deepEqual((await repository.proposals()).map((item) => item.id), [proposal.id]);

  const approved = await repository.approve(proposal.id);
  assert.equal(approved.entry.trusted, true);
  assert.deepEqual(await repository.proposals(), []);
  assert.equal(repository.get("approved-skill"), undefined);

  await repository.load();
  assert.equal(repository.get("approved-skill")?.trusted, true);
});

test("approval and reload reject names that duplicate the base catalog without changing approved state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-duplicate-approval-"));
  const catalogPath = path.join(root, "catalog.json");
  const stateDir = path.join(root, "state");
  const baseEntry = {
    kind: "skill" as const,
    name: "base-skill",
    description: "Base skill",
    trusted: true,
    skill: { type: "file" as const, path: "unused.md" },
  };
  await writeFile(catalogPath, JSON.stringify({ version: 1, entries: [baseEntry] }), "utf8");
  const repository = new CatalogRepository(catalogPath, stateDir);
  await repository.load();
  const proposal = await repository.saveProposal({ ...baseEntry, trusted: false });
  const approvedPath = path.join(stateDir, "approved.json");

  await assert.rejects(repository.approve(proposal.id), /conflicts with the base or approved catalog/);
  await assert.rejects(readFile(approvedPath, "utf8"), { code: "ENOENT" });
  assert.deepEqual((await repository.proposals()).map((item) => item.id), [proposal.id]);

  await mkdir(stateDir, { recursive: true });
  await writeFile(approvedPath, JSON.stringify({ version: 1, entries: [baseEntry] }), "utf8");
  await assert.rejects(repository.load(), /Duplicate capability name: base-skill/);
  assert.deepEqual(repository.all().map((entry) => entry.name), ["base-skill"]);
});

test("a streamable-http transport must be encrypted unless it is loopback", () => {
  const entry = (url: string) => ({
    kind: "mcp" as const,
    name: "remote",
    description: "Test",
    trusted: true,
    transport: { type: "streamable-http" as const, url },
  });

  // z.url() alone accepted any scheme, so a catalog entry could name a local file or
  // send plain http to an internal host.
  for (const rejected of ["file:///c:/windows/win.ini", "http://internal.corp/mcp", "ftp://example.com/mcp"]) {
    assert.throws(() => capabilityEntrySchema.parse(entry(rejected)), /https/i, `${rejected} must be rejected`);
  }
  for (const accepted of ["https://api.example.com/mcp", "http://127.0.0.1:8931/mcp", "http://localhost:8931/mcp"]) {
    assert.doesNotThrow(() => capabilityEntrySchema.parse(entry(accepted)), `${accepted} must be accepted`);
  }
});
