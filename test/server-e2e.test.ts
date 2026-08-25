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
        argumentsJson: JSON.stringify({ text: "wire-ok" }),
      },
    });
    assert.match(JSON.stringify(called), /wire-ok/);
  } finally {
    await client.close();
  }
});
