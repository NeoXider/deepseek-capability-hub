import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CatalogRepository } from "../src/catalog.js";
import { CapabilityHub } from "../src/manager.js";

function firstText(result: Awaited<ReturnType<CapabilityHub["execute"]>>): string {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return block.type === "text" ? block.text : "";
}

test("hub lazily loads a skill and proxies a child MCP call", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-manager-"));
  const skillPath = path.join(root, "SKILL.md");
  await writeFile(skillPath, "Always report measured evidence.", "utf8");
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/fixture-echo.js");
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "mcp",
          name: "echo-test",
          description: "Test server",
          trusted: true,
          transport: { type: "stdio", command: process.execPath, args: [fixturePath] },
          configurable: [],
        },
        {
          kind: "skill",
          name: "evidence-skill",
          description: "Evidence instructions",
          trusted: true,
          skill: { type: "file", path: skillPath },
        },
      ],
    }),
    "utf8",
  );

  const repository = new CatalogRepository(catalogPath, path.join(root, "state"));
  await repository.load();
  const hub = new CapabilityHub(repository);
  const signal = new AbortController().signal;
  try {
    const statusBefore = JSON.parse(firstText(await hub.execute({ action: "status" }, signal)));
    assert.deepEqual(statusBefore.enabled, []);

    const skill = await hub.execute({ action: "skill.load", name: "evidence-skill" }, signal);
    assert.match(firstText(skill), /measured evidence/);

    const enabled = await hub.execute({ action: "enable", name: "echo-test" }, signal);
    assert.match(firstText(enabled), /echo/);

    const called = await hub.execute(
      { action: "call", name: "echo-test", tool: "echo", arguments: { text: "lazy-ok" } },
      signal,
    );
    assert.equal(firstText(called), "lazy-ok");

    const tools = JSON.parse(
      firstText(await hub.execute({ action: "tools", name: "echo-test", includeSchema: false }, signal)),
    );
    assert.deepEqual(
      tools.tools.map((tool: { name: string }) => tool.name).sort(),
      ["add", "echo"],
    );
    assert.equal(tools.schemasIncluded, false);
  } finally {
    await hub.close();
  }
});

test("untrusted capabilities cannot execute", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-untrusted-"));
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "mcp",
          name: "untrusted-server",
          description: "Must not run",
          trusted: false,
          transport: { type: "stdio", command: process.execPath, args: ["missing.js"] },
        },
      ],
    }),
    "utf8",
  );
  const repository = new CatalogRepository(catalogPath, path.join(root, "state"));
  await repository.load();
  const hub = new CapabilityHub(repository);
  await assert.rejects(hub.enable("untrusted-server"), /untrusted/);
});
