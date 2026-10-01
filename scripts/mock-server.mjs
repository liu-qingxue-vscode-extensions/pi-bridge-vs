/**
 * 启动 mock LLM server —— 协议 / UI 测试用（不依赖真实模型）
 *
 * 【为什么需要它？】
 * 真实模型：慢（几秒）、花钱、网络不确定、无法精确复现。
 * mock server：可控速度（chunkDelayMs）、可复现（固定脚本）、0 成本、离线。
 *
 * 【用法】
 *   node scripts/mock-server.mjs [behavior] [--port=8123] [--chunk-delay=120] ...
 *
 * 【常用场景】
 *   node scripts/mock-server.mjs success                     正常流式
 *   node scripts/mock-server.mjs slow_success --chunk-delay=300   慢速流式（测 abort）
 *   node scripts/mock-server.mjs reasoning_success           先思考再正文（测思考块）
 *   node scripts/mock-server.mjs tool_call_success           返回工具调用（测工具卡片）
 *   node scripts/mock-server.mjs max_tokens                  以 length 结束（测截断提示）
 *   node scripts/mock-server.mjs partial_disconnect          发一半断连（测错误路径）
 *   node scripts/mock-server.mjs stall                       挂起（测超时）
 *
 * 全部行为名见包导出的 MOCK_LLM_BEHAVIORS。
 *
 * 【注意】端口默认 8123，要和 ~/.pi/agent/models.json 里 mock provider 的 baseUrl 一致。
 */
import { startMockLlmServer, MOCK_LLM_BEHAVIORS } from "@truly-private/omdsh-llm-mock-server";

// ===== 参数解析（保持简单：位置参数 + --key=value）=====
const args = process.argv.slice(2);
const behavior = args.find((a) => !a.startsWith("--")) ?? "success";
const opt = (name, fallback) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

if (!MOCK_LLM_BEHAVIORS.includes(behavior)) {
    console.error(`未知行为：${behavior}`);
    console.error(`可用行为：\n  ${MOCK_LLM_BEHAVIORS.join(", ")}`);
    process.exit(1);
}

const port = Number(opt("port", 8123));

console.log(`启动 mock LLM server：behavior=${behavior}, port=${port}`);

const server = await startMockLlmServer({
    port,
    apiKey: "mock-key", // 必须与 models.json 里 mock provider 的 apiKey 一致
    sequence: [behavior],
    repeatLast: true, // 同一行为反复使用（方便连续测试）
    successText: opt("text", "这是 mock 模型的输出示例文本。用来测试流式渲染是否正确。"),
    partialText: opt("partial", "这段文本会被中途截断"),
    reasoningText: opt("reasoning", "我先想一下……用户想测试流式渲染。"),
    toolName: opt("tool-name", "read"),
    toolArguments: opt("tool-args", '{"path":"demo.txt"}'),
    chunkSize: Number(opt("chunk-size", 4)), // 每个 delta 的字符数
    chunkDelayMs: Number(opt("chunk-delay", 120)), // 块间延迟（slow_success 生效）
    disconnectDelayMs: Number(opt("disconnect-delay", 200)),
    retryAfterMs: Number(opt("retry-after", 1000)),
    // 遥测：能看到每个请求消耗了哪个行为、以什么方式结束
    onEvent: (e) => {
        if (e.type === "request") {
            console.log(`  ← 请求 #${e.attempt} [${e.behavior}] ${e.path}`);
        } else {
            console.log(`  → 结束 #${e.attempt} [${e.behavior}] ${e.outcome} · ${e.chunksSent} chunks`);
        }
    },
});

console.log("");
console.log("✓ mock server 已就绪");
console.log(`  baseURL : ${server.baseURL}`);
console.log(`  port    : ${server.port}`);
console.log(`  seed    : ${server.randomSeed}`);
console.log("");
console.log("models.json 里 mock provider 的 baseUrl 应为：" + server.baseURL + "/v1");
console.log("（Ctrl+C 退出）");

// 保持进程运行
await new Promise(() => {});
