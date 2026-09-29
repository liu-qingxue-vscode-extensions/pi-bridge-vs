/**
 * PiClient —— 对官方 RpcClient 的薄封装
 *
 * 【为什么还要包一层？】
 * 官方 RpcClient 已经实现了协议细节（spawn、JSONL 解析、请求 id 关联、超时）。
 * 我们这一层只做三件事：
 *   1. 统一生命周期（start / stop）
 *   2. 事件多播（把 onEvent 的事件转发给多个订阅者，方便"调试板"和"聊天视图"同时监听）
 *   3. 提供 send(cmd) 通用入口 —— 把 RpcCommand 对象分派到官方的具名方法
 *
 * 【为什么要 send(cmd) 而不是直接调 client.prompt()？】
 * 因为我们的"前端 → 后端"是表驱动设计（前端消息 → RpcCommand 对象）。
 * 官方 RpcClient 只提供具名方法（prompt/abort/setModel...），
 * 所以需要一个"分派器"把 RpcCommand 翻译成对应的方法调用。
 * 这样我们的 format 层可以继续按"数据驱动"的方式扩展命令，而不用改调用点。
 */
import { RpcClient } from "@earendil-works/pi-coding-agent";
import type { RpcCommand, JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { logDebug, logInfo, logError } from "../logger.js";

/** 事件订阅回调 */
export type PiEventHandler = (event: JsonAgentSessionEvent) => void;

/**
 * 解析 pi CLI（dist/cli.js）的绝对路径
 *
 * 【为什么必须自己解析？】
 * 官方 RpcClient 的默认 cliPath 是相对路径 "dist/cli.js"，
 * 而 spawn 的相对路径是相对 cwd 解析的 —— 我们的 cwd 是用户工作区，
 * 那里当然没有 dist/cli.js，于是启动失败。
 *
 * 【为什么用 import.meta.resolve 而不是 require.resolve？】
 * pi 包的 package.json 里 exports 只声明了 "import" 条件（没有 "require"），
 * 所以 CJS 的 require.resolve 会报 ERR_PACKAGE_PATH_NOT_EXPORTED。
 * import.meta.resolve 走 ESM 解析，会正确按 "import" 条件找到 dist/index.js，
 * 同目录下的 cli.js 就是我们要启动的入口。
 */
export function resolvePiCliPath(): string {
    const entryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const entryPath = fileURLToPath(entryUrl); // file:///... → /...
    return path.join(path.dirname(entryPath), "cli.js");
}

export class PiClient {
    private readonly client: RpcClient;
    private started = false;

    /** 我们自己维护的订阅者集合（官方 onEvent 的回调会转发到这里） */
    private readonly handlers = new Set<PiEventHandler>();

    /**
     * @param cwd     pi 的工作目录（通常 = VS Code 打开的工作区）
     * @param cliPath pi CLI 路径；不传则自动解析
     */
    constructor(cwd: string, cliPath?: string) {
        const resolvedCli = cliPath ?? resolvePiCliPath();
        logDebug(`[PiClient] cliPath = ${resolvedCli}`);
        this.client = new RpcClient({ cwd, cliPath: resolvedCli });

        // 构造时就注册官方事件回调 —— 这样无论何时 start，事件都不会漏
        this.client.onEvent((event) => {
            for (const handler of this.handlers) {
                handler(event);
            }
        });
    }

    /** 启动 pi 子进程（官方内部会等待就绪） */
    async start(): Promise<void> {
        if (this.started) return;
        logInfo("[PiClient] 正在启动 pi --mode rpc ...");
        await this.client.start();
        this.started = true;
        logInfo("[PiClient] pi 已启动");
    }

    /** 停止 pi 子进程 */
    async stop(): Promise<void> {
        if (!this.started) return;
        logInfo("[PiClient] 正在停止 pi ...");
        await this.client.stop();
        this.started = false;
    }

    /** 订阅事件流，返回取消订阅函数 */
    onEvent(handler: PiEventHandler): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    /** 读取 pi 的 stderr（诊断用） */
    getStderr(): string {
        return this.client.getStderr();
    }

    /**
     * 通用命令入口：RpcCommand → 官方具名方法
     *
     * 这就是我们讨论过的 "dispatcher"：
     *   - 前端消息经 format 层变成 RpcCommand
     *   - 这里按 type 分派到 client 的具名方法
     *
     * 第一步只实现 prompt / abort，后续迭代逐个补充。
     */
    async send(cmd: RpcCommand): Promise<void> {
        switch (cmd.type) {
            case "prompt":
                return this.client.prompt(cmd.message, cmd.images);

            case "abort":
                return this.client.abort();

            default:
                // 用到未实现的命令时，明确报错而不是静默忽略
                logError(`[PiClient] send: 未实现的命令类型: ${(cmd as { type: string }).type}`);
                throw new Error(`未实现的命令类型: ${(cmd as { type: string }).type}`);
        }
    }

    /** 便捷方法：直接发一条 prompt（等价于 send({type:"prompt", message})） */
    async prompt(text: string): Promise<void> {
        logDebug(`[PiClient] prompt: ${text.slice(0, 80)}`);
        return this.client.prompt(text);
    }
}
