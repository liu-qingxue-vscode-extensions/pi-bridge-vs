import * as piout from "./pi-type-gen.js"
import type { piPkgType } from "./pi-type-gen.js"
export type {
    RpcCommand,
    RpcResponse,
    RpcExtensionUIResponse,
    JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type {
    RpcCommand,
    RpcResponse,
    RpcExtensionUIResponse,
    JsonAgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

/**
 * B37:pi 侧[非协议输出](用户定的:调试板“防漏表”需要消费)
 *   调试板原来只看得到“协议包”而 pi 还会发两种[不发包]的东西:
 *     ① stdout 里混入的非 JSON 行
 *     ② 进程退出 / 启动失败
 *   ⇒ 它们也得往调试板发一份
 *
 * 单独用一个类型名(`pi_` 前缀 )在调试板里一眼能区分: pi/这是我们解析出来的协议
 * 它们[不是协议包]所以 toChatPatch 会返回 undefined 不会污染渲染
 */

/**
 * 来自 pi 进程 stderr 的一行(诊断信息 / 错误)
 *
 * 它不是 pi 的 RPC 协议消息,而是我们从进程的第三通道(stderr)捕获的.
 * 纳入类型空间的原因:它是 pi 对我们的输出,必须能被前端展示(不得被"捂着").
 */
export type PiStderrLine = { type: "stderr"; text: string };

export type PiLocalEvent = {
    /** 坏的pi std 输出行*/
    type: "pi_stdout_raw";
    text: string;
} | {
    /** Pi退出了 */
    type: "pi_exit";
    code: number | null;
    signal: string | null
} | {
    type: "pi_spawn_error";
    text: string
} | PiStderrLine;
const otherType = ["pi_stdout_raw", "pi_exit", "pi_spawn_error", "stderr"] as const;


/**pi的事件类型 */
export type PiAllEvent = RpcResponse | JsonAgentSessionEvent | PiLocalEvent;
export type PiAllEventHandler = (event: PiAllEvent,) => void;
export type stdOutEvent = RpcResponse | JsonAgentSessionEvent;

/** pi的事件的type的联合类型 */
type OtherType = "pi_stdout_raw" | "pi_exit" | "pi_spawn_error" | "stderr";
export type PiAllType = OtherType | piPkgType;


/** pi的事件的type的数组值 */
export const PI_ALL_TYPES = [
    ...piout.PI_RESPONSE_TYPES,
    ...otherType
] as const
/** 运行时校验:判断type字符是否合法 */
export function isPiType(s: string): s is PiAllType {
    return (PI_ALL_TYPES as readonly string[]).includes(s);
}
