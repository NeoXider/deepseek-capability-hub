#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalizeConvenienceFields(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...input };
  for (const [source, target] of [
    ["arguments", "argumentsJson"],
    ["config", "configJson"],
    ["entry", "entryJson"],
  ] as const) {
    if (normalized[source] !== undefined && normalized[target] === undefined) {
      normalized[target] = JSON.stringify(normalized[source]);
      delete normalized[source];
    }
  }
  return normalized;
}

async function main(): Promise<void> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(moduleDir, "../..");
  const catalog = path.resolve(argumentValue("--catalog") ?? path.join(packageDir, "data", "catalog.json"));
  const state = path.resolve(argumentValue("--state") ?? path.join(packageDir, "data", "state"));
  const inputFile = argumentValue("--input");
  const inline = argumentValue("--json");
  if (!inputFile && !inline) {
    throw new Error('Usage: capability-hub-client (--json "{...}" | --input request.json) [--catalog file] [--state dir]');
  }

  const raw = inputFile ? await readFile(path.resolve(inputFile), "utf8") : inline as string;
  const input = normalizeConvenienceFields(JSON.parse(raw) as Record<string, unknown>);
  const client = new Client({ name: "capability-hub-smoke-client", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(packageDir, "dist", "src", "server.js"), "--catalog", catalog, "--state", state],
    stderr: "inherit",
  });

  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "capability_hub", arguments: input });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.isError) process.exitCode = 2;
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
