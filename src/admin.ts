#!/usr/bin/env node
import path from "node:path";
import { CatalogRepository } from "./catalog.js";

function argumentValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const [command, id] = process.argv.slice(2).filter((arg) => !arg.startsWith("--") && arg !== argumentValue("--state"));
  const stateDir = path.resolve(argumentValue("--state") ?? path.join(process.cwd(), "data", "state"));

  if (command !== "approve" || !id) {
    throw new Error('Usage: capability-hub-admin approve <proposal-id> --state "<state-dir>" --yes');
  }
  if (!process.argv.includes("--yes")) {
    throw new Error("Approval requires --yes after a human reviews the pending proposal JSON");
  }
  const approved = await CatalogRepository.approve(stateDir, id);
  process.stdout.write(`${JSON.stringify(approved, null, 2)}\n`);
  process.stdout.write("Approved. Ask the model to run catalog.reload before enabling it.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
