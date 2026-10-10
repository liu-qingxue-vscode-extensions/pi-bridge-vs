/** types.ts —— 交互面板前端用的类型（B26）*/

/** 一个待答问题（由宿主从 extension_ui_request 推来 ✓）*/
export interface UiReq {
    id: string;
    method: Method;
    title: string;
    message?: string;
    options?: string[];
    placeholder?: string;
    prefill?: string;
    timeout?: number;
    /**
     * ★★ B33：来源 ✗
     *   pi    = 扩展在提问 ✓
     *   local = 我们自己的参数收集 ✓
     * ★ 只用来换文案 ✗ 不影响交互逻辑 ✓
     */
    source?: "pi" | "local";
    /** ★ B33：本地任务分组（只有 local 才带 ✗ 前端目前不用 ✓）*/
    taskId?: string;
}

/** pi 认识的四种需要回复的 method ✓ */
export type Method = "select" | "confirm" | "input" | "editor";

/**
 * 一个答复 ✓
 *   · select / input / editor → value
 *   · confirm               → confirmed
 *   · 用户取消               → cancelled
 */
export interface UiRes {
    value?: string;
    confirmed?: boolean;
    cancelled?: boolean;
}
