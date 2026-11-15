

/**
 * B42:启动失败的原因(决定前端怎么提示)
 *   not-found     - 路径空 / 文件不存在 ⇒ 该弹"去设置"的通知
 *   startup-failed - 启动过程本身失败(崩溃 / 就绪探针超时...)
 */
export type PiStartError = {
    kind: "not-found";
    cliPath: string;
    message: string;
} | {
    kind: "startup-failed";
    cliPath: string;
    message: string;
}