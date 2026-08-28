import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
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
      ["add", "echo", "fail", "wait"],
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

test("configuration persists after reload and secret-like keys are always rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-config-"));
  const catalogPath = path.join(root, "catalog.json");
  const stateDir = path.join(root, "state");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "mcp",
          name: "configured-server",
          description: "Configuration test server",
          trusted: true,
          transport: { type: "stdio", command: "${config:command}" },
          configurable: ["command", "apiKey", "nested"],
        },
      ],
    }),
    "utf8",
  );
  const repository = new CatalogRepository(catalogPath, stateDir);
  await repository.load();
  const hub = new CapabilityHub(repository);
  const signal = new AbortController().signal;

  await hub.execute(
    { action: "configure", name: "configured-server", config: { command: process.execPath } },
    signal,
  );
  assert.equal(repository.configFor("configured-server").command, process.execPath);
  const persisted = JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8"));
  assert.equal(persisted.capabilities["configured-server"].command, process.execPath);

  const reloaded = new CatalogRepository(catalogPath, stateDir);
  await reloaded.load();
  assert.equal(reloaded.configFor("configured-server").command, process.execPath);
  await assert.rejects(
    hub.execute(
      { action: "configure", name: "configured-server", config: { apiKey: "must-not-persist" } },
      signal,
    ),
    /Secret-like configuration key/,
  );
  await assert.rejects(
    hub.execute(
      { action: "configure", name: "configured-server", config: { nested: { value: true } } },
      signal,
    ),
    /must be a string, number, or boolean/,
  );
  assert.deepEqual(repository.configFor("configured-server"), { command: process.execPath });
});

test("child call failure and timeout leave a clean, reusable lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-lifecycle-"));
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/fixture-echo.js");
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "mcp",
          name: "lifecycle-server",
          description: "Lifecycle test server",
          trusted: true,
          transport: { type: "stdio", command: process.execPath, args: [fixturePath] },
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
    await hub.enable("lifecycle-server");
    const failed = await hub.execute(
      { action: "call", name: "lifecycle-server", tool: "fail" },
      signal,
    );
    assert.equal(failed.isError, true);
    assert.match(firstText(failed), /fixture failure/i);

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error("test timeout")), 50);
    try {
      await assert.rejects(
        hub.execute(
          {
            action: "call",
            name: "lifecycle-server",
            tool: "wait",
            arguments: { delayMs: 5_000 },
          },
          timeout.signal,
        ),
        /test timeout|abort/i,
      );
    } finally {
      clearTimeout(timer);
    }

    const recovered = await hub.execute(
      { action: "call", name: "lifecycle-server", tool: "add", arguments: { a: 2, b: 3 } },
      signal,
    );
    assert.equal(firstText(recovered), "5");
    assert.deepEqual(await hub.disable("lifecycle-server"), {
      disabled: "lifecycle-server",
      wasEnabled: true,
    });
    assert.deepEqual(await hub.disable("lifecycle-server"), {
      disabled: "lifecycle-server",
      wasEnabled: false,
    });
    const status = JSON.parse(firstText(await hub.execute({ action: "status" }, signal)));
    assert.deepEqual(status.enabled, []);
  } finally {
    await hub.close();
  }
});

test("trusted skills cannot escape catalog roots unless an external root was explicitly approved", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-skill-root-"));
  const external = await mkdtemp(path.join(os.tmpdir(), "capability-hub-external-skill-"));
  const externalSkill = path.join(external, "SKILL.md");
  await writeFile(externalSkill, "Explicit external root evidence.", "utf8");
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "skill",
          name: "blocked-external-skill",
          description: "Must stay blocked",
          trusted: true,
          skill: { type: "file", path: externalSkill },
        },
        {
          kind: "skill",
          name: "approved-external-skill",
          description: "Explicitly rooted skill",
          trusted: true,
          skill: { type: "file", path: externalSkill, allowedRoots: [external] },
        },
      ],
    }),
    "utf8",
  );
  const repository = new CatalogRepository(catalogPath, path.join(root, "state"));
  await repository.load();
  const hub = new CapabilityHub(repository);
  const signal = new AbortController().signal;
  await assert.rejects(
    hub.execute({ action: "skill.load", name: "blocked-external-skill" }, signal),
    /outside its trusted roots/,
  );
  assert.match(
    firstText(await hub.execute({ action: "skill.load", name: "approved-external-skill" }, signal)),
    /Explicit external root evidence/,
  );
});

test("streamable HTTP children work over an isolated loopback transport", async () => {
  const httpServer = createServer(async (request, response) => {
    const child = new McpServer({ name: "capability-hub-http-fixture", version: "0.1.0" });
    child.registerTool(
      "multiply",
      {
        description: "Multiply two numbers over loopback HTTP.",
        inputSchema: { a: z.number(), b: z.number() },
      },
      async ({ a, b }) => ({ content: [{ type: "text", text: String(a * b) }] }),
    );
    const transport = new StreamableHTTPServerTransport();
    try {
      await child.connect(transport as unknown as Transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) response.writeHead(500).end(String(error));
    } finally {
      await transport.close().catch(() => undefined);
      await child.close().catch(() => undefined);
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });

  const address = httpServer.address() as AddressInfo;
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-http-"));
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "mcp",
          name: "http-test",
          description: "Loopback HTTP test server",
          trusted: true,
          transport: {
            type: "streamable-http",
            url: `http://127.0.0.1:${address.port}/mcp`,
          },
        },
      ],
    }),
    "utf8",
  );
  const repository = new CatalogRepository(catalogPath, path.join(root, "state"));
  await repository.load();
  const hub = new CapabilityHub(repository);
  try {
    const result = await hub.execute(
      { action: "call", name: "http-test", tool: "multiply", arguments: { a: 6, b: 7 } },
      new AbortController().signal,
    );
    assert.equal(firstText(result), "42");
  } finally {
    await hub.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("context economy: enable reports a count, tools stays compact and filterable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-economy-"));
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
      ],
    }),
    "utf8",
  );
  const repository = new CatalogRepository(catalogPath, path.join(root, "state"));
  await repository.load();
  const hub = new CapabilityHub(repository);
  const signal = new AbortController().signal;
  try {
    // enable must not ship the tool list: the next step is "tools", which would
    // make the documented workflow pay for the same payload twice.
    const enabled = JSON.parse(firstText(await hub.execute({ action: "enable", name: "echo-test" }, signal)));
    assert.equal(typeof enabled.tools, "number");
    assert.equal(enabled.tools, 4);
    assert.deepEqual(enabled.nextStep, { action: "tools", name: "echo-test" });

    const listedText = firstText(await hub.execute({ action: "tools", name: "echo-test" }, signal));
    // Indentation is not information; it is only tokens.
    assert.doesNotMatch(listedText, /\n\s\s/);
    const listed = JSON.parse(listedText);
    assert.equal(listed.total, 4);
    assert.equal(listed.matched, 4);
    assert.equal(listed.truncated, false);

    // A query narrows the list instead of dumping every tool of a large server.
    const filtered = JSON.parse(
      firstText(await hub.execute({ action: "tools", name: "echo-test", query: "add" }, signal)),
    );
    assert.equal(filtered.matched, 1);
    assert.equal(filtered.total, 4);
    assert.deepEqual(filtered.tools.map((tool: { name: string }) => tool.name), ["add"]);
    assert.ok(
      JSON.stringify(filtered).length < JSON.stringify(listed).length,
      "a filtered tool list must be smaller than the full one",
    );
  } finally {
    await hub.close();
  }
});

test("concurrent enable of one capability starts exactly one child process", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-race-"));
  const distDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(distDir, "../..");
  const fixture = path.resolve(distDir, "../src/fixture-echo.js");
  const counter = path.join(repoRoot, "test", "fixtures", "spawn-counter.mjs");
  const spawnLog = path.join(root, "spawns.txt");
  await writeFile(spawnLog, "", "utf8");
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
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [counter],
            env: { HUB_SPAWN_LOG: spawnLog, HUB_REAL_ENTRY: pathToFileURL(fixture).href },
          },
          configurable: [],
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
    // `tools` and `call` enable on demand, so parallel model calls hit this path.
    await Promise.all([
      hub.execute({ action: "enable", name: "echo-test" }, signal),
      hub.execute({ action: "enable", name: "echo-test" }, signal),
      hub.execute({ action: "enable", name: "echo-test" }, signal),
    ]);
    const status = JSON.parse(firstText(await hub.execute({ action: "status" }, signal)));
    assert.equal(status.enabled.length, 1);
  } finally {
    await hub.close();
  }
  const spawned = (await readFile(spawnLog, "utf8")).split(/[\r\n]+/).filter(Boolean);
  assert.equal(spawned.length, 1, `expected one child process, ${spawned.length} were spawned and the extras leak`);
});

test("a transport command cannot be chosen by model-supplied configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-exec-"));
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "mcp",
          name: "templated",
          description: "Test server",
          trusted: true,
          transport: { type: "stdio", command: "${config:binary}", args: [] },
          configurable: ["binary"],
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
    await hub.execute({ action: "configure", name: "templated", config: { binary: "calc.exe" } }, signal);
    await assert.rejects(
      hub.execute({ action: "enable", name: "templated" }, signal),
      /cannot interpolate/,
      "configuration must never decide which executable runs",
    );
    // Directory tokens stay usable.
    assert.equal(repository.resolveExecutableTemplate("${catalogDir}/server.js"), `${root}/server.js`);
  } finally {
    await hub.close();
  }
});

test("a call interrupted by disable explains the next action instead of leaking transport noise", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-interrupt-"));
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
      ],
    }),
    "utf8",
  );
  const repository = new CatalogRepository(catalogPath, path.join(root, "state"));
  await repository.load();
  const hub = new CapabilityHub(repository);
  const signal = new AbortController().signal;
  try {
    await hub.execute({ action: "enable", name: "echo-test" }, signal);
    const inFlight = hub.execute(
      { action: "call", name: "echo-test", tool: "wait", arguments: { delayMs: 3000 } },
      signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    await hub.execute({ action: "disable", name: "echo-test" }, signal);

    // "MCP error -32000: Connection closed" tells a small model nothing it can act on.
    await assert.rejects(inFlight, /was disabled while "wait" was running; call action "enable" and retry/);

    // The hub must stay usable afterwards.
    await hub.execute({ action: "enable", name: "echo-test" }, signal);
    const recovered = await hub.execute(
      { action: "call", name: "echo-test", tool: "echo", arguments: { text: "still-alive" } },
      signal,
    );
    assert.equal(firstText(recovered), "still-alive");
  } finally {
    await hub.close();
  }
});

test("a catalog entry cannot load code into a child through the environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-env-"));
  const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/fixture-echo.js");
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "mcp",
          name: "loader",
          description: "Test server",
          trusted: true,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [fixture],
            // Guarding only `command` left this wide open: anything reaching NODE_OPTIONS
            // runs before the server's own entry point, whatever the key is called.
            env: { NODE_OPTIONS: "${config:harmless}" },
          },
          configurable: ["harmless"],
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
    await hub.execute({ action: "configure", name: "loader", config: { harmless: "--require ./evil.js" } }, signal);
    await assert.rejects(
      hub.execute({ action: "enable", name: "loader" }, signal),
      /can load code into the child/,
    );
  } finally {
    await hub.close();
  }
});

test("a failed call does not tear down a healthy child", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-teardown-"));
  const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/fixture-echo.js");
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
          transport: { type: "stdio", command: process.execPath, args: [fixture] },
          configurable: [],
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
    await hub.execute({ action: "enable", name: "echo-test" }, signal);
    // A tool error comes back as a result, not an exception, and must leave the child alone.
    const rejected = await hub.execute(
      { action: "call", name: "echo-test", tool: "wait", arguments: { delayMs: 999999 } },
      signal,
    );
    assert.equal(rejected.isError, true);

    // Cancellation is the case that used to kill a healthy server: one aborted call tore
    // the child down, so the next call had to pay for a full restart.
    const controller = new AbortController();
    const cancelled = hub.execute(
      { action: "call", name: "echo-test", tool: "wait", arguments: { delayMs: 5000 } },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(cancelled, /was cancelled/, "an aborted call must report cancellation");
    const status = JSON.parse(firstText(await hub.execute({ action: "status" }, signal)));
    assert.equal(status.enabled.length, 1, "the child must still be enabled after a failed call");
    const recovered = await hub.execute(
      { action: "call", name: "echo-test", tool: "echo", arguments: { text: "alive" } },
      signal,
    );
    assert.equal(firstText(recovered), "alive");
  } finally {
    await hub.close();
  }
});

test("model-facing rows are capped by field, not only by row count", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-caps-"));
  const catalogPath = path.join(root, "catalog.json");
  // The schema permits a 2,000-character description and 100 tags of 500 characters, so a
  // row cap alone still allowed a multi-megabyte reply from a context-saving tool.
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "skill",
          name: "fat",
          description: "x".repeat(2000),
          tags: Array.from({ length: 100 }, (_, index) => `tag${index}-${"y".repeat(400)}`),
          trusted: true,
          skill: { type: "file", path: "SKILL.md" },
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
    const parsed = JSON.parse(firstText(await hub.execute({ action: "search", query: "" }, signal)));
    const row = parsed.capabilities[0];
    assert.ok(row.description.length <= 401, `description was ${row.description.length} chars`);
    assert.ok(row.tags.length <= 10, `${row.tags.length} tags survived`);
    for (const tag of row.tags) assert.ok(tag.length <= 61, `tag was ${tag.length} chars`);
    // The whole payload must stay small enough to belong in a prompt.
    assert.ok(firstText(await hub.execute({ action: "search", query: "" }, signal)).length < 4000);
  } finally {
    await hub.close();
  }
});

// An empty tool list used to be a dead end. A capability whose backing application is
// not running starts cleanly and publishes nothing, so the caller saw `total: 0` with no
// cause and no next step — observed against a Unity MCP with the editor closed. A query
// that matches nothing produces the same shape for an entirely different reason, so the
// two are now distinguished in the reply.
test("an empty tool list explains which of its two causes happened", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-empty-"));
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
          description: "Publishes tools normally",
          trusted: true,
          transport: { type: "stdio", command: process.execPath, args: [fixturePath] },
          configurable: [],
        },
        {
          kind: "mcp",
          name: "silent-test",
          description: "Starts cleanly and publishes nothing, like a fronted app that is not running",
          trusted: true,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [fixturePath],
            env: { CAPABILITY_HUB_FIXTURE_MODE: "silent" },
          },
          configurable: [],
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
    const silent = JSON.parse(firstText(await hub.execute({ action: "tools", name: "silent-test" }, signal)));
    assert.equal(silent.total, 0);
    assert.match(silent.note, /published no tools/, "the cause is named");
    assert.match(silent.note, /not running/, "the likely reason is named");
    assert.match(silent.note, /call this action again/i, "a next step is offered");

    // Same empty shape, different cause: the server has tools, the query matched none.
    const unmatched = JSON.parse(
      firstText(await hub.execute({ action: "tools", name: "echo-test", query: "zzzz-no-such-tool" }, signal)),
    );
    assert.equal(unmatched.matched, 0);
    assert.equal(unmatched.total, 4);
    assert.match(unmatched.note, /matched/, "the query is blamed, not the server");
    assert.doesNotMatch(unmatched.note, /not running/, "a healthy server is not called broken");
    assert.match(unmatched.note, /all 4/, "the caller is told how many it could see instead");

    // A populated list stays clean: no note means no tokens spent on one.
    const listed = JSON.parse(firstText(await hub.execute({ action: "tools", name: "echo-test" }, signal)));
    assert.equal(listed.note, undefined);
  } finally {
    await hub.close();
  }
});

// A server that exposes only prompts or resources never registers a tools/list handler
// and answers -32601. That is a legitimate MCP server, but the raw JSON-RPC error used to
// escape from `enable`, so opening one looked like a crash instead of "it has no tools".
test("a child without a tools/list handler enables with zero tools instead of erroring", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capability-hub-toolless-"));
  const fixturePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/fixture-echo.js");
  const catalogPath = path.join(root, "catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          kind: "mcp",
          name: "toolless-test",
          description: "Answers -32601 for tools/list, like a prompts-only server",
          trusted: true,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [fixturePath],
            env: { CAPABILITY_HUB_FIXTURE_MODE: "toolless" },
          },
          configurable: [],
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
    const enabled = JSON.parse(firstText(await hub.execute({ action: "enable", name: "toolless-test" }, signal)));
    assert.equal(enabled.enabled, "toolless-test", "enable succeeds rather than throwing -32601");
    assert.equal(enabled.tools, 0);

    const listedText = firstText(await hub.execute({ action: "tools", name: "toolless-test" }, signal));
    assert.doesNotMatch(listedText, /-32601|Method not found/, "no raw JSON-RPC error reaches the model");
    const listed = JSON.parse(listedText);
    assert.equal(listed.total, 0);
    assert.match(listed.note, /published no tools/);
  } finally {
    await hub.close();
  }
});
