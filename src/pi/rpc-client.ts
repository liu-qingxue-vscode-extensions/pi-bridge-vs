/**
 * rpc-client —— ★ 自持的传输层（替代官方 RpcClient）
 *
 * 【为什么要自己写？】
 *   官方 `RpcClient` 有三处不满足需求（详见 docs/batches/B13.md ②）：
 *     ① send() 是 private ✗（类型上不可用）
 *     ② 只有【拉取式】getStderr() ✗ → 拿不到实时 stderr（我们被迫去读它的私有字段 process ⚠）
 *     ③ 完全没有"回复扩展 UI 请求"的出口 ✗
 *   而它的真核心只有两件事：写 stdin + 匹配回执 ✓
 *   → 自己写一遍（约 200 行）更干净，而且【天生带出口】✓
 *
 * 【它只管什么？】
 *   只管【搬运】：spawn / stdin 写 / stdout 逐行解析 / 请求-回执匹配 / 超时
 *   ★ 不管业务语义（那是 PiClient 的事 ✓）
 *
 * 【协议契约仍从官方 import】
 *   RpcCommand / RpcResponse / JsonAgentSessionEvent / RpcExtensionUIResponse
 *   = pi 的协议定义（契约层）→ 官方改了我们本来就该跟 ✓
 *   本文件只自己实现【传输】（传输层）→ 不依赖 pi 版本 ✓
 */
import { spawn, type ChildProcess } from "node:child_process";
import type {
    RpcCommand,
    RpcResponse,
    RpcExtensionUIResponse,
    JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * 日志回调（★ 不直接依赖 logger.ts —— 那个依赖 vscode ✗）
 *
 * 【为什么？】
 *   本文件是【纯传输层】：只用 node 的内建模块 ✓
 *   → 可以不启动 VS Code 就单独跑（scripts/smoke-own-rpc.mjs ✓）
 *   日志由上层注入（PiClient 传 logger 的方法 ✓）
 */
export interface RpcLogger {
    debug(msg: string): void;
    error(msg: string): void;
}

/** 默认日志：控制台（测试环境用 ✓） */
const consoleLogger: RpcLogger = {
    debug: () => {},
    error: (msg) => console.error(msg),
};

/** 等待回执的超时（与官方一致：30s ✓） */
const REQUEST_TIMEOUT_MS = 30_000;

/** 停止时的宽限：先 SIGTERM，这么久还没退再 SIGKILL */
const KILL_GRACE_MS = 1_000;

/** pi 从 stdout 发给我们的东西：回执 或 事件 */
type Incoming = RpcResponse | JsonAgentSessionEvent;

/**
 * ★★ B37：pi 侧【非协议输出】（用户定的：调试板是“防漏表”✓）
 *
 * 【为什么需要它？】
 *   调试板原来只看得到“协议包”✗ 而 pi 还会发两种【不发包】的东西：
 *     ① stdout 里混入的非 JSON 行
 *        （原来 catch 一句 `log.debug("忽略非 JSON 行")` ✗ 调试板看不见 ✓）
 *     ② 进程退出 / 启动失败
 *        （原来只变成 exitError ✗ 同样看不见 ✓）
 *   ⇒ 用户：“它就是进度表和防漏表 ✗ 有字段没消费 ✗ 我随时都能看”✓
 *   ⇒ 所以“看不见”是不行的 ✗ 它们也得往调试板发一份 ✓
 *
 * ★ 单独用一个类型名（`pi_` 前缀 ✗）✗ 在调试板里一眼能区分：
 *   “这是 pi 说的话”还是“这是我们解析出来的协议包”✓
 * ★ 它们【不是协议包】✗ 所以 toChatPatch 会返回 undefined ✗ 不会污染渲染 ✓
 */
export interface PiLocalEvent {
    type: "pi_stdout_raw" | "pi_exit" | "pi_spawn_error";
    /** 原文（raw / spawn_error 用 ✓）*/
    text?: string;
    code?: number | null;
    signal?: string | null;
}

interface PendingRequest {
    resolve: (response: RpcResponse) => void;
    reject: (error: Error) => void;
}

export interface OwnRpcClientOptions {
    /** pi 的 CLI 入口（dist/cli.js 的绝对路径） */
    cliPath: string;
    /** 工作目录 */
    cwd: string;
    /** 额外参数（如 --no-session --no-extensions …） */
    args?: string[];
    /** 额外环境变量 */
    env?: Record<string, string | undefined>;
    /** 日志回调（不传则只输出 error 到 console ✓） */
    logger?: RpcLogger;
}

export class OwnRpcClient {
    /**
     * ★ 子进程 —— private 但【本文件内自己用】✓
     *   （对外不暴露；外部需要的能力都通过下面三个出口给 ✓）
     */
    private proc: ChildProcess | null = null;

    /** 等待回执的请求表：id → { resolve, reject } */
    private readonly pending = new Map<string, PendingRequest>();

    /** 请求序号（拼 id 用） */
    private seq = 0;

    /** stdout 行缓冲（TCP 流会截断，必须自己拼行 ✓） */
    private stdoutBuffer = "";

    /** stderr 累积（挂监听前产生的也会留在这里，onStderr 时补发 ✓） */
    private stderrText = "";

    /**
     * 回执 / 事件的订阅者
     *
     * ★ 两种都会送进来：
     *   · pi 主动推的事件（message_* / agent_* / …）
     *   · 【我们主动发的命令的回执】（switch_session / get_messages …）
     *     —— 回执我们【先交给 pending 表】，但【同时】也广播一份 ✓
     *     为什么？调试板需要看到它 ✗
     *     （之前只给 pending ✗ → 主动命令在调试板上“消失”了 ✓）
     */
    private readonly eventHandlers = new Set<(e: Incoming) => void>();

    /** stderr 订阅者 */
    private readonly stderrHandlers = new Set<(text: string) => void>();

    /** 进程是否已退出（退出后所有请求立即失败，不等超时 ✓） */
    private exitError: Error | null = null;

    constructor(private readonly options: OwnRpcClientOptions) {
        this.log = options.logger ?? consoleLogger;
    }

    /** 日志（由上层注入 ✓） */
    private readonly log: RpcLogger;

    // ═══════════════════════════════════════════════════════════
    //  生命周期
    // ═══════════════════════════════════════════════════════════

    /** 启动 pi 子进程（不做就绪判断 —— 那是上层用 getState 探针的事 ✓） */
    async start(): Promise<void> {
        if (this.proc) throw new Error("pi 已经启动");

        const args = ["--mode", "rpc", ...(this.options.args ?? [])];
        this.log.debug(`[rpc] spawn: node ${this.options.cliPath} ${args.join(" ")}`);

        const proc = spawn("node", [this.options.cliPath, ...args], {
            cwd: this.options.cwd,
            env: { ...process.env, ...this.options.env },
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.proc = proc;
        this.exitError = null;

        // ── stdout：逐行解析 ──
        proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));

        // ── stderr：累积 + 事件式分发（★ 官方没有的能力）──
        proc.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            this.stderrText += text;
            for (const handler of this.stderrHandlers) handler(text);
        });

        // ── 退出：让所有挂起的请求立即失败（而不是干等到超时 ✓）──
        proc.once("exit", (code, signal) => {
            if (this.proc !== proc) return; // 已被 stop() 换掉 → 不重复处理
            this.exitError = new Error(`pi 进程退出 (code=${code} signal=${signal})`);
            this.rejectAll(this.exitError);
            // ★★ B37：退出也广播一份（调试板要看 ✓ 它不是协议包 ✗ 见 PiLocalEvent ✓）
            this.broadcastLocal({ type: "pi_exit", code, signal });
        });
        proc.once("error", (err) => {
            if (this.proc !== proc) return;
            this.exitError = new Error(`无法启动 pi: ${err.message}`);
            this.rejectAll(this.exitError);
            // ★★ B37：启动失败同理 ✓
            this.broadcastLocal({ type: "pi_spawn_error", text: err.message });
        });

        // 等一小会：若进程立刻崩了，这里就报错（比等到超时更友好 ✓）
        await new Promise((r) => setTimeout(r, 100));
        if (proc.exitCode !== null) {
            throw this.exitError ?? new Error(`pi 启动后立即退出 (code=${proc.exitCode})`);
        }
    }

    /** 停止 pi（SIGTERM → 宽限后 SIGKILL） */
    async stop(): Promise<void> {
        const proc = this.proc;
        if (!proc) return;
        this.proc = null; // 先摘掉：避免 exit 回调再走一遍逻辑

        this.log.debug("[rpc] stop");
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

        this.pending.clear();
        this.stdoutBuffer = "";
    }

    // ═══════════════════════════════════════════════════════════
    //  ★ 三个出口（官方给不了的）
    // ═══════════════════════════════════════════════════════════

    /**
     * ★ 通用发送（public ✓ —— 官方这个是 private ✗）
     * 发一条命令并等它的回执（30s 超时）
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
                reject(new Error(`等待 ${command.type} 回执超时（${REQUEST_TIMEOUT_MS}ms）`));
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
     * ★ 回复扩展的 UI 请求（select / confirm / input / editor 的结果）
     *
     * 【为什么不走 send()？】
     *   pi 对 extension_ui_response 【不返回执】✗（源码：直接 resolve 挂起的 Promise，不 output）
     *   → 走 send() 会一直挂到 30s 超时 ✗ 而且会报一个无意义的错
     *   → 直接写一行就完事 ✓
     */
    reply(response: RpcExtensionUIResponse): void {
        const stdin = this.proc?.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) {
            this.log.error("[rpc] 无法回复扩展请求：stdin 不可写");
            return;
        }
        stdin.write(JSON.stringify(response) + "\n");
    }

    /**
     * ★ 订阅 stderr（事件式 ✓）
     * 订阅时会【立即补发】已累积的历史（启动期输出的扩展日志等 ✓）
     */
    onStderr(handler: (text: string) => void): () => void {
        this.stderrHandlers.add(handler);
        if (this.stderrText) handler(this.stderrText); // 补历史 ✓
        return () => {
            this.stderrHandlers.delete(handler);
        };
    }

    /** 订阅事件 / 回执流（★ 含主动命令的回执 ✓） */
    onEvent(handler: (event: Incoming) => void): () => void {
        this.eventHandlers.add(handler);
        return () => {
            this.eventHandlers.delete(handler);
        };
    }

    // ═══════════════════════════════════════════════════════════
    //  具名方法（只是糖；真正的入口是 send ✓）
    // ═══════════════════════════════════════════════════════════

    /**
     * 就绪探针：能拿到回执 = stdin/stdout 都通了、协议层活着 ✓
     * （PiClient 用它做"启动完成"的判断）
     */
    async getState(): Promise<unknown> {
        return this.dataOf(await this.send({ type: "get_state" }));
    }

    /** 从回执里取 data；失败则抛错（与官方 getData 行为一致 ✓） */
    private dataOf(response: RpcResponse): unknown {
        if (response.success) return (response as { data?: unknown }).data;
        throw new Error((response as { error?: string }).error ?? "命令失败（无错误信息）");
    }

    // ═══════════════════════════════════════════════════════════
    //  内部：stdout 解析
    // ═══════════════════════════════════════════════════════════

    /** stdout 到达：拼进缓冲，按行切 */
    private onStdout(chunk: Buffer): void {
        this.stdoutBuffer += chunk.toString();
        let idx: number;
        while ((idx = this.stdoutBuffer.indexOf("\n")) >= 0) {
            const line = this.stdoutBuffer.slice(0, idx);
            this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
            if (line.trim()) this.handleLine(line);
        }
    }

    /** 处理一行：回执 → 匹配 pending；其余 → 当事件分发 */
    private handleLine(line: string): void {
        let data: Incoming;
        try {
            data = JSON.parse(line) as Incoming;
        } catch {
            // 不是 JSON 的行（pi 偶尔会混入非协议输出）→ 不当错误 ✓
            // ★★ B37：但【不能静默丢掉】✗ 它也是 pi 发的东西 ✓
            //   调试板是“防漏表”✗ 看不见 == 不存在 ✓
            this.log.debug(`[rpc] 非 JSON 行: ${line.slice(0, 120)}`);
            this.broadcastLocal({ type: "pi_stdout_raw", text: line });
            return;
        }

        // ① 回执：匹配 pending 则先 resolve（让调用方拿到 ✓）
        if (data.type === "response") {
            const id = (data as { id?: string }).id;
            if (id && this.pending.has(id)) {
                const pending = this.pending.get(id)!;
                this.pending.delete(id);
                pending.resolve(data);
                // ★ 但【不 return】—— 还要广播给订阅者（调试板要看 ✓）
            }
        }

        // ② 全部当事件广播（含回执 ✓）
        for (const handler of this.eventHandlers) {
            handler(data);
        }
    }

    /** ★★ B37：广播一条【非协议】的 pi 侧消息（只给调试板那类读者 ✓）*/
    private broadcastLocal(ev: PiLocalEvent): void {
        for (const handler of this.eventHandlers) {
            handler(ev as never);
        }
    }

    /** 所有挂起请求立即失败 */
    private rejectAll(error: Error): void {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
    }
}
