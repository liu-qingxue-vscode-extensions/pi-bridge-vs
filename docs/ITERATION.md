# 迭代清单 / 决策记录

> 讨论中定下的决定固化在这里，避免遗忘。迭代时按批次挑任务。

## 已冻结的架构决议（迭代基准）

1. **协议引擎**：官方 `RpcClient` + 我们自己的表驱动 format 层 + dispatcher
2. **后端 → 前端**：原样透传，双层兜底（后端 format default / 前端渲染兜底）
3. **调试板**：独立 panel + 命令/快捷键弹出，后台环形缓冲静默收集
4. **前端 → 后端**：白名单表驱动，`prompt` 起步，逐步增加
5. **MyCmd**：只留类型空间接口；实现方式待讨论（远期）
6. **RpcExtensionUIRequest**：先透传进调试板，后续做原生 UI 桥
7. **迭代节奏**：调试板 → 逐个"消灭"成 UI → 加命令 → 再加 UI
8. **数据分发模型**：**扇出/广播**（一个事件源 → 多个独立订阅者：调试板、聊天视图、日志），订阅者之间互不依赖、互不知晓（不是"串行管道"，也不需调试板中转）
9. **日志方案**：只用 `LogOutputChannel`（`createOutputChannel(name, { log: true })`）
   - VS Code 自动把内容写入它自己的日志目录（`Developer: Open Logs Folder` 可打开）
   - 自带分级（trace/debug/info/warn/error）+ 自动轮转/清理 → **无需自己写文件**
   - 不引入 winston 等依赖
10. **数据可见性原则**：pi 的**任何输出**（包括 stderr 的错误/诊断）都必须送到前端，**不得“捂着”**
    - 理由：用着用着突然报错，用户必须能立刻知道才能去修
    - stderr 要送到两个前端（调试板 + 聊天渲染）

## 已解决的重大外部问题（存档）

### 会话文件断链（2026-09-30 定位）
- **症状**：扩展创建的会话在 TUI 里打不开（空白）
- **根因**：`pi-web.service`（第三方 web 工具 `github.com/ygncode/pi-web`，由 npm 安装时的 postinstall 悄悄创建 systemd user service，常驻）
  - 它每轮对话后往 pi 的会话文件追加一行**不带 id** 的 `session_info`（带 `autoTitle:true` 标记）
  - → pi 加载时 `leafId = entry.id = undefined` → 后续条目 `parentId` 丢失 → 变成孤立新根 → 历史不可达
- **定位方法**：`pgrep -af pi-web`（一行命令）；先用 `grep` 搜索代码无果，因为它是**外部服务**而非 pi 扩展卡壳在文件层面
- **修复**：`systemctl --user stop/disable pi-web.service` + 用用户自己的脚本 `~/ai_script/session-repair/repair_pi_session.py --fix --all` 修复已损坏文件
- **安全启示**：systemd **user service 不需要 root**（`~/.config/systemd/user/`）→ 任何程序都能悄悄装常驻服务；定期用 `systemctl --user list-unit-files --state=enabled` 体检

## 待办

### 批次 A：框架修正（已完成 ✓）
- [x] **日志与数据分离**：DebugPanel 只收 pi 的真数据；本地日志走 OutputChannel（去掉了伪造的 `type: "local"`）
- [x] `cwd` 的 fallback 改用 `os.homedir()` + 日志提示
- [x] **pi 启动时机**：懒启动 + 幂等（复用 `startingPromise`）+ 就绪探针（`getState()`）
  - 官方 `start()` 重复调用会抛 `Client already started` → 保护在我们这层
  - 已用 `scripts/smoke-startup.mjs` 验证：幂等（10 并发只启 1 次）+ 探针可用
- [x] **ChatView 回调粒度**：`onPrompt(text)` → `onMessage(msg)`（扩展点集中到 format 表）
- [x] **协议两端对齐**：debug 的"清空"按钮已发 `postMessage({kind:"clear"})`
- [x] **`--no-session`**：扩展启动 pi 时不写会话文件（避免污染 TUI 会话列表 + 避免被外部工具破坏）

### 批次 A2：可维护性 / 安全加固（已完成 ✓）
- [x] 统一的 `toErrorMessage(err: unknown)` 工具（`src/utils.ts`）
- [x] **HTML 外置**：`media/chat.html`、`media/debug.html`（编辑器高亮 + 易维护）
  - 读取用 `context.extensionUri`（不是 `__dirname`，tsc 不复制 .html）
  - `src/view/html-loader.ts` 负责读取 + 注入 nonce/cspSource
- [x] **webview CSP + nonce**：`default-src 'none'; style-src {{cspSource}} 'unsafe-inline'; script-src 'nonce-{{nonce}}'`

### 批次 A3：数据可见性（已完成 ✓）
- [x] **调试板字段过滤**（黑名单）：VS Code 设置项 `pi-bridge.debug.hiddenTypes`
  - 语义：列出的 type 在调试板中隐藏（**接收时过滤**：不进缓冲、不推送）
  - 用途：某类型“消灭”成 UI 后加入黑名单 → 调试板只剩未完成类型 = 进度仪表盘
  - 选“接收时过滤”而非“展示时过滤”的理由：高频事件（`message_update` 一次回答数百条）会挤爆 500 条环形缓冲
- [x] **stderr 事件驱动**（方案 A：hook 官方私有字段 `client.process.stderr`）
  - 已验证：`scripts/smoke-stderr.mjs`（私有字段运行时可访问 + 事件驱动生效 + 与官方转发共存）
  - 挂载失败会告警（不崩）；将来官方改结构则可能失效（届时回退轮询 `getStderr()`）
  - 类型：`PiStderrLine = { type: "stderr"; text: string }` 已加入 `BackendOutput` 类型空间
  - 接线：`main.ts` 里 `pi.onStderr(...)` → 逐行拆开 → `debugPanel.log({type:"stderr", text})`

### 批次 B：UI 迭代（调试板 → 聊天视图）
- [ ] 第一个被消灭的类型：`message_update` 的 `text_delta` → AI 气泡
- [ ] `thinking` → 灰色思考区
- [ ] `tool_execution_*` → 工具卡片
- [ ] `agent_start` / `agent_settled` → 状态指示（思考中 / 就绪）
- [ ] 用户消息的乐观显示（发送即显示）
- [ ] 长会话的消息区滚动优化

### 批次 C：命令扩展（前端 → 后端）
- [ ] `abort` 按钮（中断生成）
- [ ] `set_model` / 模型选择器
- [ ] `new_session` / 会话管理
- [ ] `compact`（压缩上下文）

### 批次 D：MyCmd（远期，实现方式待讨论）
- [ ] MyCmd 类型空间与通道设计
- [ ] 三层归宿：本层消化 / 翻译成标准命令 / 捆绑 pi 扩展（`-e` 加载）

### 批次 E：健壮性与发布
- [ ] pi 路径探测（配置项覆盖 + PATH/npm-global 等自动探测 + 版本检查告警）
- [ ] 工作区切换 / 多根工作区处理 + 重启 pi 命令
- [ ] `RpcExtensionUIRequest` 原生对话框桥（select→quickPick / confirm / input / notify）
- [ ] 打包 `.vsix`

## 可选项（非必须，视 UX 需要）
- [ ] 给命令加可见 UI 入口（`menus` 声明，如视图标题栏按钮）——目前命令只有快捷键 + 命令面板两个入口
