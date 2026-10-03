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
import type {
    RpcCommand,
    JsonAgentSessionEvent,
    RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { logDebug, logInfo, logError } from "../logger.js";

/** 事件订阅回调 */
export type PiEventHandler = (event: JsonAgentSessionEvent) => void;

/**
 * 解析 pi CLI（dist/cli.js）的绝对路径
 *
 * 【实现已移到 paths.ts】那里同时处理了设置项覆盖（pi-bridge.piCliPath）+ 自动探测。
 * 这里 re-export 保持旧调用点可用。
 */
import { resolvePiCliPath } from "./paths.js";

export class PiClient {
    /**
     * ★ 内部 RpcClient 【不再是 readonly】—— 每次启动重建 ✓
     *   原因：RpcClient 的 args 是【构造时固定】的 ✗
     *   若在构造函数里读一次设置，之后改设置就必须重载整个 VS Code 才生效 ✗
     *   改成“每次 spawn 时现读” → 改完设置点一下 reload 就能用新参数启动 ✓
     *
     * ★ 类型是 `| undefined`（而不是用 `!` 断言）—— 因为激活阶段它【真的是】undefined ✗
     *   （onStderr() 会在视图激活时就被调，那时进程还没起）
     *   用 undefined 能让 TS 强制我们检查 → 避免刚才那个“undefined.process”崩溃 ✓
     */
    private client: RpcClient | undefined;
    private started = false;

    /** 启动中的 Promise（用于幂等：并发调用复用同一个） */
    private starting: Promise<void> | null = null;

    /** 我们自己维护的订阅者集合（官方 onEvent 的回调会转发到这里） */
    private readonly handlers = new Set<PiEventHandler>();

    /** stderr 订阅者 */
    private readonly stderrHandlers = new Set<(text: string) => void>();

    /** stderr 监听是否已挂载（避免重复挂） */
    private stderrAttached = false;

    /** pi 的工作目录（重建时要复用 ✓） */
    private readonly cwd: string;
    /** pi CLI 路径（构造时解析一次即可 —— 路径很少变 ⚠） */
    private readonly cliPath: string;

    /**
     * @param cwd     pi 的工作目录（通常 = VS Code 打开的工作区）
     * @param options.cliPath   pi CLI 路径；不传则自动解析
     * @param options.readArgs  ★ 每次启动时【现读】额外参数的回调
     *                            （比“构造时传入数组”更好：设置改了能立即生效 ✓）
     * @param options.extraArgs 【旧接口】固定参数（保留兼容；优先用 readArgs ✓）
     */
    constructor(
        cwd: string,
        options: { cliPath?: string; readArgs?: () => string[]; extraArgs?: string[] } = {},
    ) {
        this.cwd = cwd;
        this.cliPath = options.cliPath ?? resolvePiCliPath();
        this.readArgs = options.readArgs ?? ((): string[] => options.extraArgs ?? []);
        logDebug(`[PiClient] cliPath = ${this.cliPath}`);
    }

    /** 现读额外启动参数（由 main.ts 提供：从设置项里拿 ✓） */
    private readonly readArgs: () => string[];

    /**
     * ★ 建一个全新的 RpcClient（每次启动都会调）
     *
     * 【为什么要新建而不是复用？】
     *   RpcClient 的 args 在构造时定死 ✗
     *   → 想换启动参数，只能连客户端一起重建 ✓
     */
    private buildClient(): RpcClient {
        // ★ 现读参数（不是构造时读 ✗）—— 这就是“懒读”的关键一步 ✓
        const extraArgs = this.readArgs();
        if (extraArgs.length) {
            logInfo(`[PiClient] 额外启动参数: ${extraArgs.join(" ")}`);
        }

        const client = new RpcClient({
            cwd: this.cwd,
            cliPath: this.cliPath,
            // --no-session：不写会话文件
            //
            // 【为什么？】
            // 1. 开发阶段不需要持久化（会话管理将来由我们自己实现）
            // 2. 避免污染用户的 TUI 会话列表（~/.pi/agent/sessions/）
            // 3. 避免被外部工具破坏（如 pi-web 会往会话文件追加无 id 的条目，导致链断）
            args: ["--no-session", ...extraArgs],
        });

        // 构造时就注册官方事件回调 —— 这样无论何时 start，事件都不会漏
        client.onEvent((event) => {
            for (const handler of this.handlers) {
                handler(event);
            }
        });
        return client;
    }

    /** 启动 pi 子进程（官方内部会等待就绪） */
    /**
     * 确保 pi 已启动并就绪 —— 懒启动 + 幂等
     *
     * 三重保证：
     *   1. 已就绪    → 直接返回
     *   2. 启动中    → 复用同一个 Promise（并发调用不会重复 spawn）
     *   3. 首次调用  → 真正启动 + 就绪探针
     */
    async ensureStarted(): Promise<void> {
        if (this.started) return;
        if (this.starting) return this.starting;

        this.starting = this.doStart().finally(() => {
            // 无论成功/失败都清空：失败后允许下一次重试
            this.starting = null;
        });
        return this.starting;
    }

    /** 真正的启动流程（只被 ensureStarted 调用一次） */
    private async doStart(): Promise<void> {
        logInfo("[PiClient] 启动 pi --mode rpc ...");

        // ★ 每次启动都【重建客户端 + 现读参数】
        //   → 改完设置点 reload 就能用新参数启动 ✓
        const client = this.buildClient();
        this.client = client;

        // ① 官方 start() 只等 100ms + 检查进程没立即崩溃，不等于协议层就绪
        await client.start();

        // ② 就绪探针：发一条 get_state 并等回执
        //    能拿到回执，说明 pi 的 stdin/stdout 都通了、协议层真的活了
        //    （等价于 s-pi 里的 waitReady 探针）
        await client.getState();

        // ③ 挂载 stderr 监听（此时子进程已存在）
        this.attachStderr();

        this.started = true;
        logInfo("[PiClient] pi 就绪");
    }

    /**
     * ★ 重启 pi 子进程（用【最新】的启动参数）
     *
     * 【为什么需要它？】
     *   启动参数（如 --no-extensions）只能影响 spawn 时刻 ✗
     *   改完设置后，必须重启进程才能生效 ✓
     *   → 这个按钮就是“应用新设置”的开关 ✓
     *
     * 【注意】订阅关系（onEvent / onStderr）不受影响 ✓
     *   因为它们挂在本类上，而重建的只是内部 RpcClient ✓
     */
    async reload(): Promise<void> {
        logInfo("[PiClient] reload：重启 pi 进程（读取最新启动参数）");
        const wasRunning = this.started;
        await this.stop();
        if (wasRunning) {
            await this.ensureStarted();
        }
        // 若本来没在跑，就什么都不做（下一次命令会懒启动 ✓）
    }

    /**
     * 挂载 stderr 监听（事件驱动，幂等）
     *
     * 【怎么做到的？】
     * 官方 RpcClient 只暴露拉取式 getStderr()，但它内部把子进程存进了 this.process。
     * TypeScript 的 private 只是【编译期】限制（编译后类型擦除）——
     * 所以运行时可以直接访问它，给 childProcess.stderr 挂自己的监听器
     * （Node 的 EventEmitter 支持多个监听器，与官方内部那个共存）。
     *
     * 【风险】依赖了官方未承诺的私有字段。挂不上时不崩；
     * 将来官方改结构会导致这里失效（必要时可回退到轮询 getStderr）。
     *
     * @param silent 激活阶段（进程还没启动）挂不上是正常现象 → 不报错
     */
    private attachStderr(silent = false): void {
        if (this.stderrAttached) return;

        // ★ 激活阶段（进程还没起）client 就是 undefined → 直接返回 ✓
        //   （这正是之前崩溃的地方：读了 undefined 的 .process ✗）
        const client = this.client;
        if (!client) {
            if (!silent) {
                logError("[PiClient] 无法挂载 stderr 监听：pi 尚未启动");
            }
            return;
        }

        const proc = (client as unknown as { process?: ChildProcess }).process;
        if (!proc?.stderr) {
            if (!silent) {
                logError("[PiClient] 无法挂载 stderr 监听（官方内部结构可能已变）");
            }
            return;
        }

        // ① 先拉一次【历史】：
        //    官方在 spawn 后就挂了监听，把启动期输出（扩展日志 / 警告）
        //    累积在 getStderr() 字符串里。我们挂得晚，只能靠拉取补上。
        const history = client.getStderr();

        // ② 再挂【事件监听】：收之后新产生的数据（实时）
        proc.stderr.on("data", (chunk: Buffer) => {
            this.emitStderr(chunk.toString());
        });
        this.stderrAttached = true;

        // ③ 推送历史
        //    注：这是“拉取时刻”的快照；从拉取到挂监听之间的极短窗口内的数据可能漏掉
        //    （微秒级，且 stderr 是诊断信息，可接受）
        if (history) {
            this.emitStderr(history);
        }

        logInfo(`[PiClient] stderr 监听已挂载（历史 ${history.length} 字符 + 事件驱动）`);
    }

    /** 把 stderr 文本分发给所有订阅者 */
    private emitStderr(text: string): void {
        for (const handler of this.stderrHandlers) {
            handler(text);
        }
    }

    /**
     * 订阅 pi 的 stderr（错误 / 诊断信息）
     *
     * 【为什么必须送上前端？】
     * stderr 是 pi 进程的第三条输出通道，包含错误和诊断。
     * 官方只把它转发给 process.stderr（开发者控制台）——
     * 界面上看不见，用户就无法感知“用着用着突然报错”。
     *
     * @returns 取消订阅的函数
     */
    onStderr(handler: (text: string) => void): () => void {
        this.stderrHandlers.add(handler);
        // 若已启动过，立即尝试挂载；否则等 doStart 里挂
        // （silent：激活阶段进程还没起，挂不上是正常的，不报错）
        this.attachStderr(true);
        return () => {
            this.stderrHandlers.delete(handler);
        };
    }

    /** 停止 pi 子进程 */
    async stop(): Promise<void> {
        const client = this.client;
        if (!this.started || !client) return;
        logInfo("[PiClient] 正在停止 pi ...");
        await client.stop();
        this.started = false;
        // 重置挂载状态：进程已死，下次 start 需要重新挂
        this.stderrAttached = false;
    }

    /** 订阅事件流，返回取消订阅函数 */
    onEvent(handler: PiEventHandler): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    /**
     * ★ 回复扩展的 UI 请求（select / confirm / input / editor 的结果）
     *
     * 【为什么不走官方的 send()？】
     *   ① send 是 private（虽然运行时能访问，但类型上没暴露 ✗）
     *   ② ★ 更关键：pi 对 extension_ui_response 【不返回执】✗
     *      源码：handleInputLine 收到它 → 直接 resolve pending，不 output(response)
     *      → 走 send() 会一直挂到 30s 超时才结束 ✗，而且会报一个无意义的错
     *
     * 【所以直接写一行 JSONL】✓ —— 协议本来就是 JSONL（每行一个 JSON）
     *   与 attachStderr 一样，这里也依赖了官方未承诺的私有字段 process ⚠
     *   写不了就只记日志，不让扩展卡死（它会自己 timeout ✓）
     */
    replyExtensionUi(response: RpcExtensionUIResponse): void {
        const proc = (this.client as unknown as { process?: ChildProcess }).process;
        const stdin = proc?.stdin;
        if (!stdin || stdin.destroyed || !stdin.writable) {
            logError("[PiClient] 无法回复扩展请求：stdin 不可写");
            return;
        }
        logDebug(`[PiClient] 回复扩展请求 id=${response.id}`);
        stdin.write(JSON.stringify(response) + "\n");
    }

    /** 读取 pi 的 stderr（诊断用） */
    getStderr(): string {
        return this.client?.getStderr() ?? "";
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
        await this.ensureStarted(); // 懒启动：发命令前确保 pi 已就绪

        // ensureStarted 成功后 client 必定已建 ✓
        const client = this.client;
        if (!client) throw new Error("pi 未启动");

        switch (cmd.type) {
            case "prompt":
                return client.prompt(cmd.message, cmd.images);

            case "abort":
                return client.abort();

            default:
                // 用到未实现的命令时，明确报错而不是静默忽略
                logError(`[PiClient] send: 未实现的命令类型: ${(cmd as { type: string }).type}`);
                throw new Error(`未实现的命令类型: ${(cmd as { type: string }).type}`);
        }
    }

    /** 便捷方法：直接发一条 prompt（等价于 send({type:"prompt", message})） */
    async prompt(text: string): Promise<void> {
        await this.ensureStarted();
        logDebug(`[PiClient] prompt: ${text.slice(0, 80)}`);
        return this.client?.prompt(text);
    }
}
