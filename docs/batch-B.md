> 批次 B：UI 迭代（进行中）。上级索引：[ITERATION.md](./ITERATION.md)
> 不变量（架构决议 / 数据契约）见 [FACTS.md](./FACTS.md)

# 批次 B：UI 迭代（进行中）

## 消灭进度表（本批次的核心台账）

> **“消灭”的定义**：一个 pi 数据包 → 变成真实 UI（能看见了）。
> **粒度必须到【顶层 type + 子类型】**，不能只看顶层 type：
> `message_update` 只是个信封，里面的 `assistantMessageEvent.type` 才是内容（共 11 种）。

### 已消灭 ✅（可加入 hiddenTypes 屏蔽）

| # | 数据包 | 渲染成 |
|---|---|---|
| 1 | `message_start` (role=user) | 右侧用户气泡（自适应宽度）|
| 2 | `message_start` (role=assistant) | 左侧 AI 气泡（开始）|
| 3 | `message_update › text_delta` | 正文气泡（流式追加）|
| 4 | `message_update › thinking_delta` | 思考气泡（灰色斜体 + 左线）|
| 5 | `message_update › toolcall_start/delta/end` | 工具气泡·上半（🔧 工具名 + 参数）|
| 6 | `message_start/end` (role=toolResult) | ★ 工具气泡·下半（用 `toolCallId` 跨消息关联）|
| 7 | `message_end` | 封口 |
| 8 | `message_update › thinking_start/end` | 思考折叠头（“正在思考…” → “已思考（用时 X 秒）”）|
| 9 | `agent_start` / `agent_settled` | 发送按钮形态（转圈 → 箭头）+ 空白期占位三点 |
| 10 | `tool_execution_start/update/end` | ★ 工具气泡·执行中（**实时流式输出** + 头部标签“执行中…”）|

**当前可屏蔽清单**（`pi-bridge.debug.hiddenTypes`）：
```json
["message_start", "message_update", "message_end",
 "agent_start", "agent_settled",
 "tool_execution_start", "tool_execution_update", "tool_execution_end"]
```

**渲染模型（与用户对齐的术语）**：一条消息 ≠ 一个视觉气泡。
每个内容段（思考/正文/工具）各是一个独立气泡；用户的每条消息是一个气泡。
工具气泡由「调用 + 结果」两部分拼成（同一外框、中间无线、各自背景色）——

### 22 项外观配置（`pi-bridge.style.*`）
宽度/圆角/内边距 · 8 个间距（气泡对）· 线 · 边框 · 5 个背景色（用户/思考/正文/工具上半/工具下半）
全部**留空 = 跟随主题**。改配置**实时生效**（不用重载）。

### 待消灭 ❌（都属于【非常规】：过程/环境，不进会话文件）

| # | 数据包 | 计划渲染成 | 优先级 |
|---|---|---|---|
| 11 | `message_end` 的 `stopReason` | 结束状态（`length` 截断 / `aborted` 中断 / `error` 出错） | 中 |
| 12 | `extension_ui_request`（`setStatus` 等） | 通知板 / VS Code 状态栏 | 中 |
| 13 | `stderr` | 通知板 | 中 |
| 14 | `turn_start` / `turn_end` | 回合分隔（可选） | 低 |
| 15 | `auto_retry_start` | 通知板“重试中…” | 低 |

> **归属判据**（见 FACTS.md）：**进会话文件的 → 对话区**；**不进文件的 → 状态条 / 通知板**。
> 11–15 全部不进文件 → 都归状态条 / 通知板。

> 注：`text_start` / `text_end` / `thinking_start` / `thinking_end` 前面曾归为“不单独消灭的边界包”，
> **B4 已推翻这个判断** —— `thinking_start/end` 实际承担了“计时”职责（→ 折叠头文案）✓

---

## 各批次详细记录

> 本文件原本包含全部批次详情（802 行 ✗）；已按批次拆到 `docs/batches/`，这里只留总览。

- **[B1 — 气泡 + 块渲染 + 工具 + 测试基础设施](./batches/B1.md)**
- **[B2 — 气泡模型重构 + 工具气泡 + 外观配置（已完成）](./batches/B2.md)**
- **[B3 — 输入区改造 + 状态指示 + 资源拆分（已完成）](./batches/B3.md)**
- **[B4 — 工具通用渲染 + 折叠体系（已完成）](./batches/B4.md)**
- **[B5 — 工具执行阶段（`tool_execution_*`）—— 消掉“实时输出”盲区](./batches/B5.md)**
- **[B6 — 前端工程化（webview 改用 TS + esbuild）](./batches/B6.md)**
- **[B7 — UI 打磨 + 两个 bug](./batches/B7.md)**
- **[B8 — 通知板（★ 设计已定，待实现）](./batches/B8.md)**
- **[B9 — 拆 webview TS（965 行 → 14 模块）](./batches/B9.md)**
- **[B10 — UI 优化清单落地（🔔 位置 / 配置项 / ✕ 修复 / 面板固定高度 / 调试板）](./batches/B10.md)**
- **[B11 — reload 按钮 + 启动参数懒读](./batches/B11.md)**
- **[B12 — 调试板升级（折叠规则两锚点 / 实时生效 / 总开关）](./batches/B12.md)**
- **[B13 — 通知面板修 bug + ★ 客户端封装层决策](./batches/B13.md)**
