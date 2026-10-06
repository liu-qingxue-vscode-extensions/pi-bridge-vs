/**
 * session-actions.ts —— 会话（"绘画"）领域的【动作】（B36 ✓）
 *
 * 【★ 包含什么】
 *   打开面板 / 刷新列表 / 新建 / 改名 / 切换 / 克隆 / 分叉 /
 *   删除 / 导出 / 导入 —— 共 10 个动作 ✓
 *   另有 doBranch / doRemove / doExport / doImport 那几个实现细节一起搬来 ✓
 *
 * 【★★ 为什么必须搬出来？】
 *   这些动作【不是聊天页专属】✗ 侧栏和会话面板都会触发：
 *     · 侧栏「＋ 新建」→ newSession      ┐
 *     · 会话面板「＋ 新建」→ newSession  ┘ 同一个动作 ✓
 *     · 侧栏标题点击 → renameSession     ┐
 *     · 面板右键 → 导出 / 导入 / 删除     ┘
 *   ⇒ 两边都要落到【同一份实现】✗ 否则就是两套逻辑 ✓
 *   （B36 之前是靠"面板把消息转交给聊天页那个大函数"凑合的 ✓
 *     隐式 ✗ 现在已经显式成 actions ✓）
 *
 * 【★ 依赖注入说明】
 *   pi / sessionStore / chatState 是"共享的宿主能力"✗ 由 main.ts 传入 ✓
 *   replay / pushTitle / currentFile 是"别处也要用的函数"✗ 也由 main.ts 传入 ✓
 *     （★ 它们没搬进来的原因就是【别人也要用】✗ 搬了反而要再导回去 ✓）
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import type { PiClient } from "../pi/client.js";
import {
    deleteSessionFile,
    sessionDirForCwd,
    validateSessionFile,
    type SessionStore,
} from "../pi/session-store.js";
import type { ChatState } from "../view/chat-state.js";
import { logDebug, logError, logInfo, logWarn } from "../logger.js";
import { toErrorMessage } from "../utils.js";
import { compactHome } from "../util/paths.js";

export interface SessionActionsDeps {
    /** pi 子进程客户端（启动 / 切换 / 分叉都靠它 ✓）*/
    pi: PiClient;
    /** 会话存储（扫目录 / 名字缓存 / 删文件 ✓）*/
    sessionStore: SessionStore;
    /** 权威聊天状态（reset / clearNotices / snapshot ✓）*/
    chatState: ChatState;
    /** 推给聊天页（chatView.post ✓）*/
    postChat: (kind: string, payload?: unknown) => void;
    /** 推给会话面板（sessionPanel.post ✓）*/
    postPanel: (kind: string, payload: unknown) => void;
    /** 打开 / 切到会话面板（走三面板互斥协调器 ✓）*/
    showPanel: () => void;
    /** ★ B35：切换 / 新建会话后关面板（配置 pi-bridge.sessions.closeAfterAction ✓）*/
    closePanelAfterAction: () => void;
    /** 重放历史消息（main.ts 的 replaySessionMessages ✓ reloadPi 也要用 ✓）*/
    replay: () => Promise<void>;
    /** 推顶栏会话名（pushCurrentSessionTitle ✓ 改名 / 启动探针都要用 ✓）*/
    pushTitle: (overrideName?: string) => Promise<void>;
}

export interface SessionActions {
    /** 打开 / 切到会话面板（侧栏 ☰ · 命令入口 ✓ 顺带刷一下顶栏名字 ✓）*/
    open(): void;
    /** 重扫文件名 + 补名字 / 标异常 → 推列表（用户点「⟳ 刷新」✓）*/
    refresh(): Promise<void>;
    /** 只推列表（scope 过滤在这里做 ✓ 配置变化 / 面板就绪都用它 ✓）*/
    list(): Promise<void>;
    /** 新建（★ 伪新建 ✗ 发第一条消息才落盘 ✓）*/
    newSession(): Promise<void>;
    /** 给【当前】会话改名（弹原生输入框 ✓）*/
    rename(): Promise<void>;
    /** 切到某个会话文件（同 cwd 直接切 ✗ 跨 cwd 先重载 ✓）*/
    switchTo(sessionPath: string): Promise<void>;
    /** 克隆 / 分叉（fork 要用户消息的锚点下标 ✓）*/
    branch(opts: { isFork: boolean; userIndex?: number }): Promise<void>;
    /** 删除会话文件（先 trash ✗ 回落 unlink ✓ 二次确认 ✓）*/
    remove(sessionPath: string, name?: string): Promise<void>;
    /** 导出（jsonl 任意会话 ✗ html 只限当前会话 ✓）*/
    exportOne(sessionPath: string, name?: string): Promise<void>;
    /** 导入外部 .jsonl（校验后放进当前 cwd 的会话目录 ✓）*/
    importOne(): Promise<void>;
}

/** 造一份会话动作集（闭包持有 deps ✓）*/
export function createSessionActions(deps: SessionActionsDeps): SessionActions {
    const { pi, sessionStore, chatState } = deps;

    const open = (): void => {
        deps.showPanel();
        // ★ 顺便刷新【顶栏的会话名】（原来在 listSessions 里做 ✓）
        void deps.pushTitle();
    };

    /**
     * ★ 推【会话列表】给面板（scope 过滤在这里做 ✓）
     *
     * 【★ 为什么要有 scope？】（pi-bridge.sessions.scope ✓）
     *   "current" = 只看当前 cwd 的会话（受限模式 ✓）
     *   "all"     = 所有 cwd（面板按 cwd 分组显示 ✓）
     * ★ 它是"前端显示范围"→ 应该【实时生效】✗ 不是等重开面板 ✓
     *   （所以配置一变就再调一次 list() ✓）
     */
    const list = async (): Promise<void> => {
        const all = await sessionStore.listEntries();
        const scope = vscode.workspace
            .getConfiguration("pi-bridge.sessions")
            .get<string>("scope", "all");
        const cur = pi.getCwd();
        const filtered = scope === "current" ? all.filter((s) => s.cwd === cur || !s.cwd) : all;
        logInfo(
            `会话列表：scope=${scope} → ${filtered.length}/${all.length} 条` +
                (scope === "current" ? `（当前 cwd=${cur}）` : ""),
        );
        // ★★ B35：推给【独立面板】✗ 不再走侧栏 ✓
        //   ★ 连 currentCwd 一起给 ✗ 面板要用它把当前分组排最前 + 标「当前」✓
        deps.postPanel("sessionList", { list: filtered, currentCwd: cur });
    };

    /** ★ 刷新会话信息（★ 第二级 IO：读文件补名字 / 标异常 ✓）*/
    const refresh = async (): Promise<void> => {
        const stat = await sessionStore.refresh();
        void list();
        logInfo(`会话刷新完成：${stat.total} 个（${stat.named} 有名字 / ${stat.broken} 异常）`);
    };

    /**
     * ★ 新建会话（点 ＋）
     *
     * 【★ 这是"伪新建"】（实测确认 ✓ 用户点出来的）
     *   pi 的行为：new_session 只是换一个【预定路径】✓
     *   ★ 文件【不在磁盘上创建】✗ —— 真正发第一句话才落盘 ✓
     *   → 所以我们【不刷新会话列表】（文件还没建，列表里本来就不该有 ✓）
     *     它会在你发第一句话之后，下次刷新时才出现 ✓
     */
    const newSession = async (): Promise<void> => {
        // ★★ B35：绘画面板「点了就关」（点击即关 ✗ 不等结果 ✓）
        deps.closePanelAfterAction();
        try {
            const r = (await pi.sendRaw({ type: "new_session" })) as {
                success?: boolean;
                error?: string;
                data?: { cancelled?: boolean };
            };
            logInfo(
                `新建会话：success=${r.success} cancelled=${r.data?.cancelled}` +
                    (r.error ? ` error=${r.error}` : ""),
            );
            if (!r.success || r.data?.cancelled) {
                void vscode.window.showErrorMessage(`新建会话未成功：${r.error ?? "已取消"}`);
                return;
            }

            // ★ 清空界面（新会话是空的 ✓）+ 清通知（旧进程周期的事 ✓）
            chatState.reset();
            chatState.clearNotices();
            deps.postChat("noticesCleared", true);
            deps.postChat("snapshot", chatState.snapshot());
            // ★ 标题更新：新会话还没名字 ✓
            void deps.pushTitle("");
            logInfo("新建会话完成（文件将在首条消息时创建 ✓）");
        } catch (err) {
            logError(`新建会话失败: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`新建会话失败：${toErrorMessage(err)}`);
        }
    };

    /** ★ 给【当前会话】改名（点按钮行中间的标题区 ✓）*/
    const rename = async (): Promise<void> => {
        try {
            const st = (await pi.sendRaw({ type: "get_state" })) as {
                data?: { sessionFile?: unknown };
            };
            const file = st?.data?.sessionFile;
            if (typeof file !== "string" || !file) {
                throw new Error("拿不到当前会话文件（pi 还没启动？）");
            }
            const old = await sessionStore.findName(file);
            const name = await vscode.window.showInputBox({
                title: "修改会话名",
                prompt: "给这个会话起个名字（留空或取消 = 不改）",
                value: old ?? "",
            });
            if (name === undefined) return; // 取消 ✓
            const trimmed = name.trim();
            if (!trimmed) return; // 空 → 不改 ✓

            await pi.sendRaw({ type: "set_session_name", name: trimmed });

            // ★ 只更新缓存（不重读文件 ✓ 用户定的 ✓）
            await sessionStore.setName(file, trimmed);
            // ★★ B35：统一走 list ✗（它会推给独立面板 ✓）
            void list();
            void deps.pushTitle(trimmed);
            logInfo(`会话已改名：${trimmed}`);
        } catch (err) {
            logError(`改名失败: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`改名失败：${toErrorMessage(err)}`);
        }
    };

    /**
     * ★ 切换会话
     *
     * 【交互约定（用户定的 ✓）】
     *   · 同 cwd → 直接 switch_session（不重载 ✓）
     *   · 跨 cwd → ★ 先改 cwd + reload，再 switch_session ✓
     *     （cwd 是启动参数 → 必须重启子进程才能变 ✓）
     */
    const switchTo = async (sessionPath: string): Promise<void> => {
        // ★★ B35：绘画面板「点了就关」（同 newSession ✓）
        deps.closePanelAfterAction();
        const entries = await sessionStore.listEntries();
        const info = entries.find((s) => s.path === sessionPath);
        if (!info) {
            void vscode.window.showErrorMessage("找不到该会话文件");
            return;
        }
        if (info.broken) {
            void vscode.window.showErrorMessage(`该会话文件有问题：${info.broken}`);
            return;
        }

        try {
            if (info.cwd && info.cwd !== pi.getCwd()) {
                logInfo(`跨目录切会话：${pi.getCwd()} → ${info.cwd}`);
                pi.setCwd(info.cwd);
                await pi.reload(); // 用新 cwd 重启
            }
            logInfo(`切换会话：${sessionPath}`);
            await pi.sendRaw({ type: "switch_session", sessionPath });

            // ★ 清空当前界面 + ★ 重放该会话的历史消息 ✓
            //   （否则切过去是一片空白 ✗）
            chatState.reset();
            await deps.replay();
            // ★ 通知【跟着会话走】：切了会话就是另一个上下文了 ✓
            //   （用户定的：切换会话应该清通知 ✓）
            chatState.clearNotices();
            deps.postChat("cwd", { path: pi.getCwd(), short: compactHome(pi.getCwd()) });
            deps.postChat("noticesCleared", true);
            deps.postChat("snapshot", chatState.snapshot());
            // ★★ B35：会话列表走独立面板 ✗
            void list();
            // ★ 标题也要更新（用户报的 bug ✓）
            void deps.pushTitle();
            void vscode.window.showInformationMessage(
                `已切换到会话 ${info.name ?? info.id.slice(0, 8)}`,
            );
        } catch (err) {
            logError(`切换会话失败: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`切换会话失败：${toErrorMessage(err)}`);
        }
    };

    /**
     * ★ 克隆 / 分叉（B19）—— 都是本地处理（不走 formatMap ✓）
     *
     * 【为什么要在宿主侧做而不是前端直接发？】
     *   ① 分叉需要【先取 get_fork_messages】拿到 entryId ✗
     *      → 前端不知道 entryId ✓（get_messages 不返回 id ✓ 实测确认 ✓）
     *   ② 切完会话要【重放历史 + 刷新列表 + 改标题】✗ 这些都是宿主能力 ✓
     */
    const branch = async (opts: { isFork: boolean; userIndex?: number }): Promise<void> => {
        const label = opts.isFork ? "分叉" : "克隆";
        try {
            const cmd: Record<string, unknown> = { type: opts.isFork ? "fork" : "clone" };
            if (opts.isFork) {
                const fm = (await pi.sendRaw({ type: "get_fork_messages" })) as {
                    data?: { messages?: { entryId: string; text: string }[] };
                };
                const msgs = fm?.data?.messages ?? [];
                const target = msgs[opts.userIndex ?? -1];
                if (!target) {
                    logWarn(
                        `分叉失败：没有下标为 ${opts.userIndex} 的用户消息（共 ${msgs.length} 条）`,
                    );
                    void vscode.window.showWarningMessage("分叉失败：找不到对应的分界点");
                    return;
                }
                logInfo(`分叉锚点 [${opts.userIndex}]：${target.text.slice(0, 40)}`);
                cmd.entryId = target.entryId;
            }

            const res = (await pi.sendRaw(cmd as never)) as {
                success?: boolean;
                data?: { cancelled?: boolean };
                error?: string;
            };
            if (res?.success === false) throw new Error(res.error ?? "未知错误");
            if (res?.data?.cancelled) {
                logInfo(`${label}被取消`);
                return;
            }

            // ★ 切到了新会话（自动的 ✓）→ 和 switchTo 一样收尾 ✓
            chatState.reset();
            await deps.replay();
            chatState.clearNotices();
            deps.postChat("cwd", { path: pi.getCwd(), short: compactHome(pi.getCwd()) });
            deps.postChat("noticesCleared", true);
            deps.postChat("snapshot", chatState.snapshot());
            // ★ 列表要重扫：新文件刚生成 ✓
            await list();
            void deps.pushTitle();
            logInfo(`${label}完成`);
            void vscode.window.showInformationMessage(`已${label}为新会话`);
        } catch (err) {
            logError(`${label}失败: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`${label}失败：${toErrorMessage(err)}`);
        }
    };

    /**
     * ★ 删除一个会话文件（B21）
     *
     * 【流程（照抄官方 TUI ✓ 见 B21 文档）】
     *   ① 保护：它是不是【当前会话】？→ 是就拒 ✓
     *   ② 保护：它存不存在 ✓
     *   ③ 二次确认（原生 modal ✓）
     *   ④ 执行：trash ✓ → 回落 unlink ✓
     *   ⑤ 刷新列表（后端直接扫 ✓ 不等前端 ⟳）
     */
    const remove = async (sessionPath: string, name?: string): Promise<void> => {
        const label = name ?? sessionPath.split("/").pop() ?? sessionPath;
        try {
            // ① 不能删当前会话 ✗
            //   （pi 还拿着它的句柄 ✓ 删掉之后切回/重放会出怪事 ✓）
            if (pi.isStarted()) {
                const st = (await pi.sendRaw({ type: "get_state" })) as {
                    data?: { sessionFile?: unknown };
                };
                const cur = st?.data?.sessionFile;
                if (typeof cur === "string" && cur && resolve(cur) === resolve(sessionPath)) {
                    void vscode.window.showWarningMessage(
                        "不能删除当前正在使用的会话（先切到别的会话再删 ✓）",
                    );
                    return;
                }
            }

            // ② 存在性 + ③ 二次确认
            if (!existsSync(sessionPath)) {
                void vscode.window.showErrorMessage("找不到该会话文件（可能已经被删了）");
                await list();
                return;
            }
            const pick = await vscode.window.showWarningMessage(
                `确定删除会话「${label}」？`,
                {
                    modal: true,
                    detail: `${sessionPath}\n\n会先尝试移到回收站（trash / gio ✓）；如果都没有才会永久删除 ⚠`,
                },
                "删除",
            );
            if (pick !== "删除") {
                logInfo("删除会话：用户取消");
                return;
            }

            // ④ 执行（trash 优先 → unlink 回落 ✓）
            const result = await deleteSessionFile(sessionPath);
            if (!result.ok) {
                logError(`删除会话失败: ${result.error}`);
                void vscode.window.showErrorMessage(`删除失败：${result.error}`);
                return;
            }
            logInfo(`已删除会话（${result.method}）：${sessionPath}`);
            void vscode.window.showInformationMessage(
                result.method === "unlink"
                    ? "会话已永久删除（系统没有可用的回收站命令 ⚠）"
                    : `会话已移到回收站 ✓（${result.method}）`,
            );

            // ⑤ 列表刷新（后端自己扫 ✓）
            await list();
        } catch (err) {
            logError(`删除会话异常: ${toErrorMessage(err)}`);
            void vscode.window.showErrorMessage(`删除失败：${toErrorMessage(err)}`);
        }
    };

    /**
     * ★ 当前会话文件路径（没有则 undefined）
     *
     * 【★ 关键】若 pi 【未启动】就直接返回 undefined ✗
     *   不能为了问路而【懒启动】✗（用户还没发消息就不该把 pi 拉起来 ✓）
     */
    const currentFile = async (): Promise<string | undefined> => {
        if (!pi.isStarted()) return undefined;
        try {
            const st = (await pi.sendRaw({ type: "get_state" })) as {
                data?: { sessionFile?: unknown };
            };
            const file = st?.data?.sessionFile;
            return typeof file === "string" && file ? file : undefined;
        } catch (err) {
            logDebug(`取当前会话文件失败（忽略）: ${toErrorMessage(err)}`);
            return undefined;
        }
    };

    /**
     * ★ 导出会话（B21）
     *
     * 【为什么是"格式选择 + 保存路径"两步？】
     *   · jsonl 与 html 【不是平权的】✗：
     *       jsonl → 任意会话都能导 ✓（纯文件复制 ✓）
     *       html  → ★ 只能导【当前会话】✗（export_html 不接受 sessionPath ✗）
     *   · 而这个差别【必须说清楚】✗ → 自绘菜单写不下 ✓
     *   → 用原生 QuickPick（能带描述文字 ✓）而不是两个菜单项 ✓
     */
    const exportOne = async (sessionPath: string, name?: string): Promise<void> => {
        if (!existsSync(sessionPath)) {
            void vscode.window.showErrorMessage("找不到该会话文件");
            await list();
            return;
        }

        // ★ 它是不是当前会话？（决定 html 那条路能不能走 ✓）
        const cur = await currentFile();
        const isCurrent = !!cur && resolve(cur) === resolve(sessionPath);
        const base = (name ?? sessionPath.split("/").pop() ?? "session").replace(
            /[\\/:*?"<>|]/g,
            "_",
        );

        const pick = await vscode.window.showQuickPick(
            [
                {
                    label: "$(json) 导出为 JSONL",
                    detail: "原始记录，可以再导入回 pi（任意会话都可导 ✓）",
                    fmt: "jsonl" as const,
                },
                {
                    label: "$(file-media) 导出为 HTML",
                    detail: isCurrent
                        ? "可读、可分享的单页（带当前主题 ✓）"
                        : "★ 只能导出【当前正在使用的会话】✗ 这一条现在不可用",
                    fmt: "html" as const,
                    disabled: !isCurrent,
                },
            ],
            { title: `导出会话「${base}」`, placeHolder: "选择格式" },
        );
        if (!pick) return;

        if (pick.fmt === "jsonl") {
            const target = await vscode.window.showSaveDialog({
                title: "导出会话（JSONL）",
                defaultUri: vscode.Uri.file(`${base}.jsonl`),
                filters: { "pi 会话": ["jsonl"] },
            });
            if (!target) return;
            await fs.promises.copyFile(sessionPath, target.fsPath);
            logInfo(`导出会话（jsonl）：${sessionPath} → ${target.fsPath}`);
            void vscode.window
                .showInformationMessage(`已导出到 ${target.fsPath}`, "打开所在目录")
                .then((p) => {
                    if (p) void vscode.commands.executeCommand("revealFileInOS", target);
                });
            return;
        }

        // html（只能用 pi 的命令 ✓ 且只限当前会话 ✓）
        //
        // ★★ 这里必须【自己再拦一次】✗（不能只靠 QuickPick 的 disabled ✗）
        //   实测：disabled 只影响视觉 ✓ 用户【依然能点进去】✗
        //     → 于是弹了保存框 → 选完路径 → 导出的是【当前会话】而不是右键那条 ✗
        //       （用户看到的就是"流程走完了但文件没出现/不对"✗）
        //   ★ 教训：UI 的禁用【永远不可信】✗ 真正的约束必须在逻辑层 ✓
        if (!isCurrent) {
            logWarn("导出 HTML 被拒：不是当前会话");
            void vscode.window.showWarningMessage(
                "HTML 只能导出【当前正在使用的会话】✗\n先切到它，再导出 ✓",
            );
            return;
        }
        const target = await vscode.window.showSaveDialog({
            title: "导出会话（HTML）",
            defaultUri: vscode.Uri.file(`${base}.html`),
            filters: { HTML: ["html"] },
        });
        if (!target) return;
        // ★ pi 需要【懒启动】✗ —— export_html 得会话在跑才行 ✓
        const r = (await pi.sendRaw({
            type: "export_html",
            outputPath: target.fsPath,
        })) as { success?: boolean; error?: string };
        if (r?.success === false) {
            void vscode.window.showErrorMessage(`导出失败：${r.error ?? "未知错误"}`);
            return;
        }
        logInfo(`导出会话（html）：${target.fsPath}`);
        void vscode.window.showInformationMessage(`已导出到 ${target.fsPath}`);
    };

    /**
     * ★ 导入会话（B21）
     *
     * 【pi 完全没这个接口】✗（实测：无 import_session ✗）→ 只能自己做 ✓
     *
     * 【为什么要校验？】（用户："不检验一下，不拦一下吗？"✓）
     *   · 导入的是【外部文件】✗ 可能是别的东西（普通 jsonl / 日志 / 导出错的 ✓）
     *   · 不拦的话，它会成为一个进不去又删不掉的【垃圾条目】✗
     *     （切过去会报 Session file is not a valid pi session ✓）
     *   → ★ 入库前先验明：它到底是不是 pi 的会话文件 ✓
     *
     * 【放哪个目录？】
     *   当前 cwd 对应的会话目录 ✓（理由见 format-frontend.ts 的注释 ✓）
     */
    const importOne = async (): Promise<void> => {
        const picks = await vscode.window.showOpenDialog({
            title: "导入会话（选择一个 pi 会话 .jsonl）",
            canSelectMany: false,
            filters: { "pi 会话": ["jsonl"] },
        });
        if (!picks?.length) return;
        const src = picks[0].fsPath;

        // ★ 入库前校验（不做的话会造出"垃圾会话"✗）
        const check = await validateSessionFile(src);
        if (!check.ok) {
            logWarn(`导入被拒：${check.reason}`);
            void vscode.window.showErrorMessage(`这不是一个可用的 pi 会话文件：${check.reason}`);
            return;
        }

        // 目标：当前 cwd 的会话目录 ✓
        const dir = sessionDirForCwd(pi.getCwd());
        await fs.promises.mkdir(dir, { recursive: true });
        let target = path.join(dir, path.basename(src));
        // ★ 同名不覆盖 ✗（避免把已有会话干掉 ✓）→ 加后缀 ✓
        if (existsSync(target)) {
            const short = `${Date.now().toString(36)}`;
            target = path.join(dir, path.basename(src).replace(/\.jsonl$/, `-${short}.jsonl`));
        }
        await fs.promises.copyFile(src, target);
        logInfo(`导入会话：${src} → ${target}`);

        await list();
        void vscode.window.showInformationMessage(`已导入到当前工作目录的会话列表 ✓`);
    };

    return {
        open,
        refresh,
        list,
        newSession,
        rename,
        switchTo,
        branch,
        remove,
        exportOne,
        importOne,
    };
}
