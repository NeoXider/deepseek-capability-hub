import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os"; import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const pkg = path.resolve("..");
const fixture = path.resolve("pidfixture.mjs");
const root = await mkdtemp(path.join(os.tmpdir(), "audit-e2e-"));
const pidfile = path.join(root,"pids.txt"); await writeFile(pidfile,"");
const catalogPath = path.join(root, "catalog.json");
await writeFile(catalogPath, JSON.stringify({version:1,entries:[{
  kind:"mcp", name:"echo-test", description:"t", trusted:true,
  transport:{type:"stdio",command:process.execPath,args:[fixture],env:{AUDIT_PIDFILE:pidfile}}, configurable:[]}]}));
const client = new Client({name:"audit",version:"0"});
const tr = new StdioClientTransport({command:process.execPath,
  args:[path.join(pkg,"dist","src","server.js"),"--catalog",catalogPath,"--state",path.join(root,"state")],
  stderr:"ignore"});
await client.connect(tr);
// 5 concurrent enable requests through the real single MCP tool
const rs = await Promise.all([1,2,3,4,5].map(() =>
  client.callTool({name:"capability_hub",arguments:{action:"enable",name:"echo-test"}})));
rs.forEach((r,i)=>console.log(`req${i+1}:`, r.content[0].text));
await new Promise(r=>setTimeout(r,500));
const pids = (await readFile(pidfile,"utf8")).split("\n").filter(Boolean).map(Number);
console.log("child processes spawned by 5 concurrent enables:", pids.length, pids);
const st = await client.callTool({name:"capability_hub",arguments:{action:"status"}});
console.log("status:", st.content[0].text);
await client.close();
await new Promise(r=>setTimeout(r,3000));
const alive = p=>{try{process.kill(p,0);return true}catch{return false}};
console.log("alive after hub shutdown:", pids.map(p=>`${p}=${alive(p)}`).join(" "));
for (const p of pids){try{process.kill(p)}catch{}}
process.exit(0);
