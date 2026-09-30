/**
 * 验证批次 A 的两个关键机制：
 *   测试 1：幂等 —— 并发/重复调用 ensureStarted 只启动一次（纯逻辑，用假 client）
 *   测试 2：就绪探针 —— 官方 start() 后紧跟 getState() 能拿到回执（真实启动 pi）
 *
 * 跑法：node scripts/smoke-startup.mjs
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ============================================================
// 测试 1：幂等逻辑（复现 PiClient.ensureStarted 的写法）
// ============================================================
class FakeClient {
    startCount = 0;
    async start() {
        this.startCount++;
        await new Promise((r) => setTimeout(r, 50)); // 模拟耗时启动
    }
    async getState() {
        return {};
    }
}

class PiClientLike {
    constructor(client) {
        this.client = client;
        this.started = false;
        this.starting = null;
    }
    async ensureStarted() {
        if (this.started) return;
        if (this.starting) return this.starting; // ← 复用启动中的 Promise
        this.starting = this.doStart().finally(() => {
            this.starting = null;
        });
        return this.starting;
    }
    async doStart() {
        await this.client.start();
        await this.client.getState();
        this.started = true;
    }
}

const fake = new FakeClient();
const pi = new PiClientLike(fake);

// 10 个并发调用（模拟用户快速连发消息）
await Promise.all(Array.from({ length: 10 }, () => pi.ensureStarted()));
// 再串行调用两次（模拟之后的每条消息）
await pi.ensureStarted();
await pi.ensureStarted();

console.log(`[测试1 幂等] 10 个并发 + 2 次串行后，start() 实际执行 ${fake.startCount} 次（期望 1）`);
console.log(fake.startCount === 1 ? "  ✓ 通过\n" : "  ✗ 失败\n");

// ============================================================
// 测试 2：真实 start + getState 就绪探针
// ============================================================
const cwd = process.cwd();
const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
const cliPath = path.join(path.dirname(fileURLToPath(entryUrl)), "cli.js");

const client = new RpcClient({ cwd, cliPath, model: "ollama/ornstein:latest" });

const t0 = Date.now();
await client.start();
console.log(`[测试2 探针] start() 返回，耗时 ${Date.now() - t0}ms`);

const t1 = Date.now();
const state = await client.getState();
console.log(`[测试2 探针] getState() 拿到回执，耗时 ${Date.now() - t1}ms`);
console.log(`[测试2 探针] 状态: isStreaming=${state?.isStreaming} model=${state?.model?.id ?? "?"}`);
console.log("  ✓ 就绪探针可用（能回执 = 协议层真的活了）");

await client.stop();
process.exit(0);
