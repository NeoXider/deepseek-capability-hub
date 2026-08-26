import assert from "node:assert/strict";
import test from "node:test";
import { selectSmallestInstalledToolModel, validateHarnessRecords } from "../src/harness-smoke.js";

const TOOL = "mcp__capability_hub__capability_hub";

test("auto-selection chooses the smallest installed tool-use LLM deterministically", () => {
  const selected = selectSmallestInstalledToolModel([
    { type: "embedding", modelKey: "tiny-embedding", sizeBytes: 1, trainedForToolUse: true },
    { type: "llm", modelKey: "not-tool-trained", sizeBytes: 10, trainedForToolUse: false },
    {
      type: "llm",
      modelKey: "z-small-tool-model",
      displayName: "Z Small",
      sizeBytes: 100,
      trainedForToolUse: true,
    },
    {
      type: "llm",
      modelKey: "a-small-tool-model",
      displayName: "A Small",
      sizeBytes: 100,
      trainedForToolUse: true,
    },
    { type: "llm", modelKey: "large-tool-model", sizeBytes: 1_000, trainedForToolUse: true },
  ]);
  assert.deepEqual(selected, {
    modelKey: "a-small-tool-model",
    displayName: "A Small",
    sizeBytes: 100,
  });
});

test("auto-selection refuses catalogs without an installed tool-use LLM", () => {
  assert.equal(
    selectSmallestInstalledToolModel([
      { type: "embedding", modelKey: "embedding", sizeBytes: 1, trainedForToolUse: true },
      { type: "llm", modelKey: "plain-llm", sizeBytes: 10, trainedForToolUse: false },
    ]),
    undefined,
  );
});

function call(callId: string, args: Record<string, unknown>, name = TOOL) {
  return {
    type: "tool/call",
    data: { callId, name, arguments: JSON.stringify(args) },
  };
}

function result(callId: string, text: string, isError = false) {
  return {
    type: "tool/result",
    data: {
      message: {
        content: [{ type: "tool-result", toolCallId: callId, isError, content: [{ type: "text", text }] }],
      },
    },
  };
}

function assistant(text: string) {
  return {
    type: "assistant/message",
    data: {
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    },
  };
}

function successfulRecords(): unknown[] {
  const calls = [
    call("1", { action: "search" }),
    call("2", { action: "inspect", name: "demo-echo" }),
    call("3", { action: "tools", name: "demo-echo" }),
    call("4", {
      action: "call",
      name: "demo-echo",
      tool: "add",
      argumentsJson: JSON.stringify({ a: 2, b: 3 }),
    }),
    call("5", { action: "skill.load", name: "ml-experiment-review" }),
    call("6", { action: "status" }),
    call("7", { action: "disable", name: "demo-echo" }),
  ];
  const results = [
    result(
      "1",
      '{"capabilities":[{"name":"demo-echo"},{"name":"web-search-neo"},{"name":"unity-cli"}]}',
    ),
    result("2", '{"name":"demo-echo","trusted":true}'),
    result("3", '{"tools":[{"name":"add"}]}'),
    result("4", "5"),
    result("5", '<skill_content name="ml-experiment-review">falsifiable reproducible</skill_content>'),
    result("6", '{"enabled":[{"name":"demo-echo"}]}'),
    result("7", '{"disabled":"demo-echo","wasEnabled":true}'),
  ];
  return [
    { type: "session", id: "session-test" },
    { type: "permission/preset", data: { preset: "read-only" } },
    {
      type: "request/header",
      data: { header: { config: { provider: "lmstudio", model: "ling-3.0-tiny" } } },
    },
    ...calls.flatMap((item, index) => [item, results[index]]),
    assistant("CAPABILITY_HUB_SMOKE_OK"),
  ];
}

test("Harness receipt validation accepts only the exact successful hub workflow", () => {
  const validation = validateHarnessRecords(successfulRecords(), {
    provider: "lmstudio",
    model: "ling-3.0-tiny",
  });
  assert.equal(validation.passed, true);
  assert.deepEqual(validation.actions, [
    "search",
    "inspect",
    "tools",
    "call",
    "skill.load",
    "status",
    "disable",
  ]);
  assert.equal(validation.toolErrorCount, 0);
  assert.equal(validation.finalAssistantText, "CAPABILITY_HUB_SMOKE_OK");
  assert.equal(validation.evidence.toolsListedAdd, true);
  assert.equal(validation.evidence.sumFive, true);
  assert.equal(validation.evidence.skillLoaded, true);
  assert.equal(validation.catalogVisibility.webSearchNeo, true);
  assert.equal(validation.catalogVisibility.unityCli, true);
});

test("Harness receipt validation rejects another tool, retries, and tool errors", () => {
  const records = successfulRecords();
  records.push(call("8", { action: "status" }, "read"), result("8", "failed", true));
  const validation = validateHarnessRecords(records, {
    provider: "lmstudio",
    model: "ling-3.0-tiny",
  });
  assert.equal(validation.passed, false);
  assert.equal(validation.toolErrorCount, 1);
  assert.match(validation.failures.join("\n"), /only mcp__capability_hub__capability_hub may be used/);
  assert.match(validation.failures.join("\n"), /expected 7 tool calls, observed 8/);
});

test("Harness receipt validation rejects extra final text and missing isolated catalog visibility", () => {
  const records = successfulRecords();
  const final = records.at(-1) as { data: { message: { content: Array<{ text: string }> } } };
  final.data.message.content[0]!.text = "CAPABILITY_HUB_SMOKE_OK.";
  const searchResult = records.find(
    (record) => (record as { type?: string; data?: { message?: { content?: unknown[] } } }).type === "tool/result",
  ) as { data: { message: { content: Array<{ content: Array<{ text: string }> }> } } };
  searchResult.data.message.content[0]!.content[0]!.text =
    '{"capabilities":[{"name":"demo-echo"}]}';

  const validation = validateHarnessRecords(records, {
    provider: "lmstudio",
    model: "ling-3.0-tiny",
  });
  assert.equal(validation.passed, false);
  assert.equal(validation.evidence.exactFinalAssistantToken, false);
  assert.equal(validation.catalogVisibility.webSearchNeo, false);
  assert.equal(validation.catalogVisibility.unityCli, false);
  assert.match(validation.failures.join("\n"), /missing evidence: exactFinalAssistantToken/);
  assert.match(validation.failures.join("\n"), /missing catalog visibility: webSearchNeo/);
  assert.match(validation.failures.join("\n"), /missing catalog visibility: unityCli/);
});
