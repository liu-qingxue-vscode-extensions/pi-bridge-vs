> 批次 A：框架修正（已完成）。上级索引：[ITERATION.md](./ITERATION.md)
> 不变量（架构决议 / 数据契约）见 [FACTS.md](./FACTS.md)

# 批次 A：框架修正（已完成 ✓）

## A1：框架修正

- [x] **日志与数据分离**：DebugPanel 只收 pi 的真数据；本地日志走 OutputChannel（去掉了伪造的 `type: "local"`）
- [x] `cwd` 的 fallback 改用 `os.homedir()` + 日志提示
- [x] **pi 启动时机**：懒启动 + 幂等（复用 `startingPromise`）+ 就绪探针（`getState()`）
  - 官方 `start()` 重复调用会抛 `Client already started` → 保护在我们这层
  - 已用 `scripts/smoke-startup.mjs` 验证：幂等（10 并发只启 1 次）+ 探针可用
- [x] **ChatView 回调粒度**：`onPrompt(text)` → `onMessage(msg)`（扩展点集中到 format 表）
- [x] **协议两端对齐**：debug 的"清空"按钮已发 `postMessage({kind:"clear"})`
- [x] **`--no-session`**：扩展启动 pi 时不写会话文件（避免污染 TUI 会话列表 + 避免被外部工具破坏）

## A2：可维护性 / 安全加固

- [x] 统一的 `toErrorMessage(err: unknown)` 工具（`src/utils.ts`）
- [x] **HTML 外置**：`media/chat.html`、`media/debug.html`（编辑器高亮 + 易维护）
  - 读取用 `context.extensionUri`（不是 `__dirname`，tsc 不复制 .html）
  - `src/view/html-loader.ts` 负责读取 + 注入 nonce/cspSource
- [x] **webview CSP + nonce**：`default-src 'none'; style-src {{cspSource}} 'unsafe-inline'; script-src 'nonce-{{nonce}}'`

## A3：数据可见性

- [x] **调试板字段过滤**（黑名单）：VS Code 设置项 `pi-bridge.debug.hiddenTypes`
  - 当时的语义：列出的 type **不接收**（不进缓冲、不推送）
  - ⚠️ 该语义已在 **B1** 中修正为**折叠计数**（丢弃会让时序语义错乱）
- [x] **stderr 事件驱动**（方案 A：hook 官方私有字段 `client.process.stderr`）
  - 已验证：`scripts/smoke-stderr.mjs`（私有字段运行时可访问 + 事件驱动生效 + 与官方转发共存）
  - 挂载失败会告警（不崩）；将来官方改结构则可能失效（届时回退轮询 `getStderr()`）
  - 类型：`PiStderrLine = { type: "stderr"; text: string }` 已加入 `BackendOutput` 类型空间
  - 接线：`main.ts` 里 `pi.onStderr(...)` → 逐行拆开 → `debugPanel.log({type:"stderr", text})`

## A4：stderr 补历史

- [x] 挂载 stderr 监听时，**先拉一次 `getStderr()` 补历史**
  - 原因：官方在 spawn 后【立即】挂了监听，把启动期输出（扩展日志/警告）累积在字符串里；
    而我们挂得晚（要等 `getState()` 探针）—— 启动期那批只能靠拉取补上
  - 实现：`attachStderr()` 里【先拉历史 → 再挂监听 → 推送历史】
  - 已验证：`scripts/smoke-stderr.mjs`（补历史拿到 167 字符的启动期输出）
  - 已知微小竞态：[拉取历史 → 挂监听] 之间的极短窗口可能漏几个字节（诊断信息，可接受）
  - 模型澄清：**没有"错误池"** —— 历史累积在官方 `this.stderr` 字符串里（`getStderr()` 可取）；
    只有"流未被监听"时数据才会堆在 Node 流的内部缓冲

---
