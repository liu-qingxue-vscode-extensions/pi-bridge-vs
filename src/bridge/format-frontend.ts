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
    /** ★ 侧栏「☰ 会话」→ 打开【独立会话面板】（B35 ✓）
     *  ★ 会话面板已经搬到编辑器区 ✗ 侧栏只剩这个入口 ✓ */
    | { kind: "openSessions" }
    // ★★ B36：下面五个会话消息【不在这里了】✗
    //   refreshSessions / switchSession / deleteSession /
    //   exportSession / importSession
    //   ⇒ 它们【只有会话面板会发】✗ 所以：
    //     消息处理在 src/panels/session-host.ts ✓
    //     动作实现在 src/panels/session-actions.ts ✓
    //   ★ 为什么要删？→ 这个类型就是"聊天页会发什么"的契约 ✓
    //     把面板专属的混进来 ✗ 会让人以为"聊天页也会发它"✓
    //     （B35 我就是这样被误导的 ✗ 见 B35 第七节 ✓）
    //
    // ★ 克隆会话（B19）：整个会话复制成一个新文件 ✓ 无参数 ✓ 本地处理（不发 pi）
    | { kind: "cloneSession" }
    // ★ 分叉会话（B19）
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
    | { kind: "openSettings" } // 打开（或切到）设置面板（侧栏 ⚙ / 命令入口 ✓）
    /** ★★ B35：面板里的「重新读取」—— 重读磁盘并重推（不带“把面板叫到前面”的语义 ✓）*/
    | { kind: "reloadSettings" }
    // ★ 扩展交互回复桥（B25）：前端把用户的选择回给 pi ✓
    //
    // 【为什么不走 formatMap？】
    //   它不是 pi 的【命令】✗ 而是【对 pi 提问的回答】✓
    //   → 走 pi.replyExtensionUi → client.reply → 直接写 stdin ✓
    //     （pi 对 extension_ui_response 【不发回执】✗ 不能走 send ✓）
    | {
          kind: "uiResponse";
          id: string;
          /** select / input / editor 的返回值 ✓ */
          value?: string;
          /** confirm 的返回值 ✓ */
          confirmed?: boolean;
          /** 用户取消（Esc / 点取消 ✓）*/
          cancelled?: boolean;
      }
    // ★ B26：侧栏[前往] → 把编辑器交互面板弹到前面 ✓
    //   （也是一条【本地消息】✗ 不发 pi ✓）
    | { kind: "interactionFocus" }
    // ★ B27：拉命令列表（斜杠补全用 ✗ 问 pi 的 get_commands ✓）
    | { kind: "listCommands" }
    // ★ 供应商凭据（B24）：写的是 auth.json ✗ 不是 settings.json ✓
    | { kind: "addApiKey"; provider: string; key: string }
    | { kind: "removeAuth"; provider: string }
    | { kind: "saveSettings"; values: Record<string, unknown> } // 只含【改动过】的字段 ✓
    // ★ 技能面板（B25）—— 本地处理（扫目录 / 读 SKILL.md ✓）
    //
    // ★★ B35：侧栏只留【打开面板】这一个入口 ✓
    //   下面四个技能消息（skillDetail / skillToInput / skillAsCommand /
    //   skillInsert）【不属于这里】✗
    //   ⇒ 它们是【技能面板自己的通道】✓ 见 main.ts 里 SkillsPanel 的回调
    //     （那个回调【不转给 handleFrontendMessage】✗ 它自己处理 ✓）
    //
    //   ★★ 为什么要专门提醒？
    //     我把“技能动作后关面板”的代码加进 handleFrontendMessage 里了 ✗
    //     而技能面板的消息【永远走不到那里】⇒ 功能静默失效 ✓
    //     （用户实测：“注入 / 直接发送都没关闭”✓）
    //     把死消息类型删掉 ✗ 就不会再有人踩这个坑 ✓
    | { kind: "openSkills" }
    // ★★ B32：自由按钮容器（侧栏聊天页里的那根竖条 ✓）
    //   commandNew    → 用户点「＋」✗ 宿主去开配置页 ✓
    //   commandRun    → 点了一下按钮要执行（★ 有参数时先收集 ✓）
    //   commandDelete → 右键删除 ✓
    //
    // ★★ B33：带 parentId = 【在收纳器里】新建 ✓
    //   宿主据此告诉配置页“父亲是谁”✗ 以便锁死 type / command ✓
    | { kind: "commandNew"; parentId?: string }
    // ★ commandEdit → 右键「编辑…」（B32 ②）
    | { kind: "commandEdit"; id: string }
    | { kind: "commandRun"; id: string }
    | { kind: "commandDelete"; id: string }
    // ★★ B34：拖拽重排（同容器内 ✓ 跨容器是后面的事 ✓）
    //   before=true → 插到 targetId 前面 ✗ false → 后面 ✓
    | { kind: "commandMove"; id: string; targetId: string; before: boolean }
    // ★★ B35：这里原本还有 skillInsert ✗ 已删
    //   原因同上：那是【技能面板自己的通道】的消息 ✓
    //   （它和 handleFrontendMessage 没关系 ✗ 留着会让人找错地方 ✓）
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
