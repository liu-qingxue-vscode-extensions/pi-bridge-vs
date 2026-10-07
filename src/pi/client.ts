/**
 * PiClient —— 对【自持传输层】的薄封装
 *
 * 【分工】
 *   OwnRpcClient（./rpc-client.ts）—— 只管搬运：spawn / stdin / stdout / 回执匹配 / 超时
 *   本文件                            —— 管业务：生命周期 + 事件多播 + 命令分派
 *
 * 【为什么不直接用官方 RpcClient？】
 *   官方三处不满足（详见 docs/batches/B13.md ②）：
 *     · send 是 private ✗
 *     · 只有拉取式 getStderr ✗（拿不到实时 stderr）
 *     · 没有回复扩展 UI 请求的出口 ✗
 *   → 自持传输层后【三个出口都齐了】✓ 且不再依赖任何私有字段 ✓
 *
 * 【为什么还要 send(cmd) 分派而不直接用具名方法？】
 * 因为我们的“前端 → 后端”是表驱动设计（前端消息 → RpcCommand 对象）✓
 * 本层把 RpcCommand 翻译成对应调用，format 层就能继续数据驱动地扩展 ✓
 */

import { existsSync } from "node:fs";
import type {
    RpcCommand,
    JsonAgentSessionEvent,
    RpcExtensionUIResponse,
    RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { logDebug, logInfo, logError, logWarn } from "../logger.js";
import type { PiLocalEvent } from "./rpc-client.js";

/**
 * 事件订阅回调
 *
 * ★ 与以前的区别：现在【回执也算事件】✓
 *   pi 的 stdout 里混着两类：
 *     · 事件（message_* / agent_* / …）—— pi 主动推的
 *     · 回执（response）—— 我们主动发的命令的结果
 *   两条【都该进调试板】✗（以前只广播事件 ✗ → 主动命令“看不到” ✓）
 *   → 所以回调参数放宽为联合类型 ✓
 *
 * ★★ B37：再加一类 —— PiLocalEvent（pi 侧的【非协议】消息 ✓）
 *   ① stdout 里混入的非 JSON 行
 *   ② 进程退出 / 启动失败
 *   ⇒ 它们不是协议包 ✗ 但“看不见”是不行的（调试板 = 防漏表 ✓）
 */
export type PiEventHandler = (
    event: JsonAgentSessionEvent | RpcResponse | PiLocalEvent,
) => void;

/**
 * 解析 pi CLI（dist/cli.js）的绝对路径
 *
 * 【实现已移到 paths.ts】那里同时处理了设置项覆盖（pi-bridge.piCliPath）+ 自动探测。
 * 这里 re-export 保持旧调用点可用。
 */
import { resolvePiCliPath } from "./paths.js";
import { OwnRpcClient } from "./rpc-client.js";

/**
 * ★ B42：启动失败的原因（决定前端怎么提示）
 *   not-found     —— 路径空 / 文件不存在 ⇒ ★ 该弹"去设置"的通知
 *   startup-failed —— 启动过程本身失败（崩溃 / 就绪探针超时…）
 */
export interface PiStartError {
    kind: "not-found" | "startup-failed";
    cliPath: string;
    message: string;
}

export class PiClient {
    /**
     * ★ 内部传输层 【每次启动重建】✓
     *   原因：启动参数是构造时固定的 ✗
     *   若在构造函数里读一次设置，之后改设置就必须重载整个 VS Code 才生效 ✗
     *   改成“每次 spawn 时现读” → 改完设置点一下 reload 就能用新参数启动 ✓
     *
     * ★ 类型是 `| undefined`（而不是用 `!` 断言）—— 因为激活阶段它【真的是】undefined ✗
     *   （onStderr() 会在视图激活时就被调，那时进程还没起）
     */
    private client: OwnRpcClient | undefined;
    private started = false;

    /** 启动中的 Promise（用于幂等：并发调用复用同一个） */
    private starting: Promise<void> | null = null;

    /** 我们自己维护的订阅者集合（官方 onEvent 的回调会转发到这里） */
    private readonly handlers = new Set<PiEventHandler>();

    /** stderr 订阅者（★ 记在这里：client 重建后要重挂 ✓） */
    private readonly stderrHandlers = new Set<(text: string) => void>();

    /**
     * pi 的工作目录（重建时要复用 ✓）
     *
     * ★ 可变：cwd 是【启动参数】（死数据 ✗）——
     *   改它必须【重启子进程】，所以这里存的是“下一次启动要用什么 cwd”✓
     *   改 cwd 的入口：
     *     ① 输入区下方的 cwd 显示区（用户直接点着改 ✓）
     *     ② 未来：跨 cwd 切会话（带 sessionPath 一起切 ✓）
     */
    private cwd: string;
    /** pi CLI 路径（构造时解析一次即可 —— 路径很少变 ⚠） */

    /**
     * @param cwd     pi 的工作目录（通常 = VS Code 打开的工作区）
     * @param options.cliPath     pi CLI 路径（固定值 ✗ 不推荐：设置改了不生效）
     * @param options.readCliPath ★ 每次启动时【现读】cli 路径的回调（推荐 ✓）
     * @param options.readArgs    ★ 每次启动时【现读】额外参数的回调（推荐 ✓）
     * @param options.extraArgs   【旧接口】固定参数（保留兼容；优先用 readArgs ✓）
     *
     * ★ B42 教训：cliPath 原先只在【构造时】算一次 ✗ 于是
     *   "改设置 → reload / 切换会话" 仍然用旧路径（而启动是多处共用的核心 ✓）
     *   ⇒ 必须跟 readArgs 一样现读 ✓
     */
    constructor(
        cwd: string,
        options: {
            cliPath?: string;
            readCliPath?: () => string;
            readArgs?: () => string[];
            extraArgs?: string[];
        } = {},
    ) {
        this.cwd = cwd;
        this.readCliPath =
            options.readCliPath ?? ((): string => options.cliPath ?? resolvePiCliPath());
        this.readArgs = options.readArgs ?? ((): string[] => options.extraArgs ?? []);
        logDebug(`[PiClient] cliPath（启动时现读）= ${this.readCliPath()}`);
    }

    /** ★ 现读 cli 路径（每次启动都重新解析 ⇒ 用户改设置立刻生效）*/
    private readonly readCliPath: () => string;

    /** 现读额外启动参数（由 main.ts 提供：从设置项里拿 ✓） */
    private readonly readArgs: () => string[];

    /**
     * ★★ B42：启动失败订阅者
     *
     * 【为什么要有它】
     *   "启动"是【多处共用的核心】（activate 自检 / reload / 切换会话 / 发消息都会启动）
     *   ⇒ 失败通报必须挂在这里 ✗ 挂在某一处调用点上覆盖不全 ✓
     *   （用户实测：activate 时有通知 ✗ 但"切换会话"失败时只有普通报错 ✓）
     */
    private readonly startErrorHandlers = new Set<(err: PiStartError) => void>();

    /** 订阅"启动失败"（返回取消订阅）*/
    onStartError(handler: (err: PiStartError) => void): () => void {
        this.startErrorHandlers.add(handler);
        return () => this.startErrorHandlers.delete(handler);
    }

    private emitStartError(err: PiStartError): void {
        logWarn(
            `[PiClient] 启动失败(${err.kind})：${err.message} —— 订阅者 ${this.startErrorHandlers.size} 个`,
        );
        for (const h of this.startErrorHandlers) h(err);
    }

    /**
     * ★ 建一个全新的传输层（每次启动都会调）
     *
     * 【为什么新建而不是复用？】
     *   启动参数在构造时定死 ✗ → 想换参数只能连客户端一起重建 ✓
     */
    private buildClient(): OwnRpcClient {
        // ★ 现读参数（不是构造时读 ✗）—— 这就是“懒读”的关键一步 ✓
        const extraArgs = this.readArgs();
        if (extraArgs.length) {
            logInfo(`[PiClient] 额外启动参数: ${extraArgs.join(" ")}`);
        }

        const client = new OwnRpcClient({
            cwd: this.cwd,
            cliPath: this.readCliPath(), // ★ 现读（用户改设置立刻生效）
            // ★ 不再强加 --no-session ✓（用户要求：要传就【手动传，有传参的地方 ✓）
            //
            // 【历史】之前加它是为了：
            //   · 开发阶段不持久化 ✓ 不污染 TUI 会话列表 ✓
            //   但现在我们【要做真会话】（列表 / 切换 / 改名 ✓）
            //   → 必须让 pi 正常写会话文件 ✓
            args: [...extraArgs],
            // ★ 注入日志：传输层不依赖 vscode，日志由本层提供 ✓
            logger: { debug: logDebug, error: logError },
        });

        // 事件多播：官方 onEvent 的回调会转发给本层所有订阅者
        client.onEvent((event) => {
            for (const handler of this.handlers) {
                handler(event);
            }
        });

        // ★ 重挂 stderr：订阅者记在 PiClient 上，client 重建后要重新挂钩 ✓
        //   （OwnRpcClient 自己会补发历史 → 不会漏掉启动期输出 ✓）
        for (const handler of this.stderrHandlers) {
            client.onStderr(handler);
        }

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
        const cliPath = this.readCliPath(); // ★ 现读（含用户设置覆盖 ✓）
        logInfo(`[PiClient] 启动 pi --mode rpc ...（cliPath=${cliPath || "(空)"}）`);

        // ★ B42：两个"启动前就能判定"的失败 ⇒ 立刻通报（覆盖所有启动路径 ✓）
        if (!cliPath) {
            const err: PiStartError = {
                kind: "not-found",
                cliPath: "",
                message: "没找到 pi（未配置 piBridge.piCliPath，自动探测也没找到）",
            };
            this.emitStartError(err);
            throw new Error(err.message);
        }
        if (!existsSync(cliPath)) {
            const err: PiStartError = {
                kind: "not-found",
                cliPath,
                message: `pi 的路径不存在：${cliPath}（检查 pi-bridge.piCliPath 设置）`,
            };
            this.emitStartError(err);
            throw new Error(err.message);
        }

        try {
            // ★ 每次启动都【重建客户端 + 现读参数】
            //   → 改完设置点 reload 就能用新参数启动 ✓
            const client = this.buildClient();
            this.client = client;

            // ① 启动子进程（内部只等 100ms + 检查进程没立即崩溃）
            await client.start();

            // ② 就绪探针：发一条 get_state 并等回执
            //    能拿到回执，说明 pi 的 stdin/stdout 都通了、协议层真的活了
            //    （等价于 s-pi 里的 waitReady 探针）
            await client.getState();

            this.started = true;
            logInfo("[PiClient] pi 就绪");
        } catch (e) {
            // ★ 启动过程本身的失败（崩溃 / 探针超时 / 权限…）也要通报
            const msg = e instanceof Error ? e.message : String(e);
            this.emitStartError({ kind: "startup-failed", cliPath, message: msg });
            throw e;
        }
    }

    /** 当前的工作目录（给界面显示用 ✓） */
    getCwd(): string {
        return this.cwd;
    }

    /**
     * ★ 改工作目录（不改当前进程 —— 那要重启才能生效 ✗）
     *
     * 【调用方注意】改完之后通常要跟上 reload() ✓
     *   （因为 cwd 只影响 spawn 时刻 ✓）
     *
     * @returns 是否真的变了（相同则返回 false，调用者可据此跳过重载 ✓）
     */
    setCwd(next: string): boolean {
        const trimmed = (next ?? "").trim();
        if (!trimmed || trimmed === this.cwd) return false;
        logInfo(`[PiClient] 改工作目录: ${this.cwd} → ${trimmed}（需重启生效）`);
        this.cwd = trimmed;
        return true;
    }

    /** 是否已经启动过（reload 前探针用 ✓） */
    isStarted(): boolean {
        return this.started;
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
     *   因为它们记在本类上，buildClient 时会重新挂到新 client 上 ✓
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
     * 订阅 pi 的 stderr（错误 / 诊断信息）
     *
     * 【为什么必须送上前端？】
     * stderr 是 pi 进程的第三条输出通道，包含错误和诊断。
     * 若只转发给 process.stderr（开发者控制台），界面上看不见 ✗
     * 用户就无法感知“用着用着突然报错”✗
     *
     * ★ 事件式 —— 由 OwnRpcClient.onStderr 提供（官方只有拉取式 ✗）
     *   订阅时它会【立即补发已累积的历史】，所以不会漏掉启动期输出 ✓
     *
     * @returns 取消订阅的函数
     */
    onStderr(handler: (text: string) => void): () => void {
        this.stderrHandlers.add(handler);
        // 已启动过 → 立刻挂上；否则等 doStart → buildClient 时统一挂 ✓
        // （激活阶段进程还没起，什么也不做是正常的 ✓）
        this.client?.onStderr(handler);
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
    }

    /** 订阅事件流，返回取消订阅函数 */
    onEvent(handler: PiEventHandler): () => void {
        this.handlers.add(handler);
        return () => this.handlers.delete(handler);
    }

    /**
     * ★ 回复扩展的 UI 请求（select / confirm / input / editor 的结果）
     *
     * ★ 现在只是转发给传输层 ✓ —— 那里真有出口了（不再绕私有字段 ✗）
     *   OwnRpcClient.reply() 直接写 stdin，并且【不等回执】（因为 pi 不发 ✗）
     */
    replyExtensionUi(response: RpcExtensionUIResponse): void {
        logDebug(`[PiClient] 回复扩展请求 id=${response.id}`);
        this.client?.reply(response);
    }

    /**
     * 通用命令入口：RpcCommand → 对应调用
     *
     * 【为什么这么设计】
     *   前端消息经 format 层变成 RpcCommand
     *   这里按 type 分派 → 业务代码不需要知道具体怎么发 ✓
     *
     * ★ 新增命令只需在这里加一个 case（或直接用下面的 sendRaw ✓）
     */
    async send(cmd: RpcCommand): Promise<RpcResponse | undefined> {
        await this.ensureStarted(); // 懒启动：发命令前确保 pi 已就绪

        // ensureStarted 成功后 client 必定已建 ✓
        const client = this.client;
        if (!client) throw new Error("pi 未启动");

        // ★ 直接转发（B20 修 ✗）
        //
        // 【为什么去掉原来的 switch 白名单？】
        //   原来是 prompt / abort 两个 case，其余直接报错 ✗
        //   意图是好的（拼错命令时不要静默忽略 ✓）但现在成了坑 ✗：
        //     · 前端发 steer（插话）→ 【被这里拒掉】✗✗ 而且只在日志里报错 ✓
        //     · 用户看到的就是“插话完全没效果”✓（实际是我的层给拦了 ✓）
        //
        // 【为什么不担心拼错？】
        //   我们已经有两层白名单了 ✓：
        //     ① 类型层：cmd 是 RpcCommand 联合类型 ✓ 拼错根本编译不过 ✓
        //     ② format-frontend 的表驱动 + 前端消息联合类型 ✓
        //   → 到达这里的命令【必然合法】✓ 再拦一次只会造坑 ✓
        return (await client.send(cmd)) as RpcResponse | undefined;
    }

    /**
     * ★ 直接发任意命令并拿回执（新增命令时不用改 send 的分派表 ✓）
     * 比如：await pi.sendRaw({ type: "get_available_models" })
     */
    async sendRaw(cmd: RpcCommand): Promise<unknown> {
        await this.ensureStarted();
        const client = this.client;
        if (!client) throw new Error("pi 未启动");
        return client.send(cmd);
    }
}
