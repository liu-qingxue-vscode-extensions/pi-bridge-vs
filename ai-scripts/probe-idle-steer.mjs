import { RpcClient } from "@earendil-works/pi-coding-agent";
import { startMockLlmServer } from "@truly-private/omdsh-llm-mock-server";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
const CWD = "/tmp/pi-probe-idle";
fs.mkdirSync(CWD, { recursive: true });
const cliPath = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const mock = await startMockLlmServer({ port: 8146, apiKey: "mock-key", sequence: ["success"], repeatLast: true,
  successText: "简短回复。", chunkDelayMs: 20, chunkSize: 10 });
const client = new RpcClient({ cwd: CWD, cliPath, provider: "mock", model: "mock", args: ["--no-session", "--no-extensions"] });
const events = [];
client.onEvent(e => { events.push(e);
  if (["message_start","agent_start","agent_settled","queue_update"].includes(e.type))
    console.log(`  · ${e.type}${e.message?.role?" role="+e.message.role:""}${e.type==="queue_update"?` steering=[${e.steering}] followUp=[${e.followUp}]`:""}`); });
await client.start(); await sleep(1400);
console.log("── 场景 1：空闲时发 steer ──");
await client.steer("空闲时用 steer 发的第一条").catch(e=>console.log("  抛错: "+e.message));
await sleep(4000);
let users = events.filter(e=>e.type==="message_start"&&e.message?.role==="user");
console.log(`  ★ 用户消息数=${users.length} ${users.map(e=>JSON.stringify(e.message.content).slice(0,42)).join(" | ")}`);
events.length = 0;
console.log("── 场景 2：空闲时发 followUp ──");
await client.followUp("空闲时用 followUp 发的").catch(e=>console.log("  抛错: "+e.message));
await sleep(4000);
users = events.filter(e=>e.type==="message_start"&&e.message?.role==="user");
console.log(`  ★ 用户消息数=${users.length} ${users.map(e=>JSON.stringify(e.message.content).slice(0,42)).join(" | ")}`);
await client.stop().catch(()=>{}); await mock.close?.(); process.exit(0);
