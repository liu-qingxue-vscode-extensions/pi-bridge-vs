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
    // 以后在这里增加，例如：
    // | { kind: "setModel"; provider: string; modelId: string }
    ;

/** 转换函数：把前端消息变成 pi 认识的 RpcCommand */
type FrontendFormatter = (msg: FrontendMessage) => RpcCommand;

const formatMap: Partial<Record<FrontendMessage["kind"], FrontendFormatter>> = {
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
 * ★ 注意：通知板的 `noticeRemove` / `noticeClearAll` 【不在这里注册】
 *   （它们不是给 pi 的命令，而是给插件自己的；main.ts 会先拦下来 ✓）
 *   若不小心漏到这儿，白名单会报错 —— 正是我们想要的“早暴露”行为 ✓
 */
export function toRpcCommand(msg: FrontendMessage): RpcCommand {
    const formatter = formatMap[msg.kind];
    if (!formatter) {
        throw new Error(`format-frontend: 没有为 "${msg.kind}" 注册转换函数`);
    }
    return formatter(msg);
}
