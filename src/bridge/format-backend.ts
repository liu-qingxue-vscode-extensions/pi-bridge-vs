/**
 * format-backend —— 后端 → 前端（webview）的转换层
 *
 * 【设计：表驱动 + 兜底透传】
 * - 第一步：什么处理器都不注册，所有数据原样透传（default 分支）
 * - 迭代时：为某一类 type 注册处理器，把它"翻译"成前端好渲染的形状
 *
 * 【为什么下游是"兜底"而上游是"白名单"？】
 * - 下游（后端→前端）：数据已经在路上了，不能丢。不认识也先原样送过去（能调试、能看见）
 * - 上游（前端→后端）：数据还没发出去。不安全/不认识就拦住（别给 pi 发非法命令）
 */
import type {
    RpcResponse,
    RpcExtensionUIRequest,
    JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * 后端输出的类型空间（我们讨论过的结论：pi 发给前端的一切都要包含进来）
 *   RpcResponse          —— 命令回执（{type:"response", command, success, ...}）
 *   JsonAgentSessionEvent —— 事件流（message_update / tool_execution_end / ...）大头
 *   RpcExtensionUIRequest —— pi 扩展要求 UI 交互（select/confirm/input/notify）
 */
export type BackendOutput = RpcResponse | JsonAgentSessionEvent | RpcExtensionUIRequest | PiStderrLine;

/**
 * 来自 pi 进程 stderr 的一行（诊断信息 / 错误）
 *
 * 它不是 pi 的 RPC 协议消息，而是我们从进程的第三通道（stderr）捕获的。
 * 纳入类型空间的原因：它是 pi 对我们的输出，必须能被前端展示（不得被“捂着”）。
 */
export type PiStderrLine = { type: "stderr"; text: string };

/** 转换函数：后端原始对象 → 前端可消费的载荷 */
type BackendFormatter = (raw: BackendOutput) => unknown;

/**
 * 处理器表
 * 第一步：空表 —— 所有数据走 default 兜底（原样透传）
 * 迭代：例如以后可以加
 *   "message_update": (raw) => ({ kind: "chunk", text: raw.assistantMessageEvent.delta })
 */
const formatMap: Partial<Record<string, BackendFormatter>> = {};

/**
 * 统一入口：后端对象 → 前端载荷
 * 找不到处理器就原样返回（兜底）
 */
export function toFrontendPayload(raw: BackendOutput): unknown {
    const type = (raw as { type?: string }).type;
    const formatter = type ? formatMap[type] : undefined;
    return formatter ? formatter(raw) : raw; // ← 默认：原样透传
}
