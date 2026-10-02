/**
 * model-limits —— 模型上下文窗口注册表
 *
 * 【为什么需要这个文件？】
 * 顶部状态栏的"电池"要表达【对话长度占比】= 当前 token ÷ 上下文上限。
 * 分子有 ✓（usage.totalTokens，实测 = input+output+cacheRead+cacheWrite）
 * 分母没有 ✗ —— 实测 RPC 事件里【不携带】contextWindow。
 *
 * 但 pi 的模型配置里有 ✓：~/.pi/agent/models.json
 *   {
 *     "providers": {
 *       "deepseek": { "models": [ { "id": "...", "contextWindow": 1000000 } ] }
 *     }
 *   }
 *
 * 所以这里读一次那个文件，建 modelId → contextWindow 的映射 ✓
 * 查不到就返回 undefined（前端把整块电池显示成 "?" ✓）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePiAgentDir } from "./paths.js";

/** 缓存（避免每个 message_end 都读磁盘） */
let cache: Map<string, number> | undefined;

type ModelsJson = {
    providers?: Record<
        string,
        {
            models?: Array<{ id?: unknown; contextWindow?: unknown }>;
        }
    >;
};

/**
 * 读取 models.json 并建立 modelId → contextWindow 映射
 *
 * 同时登记两种键：
 *   · 纯 id（"deepseek-v4-flash"）—— 因为 message_end.message.model 就是纯 id ✓
 *   · provider/id（"deepseek/deepseek-v4-flash"）—— 兼容未来可能的写法
 */
function load(): Map<string, number> {
    const map = new Map<string, number>();
    try {
        const file = join(resolvePiAgentDir(), "models.json");
        const raw = JSON.parse(readFileSync(file, "utf8")) as ModelsJson;
        for (const [providerName, provider] of Object.entries(raw.providers ?? {})) {
            for (const m of provider?.models ?? []) {
                if (typeof m?.id !== "string" || typeof m?.contextWindow !== "number") continue;
                map.set(m.id, m.contextWindow);
                map.set(`${providerName}/${m.id}`, m.contextWindow);
            }
        }
    } catch {
        // 读不到就当作"没有分母" → 前端显示 "?" ✓（不抛错、不崩 ✓）
    }
    return map;
}

/** 取映射（带缓存） */
export function getModelContextWindows(): Map<string, number> {
    if (!cache) cache = load();
    return cache;
}

/** 取映射的普通对象形式（用于 postMessage —— Map 不能直接序列化 ✗） */
export function getModelContextWindowsObject(): Record<string, number> {
    return Object.fromEntries(getModelContextWindows());
}

/** 用户可能改了 models.json → 下次启动或显式 reload 时刷新 */
export function reloadModelContextWindows(): void {
    cache = undefined;
}
