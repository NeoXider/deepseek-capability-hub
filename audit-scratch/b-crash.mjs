import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
import { CatalogRepository } from "../dist/src/catalog.js";
import { CapabilityHub } from "../dist/src/manager.js";
const fixture = path.resolve("pidfixture.mjs");
const root = await mkdtemp(path.join(os.tmpdir(), "audit-crash-"));
const pidfile = path.join(root, "pids.txt"); await writeFile(pidfile, "");
const catalogPath = path.join(root, "catalog.json");
await writeFile(catalogPath, JSON.stringify({version:1,entries:[{
  kind:"mcp", name:"echo-test", description:"t", trusted:true,
  transport:{type:"stdio",command:process.execPath,args:[fixture],env:{AUDIT_PIDFILE:pidfile}}, configurable:[]}]}));
const repo = new CatalogRepository(catalogPath, path.join(root,"state")); await repo.load();
const hub = new CapabilityHub(repo); const sig = new AbortController().signal;
const t = r => r.content[0].text;
const run = async (i) => { try { return t(await hub.execute(i, sig)); } catch (e) { return "THREW: " + e.message; } };

console.log("enable:", await run({action:"enable",name:"echo-test"}));
console.log("kill child via its own 'die' tool...");
console.log("call die:", await run({action:"call",name:"echo-test",tool:"die",arguments:{}}));
await new Promise(r => setTimeout(r, 1500));
const pids = (await readFile(pidfile,"utf8")).split("\n").filter(Boolean).map(Number);
const alive = p => { try { process.kill(p,0); return true; } catch { return false; } };
console.log("child alive?", pids.map(p=>`${p}=${alive(p)}`).join(" "));
console.log("status AFTER child death:", await run({action:"status"}));
console.log("enable again:", await run({action:"enable",name:"echo-test"}));
console.log("call echo on dead child:", await run({action:"call",name:"echo-test",tool:"echo",arguments:{text:"hi"}}));
console.log("tools on dead child:", await run({action:"tools",name:"echo-test"}));
console.log("spawned pids now:", (await readFile(pidfile,"utf8")).split("\n").filter(Boolean));
console.log("--- recovery requires explicit disable ---");
console.log("disable:", await run({action:"disable",name:"echo-test"}));
console.log("enable:", await run({action:"enable",name:"echo-test"}));
await hub.close(); process.exit(0);
