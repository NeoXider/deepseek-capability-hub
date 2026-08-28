import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("outer MCP exposes exactly one tool and proxies through it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-e2e-"));
  const compiledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const serverPath = path.join(compiledRoot, "src", "server.js");
  const fixturePath = path.join(compiledRoot, "src", "fixture-echo.js");
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "mcp",
          name: "wire-echo",
          description: "Wire-level echo test",
          trusted: true,
          transport: { type: "stdio", command: process.execPath, args: [fixturePath] },
        },
      ],
    }),
    "utf8",
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath, "--catalog", catalogPath, "--state", path.join(root, "state")],
    stderr: "pipe",
  });
  const client = new Client({ name: "capability-hub-e2e", version: "0.1.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["capability_hub"]);
    const publicSchema = JSON.stringify(listed.tools[0]?.inputSchema);
    assert.doesNotMatch(publicSchema, /\"\$ref\"|\"definitions\"|\"anyOf\"|\"oneOf\"|\"pattern\"/);

    const searched = await client.callTool({
      name: "capability_hub",
      arguments: { action: "search", query: "echo" },
    });
    assert.match(JSON.stringify(searched), /wire-echo/);

    const called = await client.callTool({
      name: "capability_hub",
      arguments: {
        action: "call",
        name: "wire-echo",
        tool: "echo",
        payloadJson: JSON.stringify({ text: "wire-ok" }),
      },
    });
    assert.match(JSON.stringify(called), /wire-ok/);
  } finally {
    await client.close();
  }
});

// The capability list lives inside the resident tool description because
// bench/accuracy.mjs measured it worth ~200 tokens: 92.9% -> 96.4% accuracy and
// 3.61 -> 2.18 average turns on the same 28 tasks. That makes the description a
// load-bearing surface, not cosmetic prose, so it is asserted here.
//
// It also makes the resident cost grow with the catalog, which is the thing this
// project exists to prevent. The degradation to names-only is what bounds it, and a
// regression there would be invisible until someone re-ran the benchmark.
test("resident description carries the catalog and degrades before it can bloat", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-describe-"));
  const compiledRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const serverPath = path.join(compiledRoot, "src", "server.js");
  const fixturePath = path.join(compiledRoot, "src", "fixture-echo.js");

  const entry = (index: number) => ({
    kind: "mcp" as const,
    name: `echo-${String(index).padStart(3, "0")}`,
    // Long enough that a few dozen entries cannot all fit the inline budget.
    description: `Echo capability number ${index}, used to verify that the resident description stops growing once the catalog is large enough to threaten the context saving.`,
    trusted: true,
    transport: { type: "stdio" as const, command: process.execPath, args: [fixturePath] },
  });

  const describe = async (count: number): Promise<string> => {
    const catalogPath = path.join(root, `catalog-${count}.json`);
    await writeFile(
      catalogPath,
      JSON.stringify({ version: 1, entries: Array.from({ length: count }, (_, index) => entry(index)) }),
      "utf8",
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, "--catalog", catalogPath, "--state", path.join(root, `state-${count}`)],
      stderr: "pipe",
    });
    const client = new Client({ name: "capability-hub-describe", version: "0.1.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      return listed.tools[0]?.description ?? "";
    } finally {
      await client.close();
    }
  };

  const small = await describe(3);
  assert.match(small, /Available capabilities/, "a small catalog is listed in full");
  assert.match(small, /echo-000.*echo-001.*echo-002/s, "every entry is named");
  assert.match(small, /Echo capability number 0/, "descriptions are included while they fit");

  const large = await describe(60);
  assert.match(large, /Available capabilities/, "a large catalog is still announced");
  assert.match(large, /echo-059/, "every entry is still named");
  assert.doesNotMatch(large, /Echo capability number/, "descriptions are dropped once they stop fitting");
  assert.match(large, /action "search"/, "the model is told how to recover the descriptions");

  // The whole point: a 20x larger catalog must not cost 20x the resident context.
  assert.ok(
    large.length < small.length * 4,
    `degradation must bound growth (3 entries: ${String(small.length)} chars, 60 entries: ${String(large.length)} chars)`,
  );
});
