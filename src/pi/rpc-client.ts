/**
 * rpc-client - 自持的传输层(替代官方 RpcClient)
 *
 * [为什么要自己写?]
 *   官方 `RpcClient` 有三处不满足需求(详见 docs/batches/B13.md ②):
 *     ① send() 是 private (类型上不可用)
 *     ② 只有[拉取式]getStderr() → 拿不到实时 stderr(我们被迫去读它的私有字段 process ⚠)
 *     ③ 完全没有"回复扩展 UI 请求"的出口
 *   而它的真核心只有两件事:写 stdin + 匹配回执
 *   → 自己写一遍(约 200 行)更干净,而且[天生带出口]
 *
 * [它只管什么?]
 *   只管[搬运]:spawn / stdin 写 / stdout 逐行解析 / 请求-回执匹配 / 超时
 *   不管业务语义(那是 PiClient 的事 )
 *
 * [协议契约仍从官方 import]
 *   RpcCommand / RpcResponse / JsonAgentSessionEvent / RpcExtensionUIResponse
 *   = pi 的协议定义(契约层)→ 官方改了我们本来就该跟
 *   本文件只自己实现[传输](传输层)→ 不依赖 pi 版本
 */
import { spawn, type ChildProcess } from "node:child_process";
import type {
    RpcCommand,
    RpcResponse,
    RpcExtensionUIResponse,
    PiLocalEvent,
    stdOutEvent,
    PiAllEvent
} from "../types/pi-type.js";
import { createCLogger, Logger } from "../logger.js";
import { NONAME } from "node:dns";

const conLog = createCLogger("pi-client-rpc")

/** 等待回执的超时*/
const REQUEST_TIMEOUT_MS = 30_000;
/** 停止时: 
 * 1. 先 SIGTERM,
 * 2. 这么久还没退再 SIGKILL
 */
const KILL_GRACE_MS = 1_000;

interface PendingRequest {
    resolve: (response: RpcResponse) => void;
    reject: (error: Error) => void;
}

export interface OwnRpcClientOptions {
    /** pi 的 CLI 入口(dist/cli.js 的绝对路径) */
    cliPath: string;
    /** 工作目录 */
    cwd: string;
    /** 额外参数(如 --no-session --no-extensions ...) */
    args?: string[];
    /** 额外环境变量 */
    env?: Record<string, string | undefined>;
    /** 日志回调(不传则输出 到 console ) */
    logger?: Logger;
}

export class OwnRpcClient {
    private proc: ChildProcess | null = null;

    /** 等待回执的请求表:id → { resolve, reject } */
    private readonly pending = new Map<string, PendingRequest>();

    /** 请求序号(拼 id 用) */
    private seq = 0;

    /**
     * 回执 / 事件的订阅者
     *
     * 两种都会送进来:
     *   · pi 主动推的事件(message_* / agent_* / ...)
     *   · [我们主动发的命令的回执](switch_session / get_messages ...)
     *     - 回执我们[先交给 pending 表],但[同时]也广播一份
     *     为什么?调试板需要看到它
     *     (之前只给 pending → 主动命令在调试板上“消失”了 )
     */
    eventHandler: ((e: PiAllEvent) => void) | null = null;

    /** stderr 订阅者
     * 只能有一个: 因为它无法分流
     */
    private handleStderr: ((text: string) => void) | null = null;

    /** 进程是否已退出(退出后所有请求立即失败,不等超时 ) */
    private exitError: Error | null = null;

    constructor(private readonly options: OwnRpcClientOptions) { this.log = options.logger ?? conLog; }

    /** 日志(由上层注入 ) */
    private readonly log: Logger;

    // ═══════════════════════════════════════════════════════════
    //  生命周期
    // ═══════════════════════════════════════════════════════════

    /** stderr 累积, onStderr 时补发 */
    private stderrText = "";

    /** 1. 启动 pi 子进程
     * (不做就绪判断 - 那是上层用的事 )
     */
    async start(): Promise<void> {
        // 0. 防重复启动
        if (this.proc) throw new Error("pi 已经启动");

        // 1. 拼接额外前缀参数
        const args = ["--mode", "rpc", ...(this.options.args ?? [])];
        this.log.debug(` 启动的路径:${this.options.cliPath},额外参数: ${args.join(" ")}`);

        // 2. 正式启动, 拿到句柄
        const proc = spawn("node", [this.options.cliPath, ...args], {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.options.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc = proc;
        this.exitError = null;

        // 3. 数据管线
        // 3.1 stdout的数据管线:按行解析
        proc.stdout?.on("data", (chunk: Buffer) => this.handleStdout(chunk));

        // 3.2 stderr的数据管线:累积 + 事件式分发
        proc.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            this.stderrText += text;
            if (this.handleStderr) {
                this.handleStderr(text);
            }
        });

        // 4. 子进程退出
        // 4.1. pi退出
        proc.once("exit", (code, signal) => {
            // 4.1.1. 已被 stop() 换掉 → 不重复处理
            if (this.proc !== proc) return;
            // 4.1.2. 退出信息
            this.exitError = new Error(`pi 进程退出 (code=${code} signal=${signal})`);
            // 4.1.3. 所有等待回执全部失败
            this.rejectAllPending(this.exitError);
            // 4.1.4. 广播[pi退出]事件
            this.emitEvent({ type: "pi_exit", code, signal });
        });
        // 4.2. Node报错退出
        proc.once("error", (err) => {
            // 4.2.1. 已被 stop() 换掉 → 不重复处理
            if (this.proc !== proc) return;
            // 4.2.2. 退出信息
            this.exitError = new Error(`无法启动 pi: ${err.message}`);
            // 4.2.3. 所有等待回执全部失败
            this.rejectAllPending(this.exitError);
            // 4.1.4. 广播[子进程崩坏]事件
            this.emitEvent({ type: "pi_spawn_error", text: err.message });
        });

        // 等一小会:若进程立刻崩了,这里就报错(比等到超时更友好 )
        await new Promise((r) => setTimeout(r, 100));
        if (proc.exitCode !== null) {
            throw this.exitError ?? new Error(`pi 启动后立即退出 (code=${proc.exitCode})`);
        }
    }
    /** 所有等待回执全部失败并清空 */
    private rejectAllPending(error: Error): void {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
    /** 停止 pi(SIGTERM → 宽限后 SIGKILL) */
    async stop(): Promise<void> {
        const proc = this.proc;
        if (!proc) return;
        this.proc = null; // 先摘掉:避免 exit 回调再走一遍逻辑

        this.log.debug("[rpc] stop");
        this.rejectAllPending(new Error("pi 已被停止"));
        proc.kill("SIGTERM");

        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                proc.kill("SIGKILL");
                resolve();
            }, KILL_GRACE_MS);
            proc.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });

        this.stdoutBuffer = "";
    }

    // ═══════════════════════════════════════════════════════════
    //  三个出口(官方给不了的)
    // ═══════════════════════════════════════════════════════════

    /**
     * 通用发送(public - 官方这个是 private )
     * 发一条命令并等它的回执(30s 超时)
     */
    async send(command: RpcCommand): Promise<RpcResponse> {
        const stdin = this.proc?.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) {
            throw new Error("pi 未启动或 stdin 不可写");
        }
        if (this.exitError) throw this.exitError;

        const id = `req_${++this.seq}`;
        return new Promise<RpcResponse>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`等待 ${command.type} 回执超时(${REQUEST_TIMEOUT_MS}ms)`));
            }, REQUEST_TIMEOUT_MS);

            this.pending.set(id, {
                resolve: (response) => {
                    clearTimeout(timer);
                    resolve(response);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });

            try {
                stdin.write(JSON.stringify({ ...command, id }) + "\n");
            } catch (err) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }

    /**
     * 回复扩展的 UI 请求(select / confirm / input / editor 的结果)
     *
     * [为什么不走 send()?]
     *   pi 对 extension_ui_response [不返回执](源码:直接 resolve 挂起的 Promise,不 output)
     *   → 走 send() 会一直挂到 30s 超时 而且会报一个无意义的错
     *   → 直接写一行就完事
     */
    reply(response: RpcExtensionUIResponse): void {
        const stdin = this.proc?.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) {
            this.log.error("[rpc] 无法回复扩展请求:stdin 不可写");
            return;
        }
        stdin.write(JSON.stringify(response) + "\n");
    }

    /**
     * 订阅 stderr(事件式 )
     * 订阅时会[立即补发]已累积的历史(启动期输出的扩展日志等 )
     */
    onStderr(handler: (text: string) => void): () => void {
        this.handleStderr = handler;
        if (this.stderrText) handler(this.stderrText); // 补历史
        return () => {
            this.handleStderr = null;
        };
    }
    // ═══════════════════════════════════════════════════════════
    //  具名方法(只是糖;真正的入口是 send )
    // ═══════════════════════════════════════════════════════════

    /**
     * 就绪探针:能拿到回执 = stdin/stdout 都通了,协议层活着
     * (PiClient 用它做"启动完成"的判断)
     */
    async getState(): Promise<unknown> {
        const response = await this.send({ type: "get_state" })
        if (response.success) return (response as { data?: unknown }).data;
        throw new Error((response as { error?: string }).error ?? "命令失败(无错误信息)");
    }

    // ═══════════════════════════════════════════════════════════
    //  内部:stdout 解析
    // ═══════════════════════════════════════════════════════════
    /** stdout 行缓冲 */
    private stdoutBuffer = "";

    /** stdout 到达:拼进缓冲,按行切 */
    private handleStdout(chunk: Buffer): void {
        this.stdoutBuffer += chunk.toString();
        let idx: number;
        // 将当前缓冲里所有能切出来的行切完, 一个块到来切一次 
        while ((idx = this.stdoutBuffer.indexOf("\n")) >= 0) {
            const line = this.stdoutBuffer.slice(0, idx);
            this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
            // 切一行消费一行
            if (line.trim()) this.handleLine(line);
        }
    }

    /** 处理一行:回执 → 匹配 pending;其余 → 当事件分发 */
    private handleLine(line: string): void {
        let data: PiAllEvent;
        try {
            data = JSON.parse(line) as stdOutEvent;
        } catch {
            this.log.error(`[rpc] 非 JSON 行: ${line.slice(0, 120)}`);
            data = { type: "pi_stdout_raw", text: line };
        }

        // ① 回执:匹配 pending 则先 resolve(让调用方拿到 )
        if (data.type === "response") {
            const id = (data as { id?: string }).id;
            if (id && this.pending.has(id)) {
                const pending = this.pending.get(id)!;
                this.pending.delete(id);
                pending.resolve(data);
            }
        }
        this.emitEvent(data)

    }

    private emitEvent(ev: PiAllEvent): void {
        if (this.eventHandler) {
            this.eventHandler(ev);
        }
    }


}
