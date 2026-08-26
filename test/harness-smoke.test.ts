import assert from "node:assert/strict";
import test from "node:test";
import { validateHarnessRecords } from "../src/harness-smoke.js";

const TOOL = "mcp__capability_hub__capability_hub";

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

function successfulRecords(): unknown[] {
  const calls = [
    call("1", { action: "search", query: "demo" }),
    call("2", { action: "inspect", name: "demo-echo" }),
    call("3", {
      action: "call",
      name: "demo-echo",
      tool: "add",
      argumentsJson: JSON.stringify({ a: 2, b: 3 }),
    }),
    call("4", { action: "skill.load", name: "ml-experiment-review" }),
    call("5", { action: "status" }),
    call("6", { action: "disable", name: "demo-echo" }),
  ];
  const results = [
    result("1", '{"capabilities":[{"name":"demo-echo"}]}'),
    result("2", '{"name":"demo-echo","trusted":true}'),
    result("3", "5"),
    result("4", '<skill_content name="ml-experiment-review">falsifiable reproducible</skill_content>'),
    result("5", '{"enabled":[{"name":"demo-echo"}]}'),
    result("6", '{"disabled":"demo-echo","wasEnabled":true}'),
  ];
  return [
    { type: "session", id: "session-test" },
    { type: "permission/preset", data: { preset: "read-only" } },
    {
      type: "request/header",
      data: { header: { config: { provider: "lmstudio", model: "ling-3.0-tiny" } } },
    },
    ...calls.flatMap((item, index) => [item, results[index]]),
  ];
}

test("Harness receipt validation accepts only the exact successful hub workflow", () => {
  const validation = validateHarnessRecords(successfulRecords(), {
    provider: "lmstudio",
    model: "ling-3.0-tiny",
  });
  assert.equal(validation.passed, true);
  assert.deepEqual(validation.actions, ["search", "inspect", "call", "skill.load", "status", "disable"]);
  assert.equal(validation.toolErrorCount, 0);
  assert.equal(validation.evidence.sumFive, true);
  assert.equal(validation.evidence.skillLoaded, true);
});

test("Harness receipt validation rejects another tool, retries, and tool errors", () => {
  const records = successfulRecords();
  records.push(call("7", { action: "status" }, "read"), result("7", "failed", true));
  const validation = validateHarnessRecords(records, {
    provider: "lmstudio",
    model: "ling-3.0-tiny",
  });
  assert.equal(validation.passed, false);
  assert.equal(validation.toolErrorCount, 1);
  assert.match(validation.failures.join("\n"), /only mcp__capability_hub__capability_hub may be used/);
  assert.match(validation.failures.join("\n"), /expected 6 tool calls, observed 7/);
});
