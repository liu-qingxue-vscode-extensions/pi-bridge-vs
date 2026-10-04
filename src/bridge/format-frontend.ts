/**
 * format-frontend —— 前端 → 后端（VS Code 侧）的转换层
 *
 * 【设计：表驱动 + 白名单】
 * - 只有登记在 formatMap 里的 "kind" 才能通过
 * - 未知 kind 直接抛错（宁可报错，也不要把非法数据发给 pi）
 *
 * 【迭代方式】
 * 第一步只有 prompt。以后加命令 = 在 formatMap 里加一行 + 在 HTML 里加对应的触发 UI。
 */
import type { RpcCommand } from "@earendil-works/pi-coding-agent";

/** 前端（webview）发给扩展宿主的消息 */
export type FrontendMessage =
    | { kind: "prompt"; text: string }
    // ★ 主动中断：对应发送按钮的“转圈”形态（点击转圈 = 中断 ✓）
    | { kind: "abort" }
    // ★ 通知板的【本地】消息 —— ★ 不是发给 pi 的，由 main.ts 直接处理，不进本层 ✓
    //   （唯一一条前端 → 插件的通知指令流 ✓）
    | { kind: "noticeRemove"; id: number }
    | { kind: "noticeClearAll" }
    // ★ 重启 pi 子进程（应用最新启动参数）—— 也是【本地】消息 ✓
    //   启动参数只能影响 spawn 时刻 ✗ → 改完设置要重启 pi 才生效 ✓
    | { kind: "reloadPi" }
    // ★ 会话管理（B15）—— 【本地】消息 ✓（由 main.ts 处理，不发 pi）
    | { kind: "newSession" }
    // ★ webview 的日志 → 输出面板（★ 与调试板无关 ✗）
    | { kind: "webviewLog"; level: "debug" | "info" | "warn" | "error"; text: string }
    // ★ 给当前会话改名（宿主弹输入框 + 发 set_session_name ✓）
    | { kind: "renameSession" }
    // ★ 拉取会话列表（打开面板时按需请求 ✓）
    | { kind: "listSessions" }
    // ★ 刷新会话信息（★ 第二级 IO：读文件补名字 ✓ 用户手动触发 ✓）
    | { kind: "refreshSessions" }
    // ★ 切换会话（同 cwd → 直接切；跨 cwd → 宿主会先重载 ✓）
    | { kind: "switchSession"; path: string; cwd: string }
    // ★ 克隆会话（B19）：整个会话复制成一个新文件 ✓ 无参数 ✓ 本地处理（不发 pi）
    | { kind: "cloneSession" }
    // ★ 删除会话（B21）：★ pi 没有 RPC 接口 ✗ → 扩展自己删文件 ✓
    //   照拄官方 TUI 的做法：trash CLI 优先 → 回落 unlink ✓（见 main.ts ✓）
    //   ★ 两个保护：不能删【当前会话】✗ + 必须【二次确认】✗
    | { kind: "deleteSession"; path: string; name?: string }
    // ★ 导出会话（B21）：把 .jsonl 复制到用户选定的位置 ✓
    | { kind: "exportSession"; path: string; name?: string }
    // ★ 导入会话（B21）：把外部 .jsonl 复制进【当前 cwd】的会话目录 ✓
    //
    // 【为什么导入要放到“当前 cwd”而不是让用户选目录？】
    //   · 导入的动机是“把它拿到这边来用”✓ 而你正在这边 ✓
    //   · pi 只认【当前 cwd 对应目录】里的会话 ✗（TUI 的会话列表是按 cwd 分的 ✓）
    //   · 放错 cwd 的目录 → 以后在 TUI 里根本看不到它 ✗
    //   → 默认放当前 cwd ✓ 并在提示里说清楚放哪了 ✓
    | { kind: "importSession" }
    // ★ 压缩上下文（B22）：★ pi 有 compact 命令 ✓ 直接转发 ✓
    //   （过程状态不靠回执 ✗ 靠 compaction_start / compaction_end 事件 ✓）
    | { kind: "compact" }
    // ★ 模型 / 思考深度（B23）—— 都是 pi 的原生命令 ✓
    | { kind: "setModel"; provider: string; modelId: string }
    | { kind: "setThinkingLevel"; level: string }
    // ★ 拉候选列表（本地处理，不走 pi 的 formatMap ✗）
    | { kind: "listModels" }
    | { kind: "listThinkingLevels" }
    // ★ 设置面板（B24）—— 全在本地处理（读/写 pi 的 settings.json ✓）
    //
    // 【为什么没有走 RPC？】实测：RPC 【完全没有】settings 接口 ✗
    //   （rpc-types.d.ts 里 grep "settings" 零命中 ✓）
    //   → 只能我们自己读写文件 ✓ 但要小心并发（见 pi/settings.ts 顶部注释 ✓）
    | { kind: "openSettings" } // 打开面板（或重新读）
    | { kind: "saveSettings"; values: Record<string, unknown> } // 只含【改动过】的字段 ✓
    // ★ 技能面板（B25）—— 本地处理（扫目录 / 读 SKILL.md ✓）
    | { kind: "openSkills" }
    | { kind: "skillDetail"; name: string }
    // ★ 技能内容的两个动作（B25）
    | { kind: "skillToInput"; content: string } // 填入输入框（本地 ✓）
    | { kind: "skillAsCommand"; name: string } // 发 skill:<name> 当命令 ✓
    // ★ 分叉（B19）：从【某个 AI 组末尾】切一刀 ✓
    //   userIndex = 该气泡前面有【几个】用户气泡（= get_fork_messages 的下标 ✓）
    //   ★ 注意：这不是“第几条用户消息”，而是【锚点下标】✓ 见 main.ts 的实现 ✓
    | { kind: "forkSession"; payload: { userIndex: number } }
    // ★ 点输入区下方的 cwd → 改工作目录（宿主弹原生输入框 ✓）
    | { kind: "changeCwd" }
    // 以后在这里增加，例如：
    // | { kind: "setModel"; provider: string; modelId: string }
    ;

/** 转换函数：把前端消息变成 pi 认识的 RpcCommand */
type FrontendFormatter = (msg: FrontendMessage) => RpcCommand;

const formatMap: Partial<Record<FrontendMessage["kind"], FrontendFormatter>> = {
    // ★ 压缩上下文（B22）：pi 原生命令 ✓ 无参数 ✓
    compact: () => ({ type: "compact" }),
    // ★ 模型 / 思考深度（B23）
    setModel: (msg) => {
        if (msg.kind !== "setModel") throw new Error("unreachable");
        return { type: "set_model", provider: msg.provider, modelId: msg.modelId };
    },
    setThinkingLevel: (msg) => {
        if (msg.kind !== "setThinkingLevel") throw new Error("unreachable");
        return { type: "set_thinking_level", level: msg.level } as never;
    },
    prompt: (msg) => {
        // 类型收窄：msg 在这里一定是 { kind: "prompt"; text: string }
        if (msg.kind !== "prompt") throw new Error("unreachable");
        return { type: "prompt", message: msg.text };
    },
    abort: (msg) => {
        if (msg.kind !== "abort") throw new Error("unreachable");
        return { type: "abort" };
    },
};

/**
 * 统一入口：前端消息 → RpcCommand
 * 未知 kind 抛错（白名单语义）
 *
 * ★ 注意：本地消息【不在这里注册】（它们不是给 pi 的命令，是给插件自己的）：
 *     noticeRemove / noticeClearAll / reloadPi
 *   main.ts 会先把它们拦下来 ✓
 *   若不小心漏到这儿，白名单会报错 —— 正是我们想要的“早暴露”行为 ✓
 */
export function toRpcCommand(msg: FrontendMessage): RpcCommand {
    const formatter = formatMap[msg.kind];
    if (!formatter) {
        throw new Error(`format-frontend: 没有为 "${msg.kind}" 注册转换函数`);
    }
    return formatter(msg);
}
