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

## B1：气泡 + 块渲染 + 工具 + 测试基础设施

**状态**：代码完成，**未提交**（B 轮的第一次提交）

**目标**：发一条消息能完整看到一轮对话来回 —— 用户消息、思考、正文、工具调用与结果

### ① 气泡骨架 + text_delta（渲染主体）

- 新增 `src/view/chat-state.ts`：插件端【权威状态】`ChatState`
  - `bubbles: Bubble[]` + `onChange` 订阅 + `snapshot()` 全量快照
  - `apply(patch)` 统一入口，对 `append`/`endBubble` 做防御（无打开气泡 / 角色不匹配则忽略）
- `format-backend.ts` 的 `formatMap`（语义变更：从"兜底透传"改为"**聊天渲染专用**"，不关心的事件返回 `undefined`）
- `main.ts` 把一条流**扇出**给两个独立订阅者：
  ```ts
  pi.onEvent((event) => {
      debugPanel.log(event);              // 订阅者 1：原始数据（不翻译）
      const patch = toChatPatch(event);   // 订阅者 2：翻译后指令
      if (patch) chatState.apply(patch);
  });
  ```
- `chat-view.ts`：构造时订阅 `ChatState` → 增量推送；收到 `{kind:"ready"}` → 用 `snapshot()` 重放全量
- `chat.html`：气泡渲染（user 靠右 / assistant 靠左）+ 流式闪烁光标 + 自动滚底
  - `textContent` 而非 `innerHTML` → 天然免疫 HTML 注入
- **关键能力**：webview 被销毁重建后能恢复画面（状态在插件端）★

### ② 思考块（thinking）

- **气泡引入【块结构】**：`Bubble.text: string` → `Bubble.blocks: Block[]`
  - 原因：一条 assistant 消息的 `content` 是数组，可有多个块（由 `contentIndex` 区分）
  - `ChatPatch.append` 增加 `block` 字段：`{kind:"append", block:"thinking", text}`
- `format-backend.ts`：`message_update › thinking_delta` → `{kind:"append", block:"thinking"}`
- `chat.html`：块渲染规则 —— **只有最后一个块能续写**（类型一致追加，否则新建块）
  - 思考块视觉：灰色斜体 + 左侧线 + “思考”小标签（`::before` 实现）
- 教训：**“消灭”的粒度是（顶层 type + 子类型）**，写进度时必须诚实到这一层

### ③ 工具块 + 工具结果

- `BlockType` 加 `"tool"`；`Block` 加 `toolName` / `toolDone`
- `ChatRole` 加 `"tool"`（承载 `toolResult` message）
- `format-backend` 新增翻译：

  | pi 事件 | 翻译成 |
  |---|---|
  | `message_update › toolcall_start`（带 `toolName`） | `{kind:"toolStart", name}` |
  | `message_update › toolcall_delta` | `{kind:"toolArgs", text}` |
  | `message_update › toolcall_end` | `{kind:"toolEnd"}` |
  | `message_start/end` (role=toolResult) | `startBubble/endBubble` with `role:"tool"` |

- `chat.html`：工具块（🔧 工具名 + 参数 JSON，等宽）+ 工具结果气泡（等宽、紧凑、可滚动）
- **新增设置项 `pi-bridge.launchArgs`**（string 数组，默认空）：传给 pi 的额外启动参数
  - 主要用途：`["--no-extensions"]` 临时禁用守卫类扩展（否则工具执行会卡在审批上，
    因为本扩展还没做 `extension_ui_request` 的响应桥）
  - 修改后需**重载窗口**才生效（pi 子进程已启动）
- **验证**（`scripts/test-chat-state.mjs`，无需 UI）：
```
气泡[0] role=user        "读一下 demo.txt"
气泡[1] role=assistant   [tool] read  args={"path":"demo.txt"}     ← AI 请求工具
气泡[2] role=tool        "ENOENT: no such file or directory…"      ← 工具结果（失败也正确）
气泡[3] role=assistant   "好的，我来读取文件。"                    ← AI 基于结果继续
```

### ④ 调试板工具（导出 + 折叠计数）

- **导出 JSON**：工具栏按钮 → `showSaveDialog` → 写文件（缓冲全量）
  - 默认路径：**上次用过的**（存 `globalState`，改一次就固定）→ 首次默认工作区根目录 + 时间戳
- **忽略 = 折叠计数**（修正 A3 的语义）：
  - 命中 `hiddenTypes` 的类型**不再丢弃**，而是折叠成一行 `类型 × 条数`（黄色高亮）
  - 折叠保留【位置】和【数量】→ **时序语义不错乱**，只是不看详情
  - 连续同类型合并到同一个折叠段；中间插入其他类型则开新段
  - 折叠条目也进缓冲 → 导出时能看到“这里折叠了 N 条”
- **车厢模型**：每条数据 = 一节车厢（时间戳 + 类型 + 内容），有边界线
  - 折叠条目也是**完整车厢**（有自己的时间戳），不搭别人的车头
  - 时间戳由**宿主**记录（`Date.now()`）—— 前端渲染时刻不等于事件发生时刻
- 调试板视觉：按类别着色（`message_update` 蓝 / `message_start` 绿 / `extension_*` 橙 / 折叠 黄…），
  全部用 `--vscode-*` 主题变量（浅色/深色自动适配）

### ⑤ Bug 修复：用户消息不显示

- **根因**：用户消息是**非流式**的，内容只在 `message_start.message.content` 里
  - 最初的翻译器只取 `role` → 气泡永远是空的（没有 `text_delta` 给它补内容）
- **修复**：`message_start` 翻译器增加 `extractText(message.content)`
  - `extractText` 处理两种形态：字符串 / 块数组 `[{type:"text", text}]`
- **定位方法**：用调试板**导出 JSON** 取证（实测数据见 FACTS.md 的“数据契约”）

### ⑥ 测试基础设施（mock LLM，取代“拿真模型手测”）

| 脚本 | 作用 |
|---|---|
| `scripts/mock-server.mjs` | 手动起 mock LLM server（24 种行为可选） |
| `scripts/e2e-mock.mjs` | 端到端：起 mock + pi，打印完整事件序列 |
| `scripts/test-chat-state.mjs` | 验证 format + ChatState 的翻译结果（**无需 UI**） |
| `scripts/probe-abort.mjs` | 探测中断场景的事件序列 |
| `scripts/probe-session-persist.mjs` | 探测会话文件到底记了什么 |

依赖：`~/.pi/agent/models.json` 里的 `mock` provider（baseUrl `http://127.0.0.1:8123/v1`）

**收益**：协议/UI 测试从「30 秒 + 花钱 + 网络不确定」→「1 秒 + 免费 + 完全可复现」

### 踩过的坑（重要）

1. **测试脚本必须加 `--no-extensions`** —— 否则守卫类扩展（mode-guard）会把工具执行卡在审批上
   （表现为 `tool_execution_start` 之后就停住，且不会收到 `tool_execution_end`）
2. **`tool_call_success` + `repeatLast` 会死循环** —— 每轮 LLM 都返回工具调用；
   应改成序列 `[tool_call_success, success]`
3. **`npm i` 会清掉 `npm link` 的 pi 包** → 用 `npm link @earendil-works/pi-coding-agent` 恢复
4. mock 端口必须 **8123**（与 `models.json` 的 baseUrl 一致）
5. mock 包**没有 CLI**，只能通过库入口 `startMockLlmServer()` 调用
6. pi 的 `provider` 定义只能改 `~/.pi/agent/models.json`（**没有**环境变量覆盖 baseUrl 的机制）

### 后续（未做）

- [ ] 思考块默认展开是否合适？（长思考会占地方）→ 可选“完成后自动折叠”，实测再定
- [ ] `tool_execution_*` → 工具块上的“执行中…”状态（消除中间过程盲区）
- [ ] `stopReason` → 结束状态提示（`length` 截断 / `aborted` 中断 / `error` 出错）
- [ ] 状态条：`agent_*` / `turn_*` → 思考中 / 空闲
- [ ] 通知板：`extension_ui_request` / `stderr` / `auto_retry_start`
- [ ] 用户消息的乐观显示（发送即显示，不等 pi 回显）
- [ ] 长会话的消息区滚动优化（现在无条件自动滚底）
- [ ] （实测需要时）推送节流：合并高频 delta，减少跨进程 IPC + DOM 重排
- [ ] 用 `message_end` 的完整 `content` 校对累积的 delta（处理丢包）

---

## B2：气泡模型重构 + 工具气泡 + 外观配置（已完成）

**核心变化**：视觉模型从「一条消息 = 一个气泡（内含多个块）」
改成「**一个内容段 = 一个独立气泡**」（与用户的术语对齐）

### 渲染模型
- 每个内容段（思考 / 正文 / 工具）→ 独立 `.bubble`
- 用户的每条消息 → 一个 `.bubble.user`（**自适应宽度**、靠右）
- AI 气泡用固定宽度（流式无法预测最终宽度）

### 工具气泡（调用 + 结果 = 视觉上【一个】气泡）
- 实现：一个外框容器 + 内部两部分（上半=调用，下半=结果）
- 关键：`overflow: hidden` → 内部背景被外框圆角裁剪，中间无缝隙、无线条
- **跨消息关联**：`toolcall_start.assistantMessageEvent.id` = `toolResult.message.toolCallId` ✓
  （结果不建新气泡，而是按 `callId` 填回对应的工具块）

### 22 项外观配置（`pi-bridge.style.*`）
| 组 | 项 |
|---|---|
| 外观 | `bubbleWidth` `bubbleRadius` `bubblePadding` `userMinWidth` |
| 间距（气泡对）| `gapTurn` `gapUserFirst` `gapThinkingToText` `gapThinkingToTool` `gapTextToTool` `gapToolToText` `gapToolToThinking` `gapTextToThinking` |
| 线 | `railWidth` `railColorThinking` `railColorTool` `railColorResult` |
| 边框 | `borderBubble` `borderUser` `borderTool` |
| 背景 | `bgUser` `bgThinking` `bgText` `bgToolCall` `bgToolResult` |

- **全部留空 = 跟随 VS Code 主题** ✓
- 改设置**实时生效**（宿主监听 → postMessage 推 CSS 变量 → webview 改 `:root`，**不重建 DOM**）
- 实现：`src/view/style-config.ts`（设置 → CSS 变量）+ `html-loader` 注入占位符 `{{styleVars}}`

### 修掉的两个 bug
1. **用户气泡被误渲染成 `.bubble.text`** → `.bubble.user` 的全部样式（右对齐 / 自适应 / 独立背景）**从未生效** ✗
   - 教训：改 CSS 后必须确认**渲染时用了对应的 class**（不能只看样式写了没）
2. **stderr 挂载失败在激活阶段误报 error**（那时 pi 还没启动，挂不上是正常的）→ 改为静默 ✓

### 验证工具（无需 UI）
- `scripts/test-chat-state.mjs`：喂 mock 事件给 format + ChatState，打印气泡结构
  （已验证 `toolResult` 通过 `callId` 成功关联回工具块 ✓）
- `scripts/probe-toolresult.mjs`：探测 toolResult 消息的完整结构

---

## B3：输入区改造 + 状态指示 + 资源拆分（已完成）

### 输入区（参照 DeepSeek 风格）
- 上：输入区（无边框内嵌）；下：固定栏（右对齐的圆形发送按钮）
- 大圆角 + 悬空（底部留白）+ 渐变遮罩（消息可滑到框后面 = 无缝）
- **高度自适应**：最小/最大【**行数**】可配；行高从计算样式动态取（跟随字号变化 ✓）
- **发送按钮 = 状态**：`agent_start` → 转圈；`agent_settled` → 粗箭头（SVG）
  - `agent_end` **故意不处理**：它后面可能还有排队/重试 → 等 `settled` 才算真空闲 ✓

### 智能滚动（修了一个严重 bug）
- 原来每个 delta 都无条件滚到底 ✗ → AI 说话时无法往上翻（抖动、被强行拉回）✗
- 改为：**只在用户本来就在底部时才自动滚** ✓（往上翻了就不打扰）

### 居中内容列（新开关 `centerColumn`）
- `true`：气泡与输入框**同宽**（都用 `bubbleWidth` 作列宽）、居中；
  你的消息右对齐到内容列右边 ✓
- 实现：`padding-left/right = calc((100% - 列宽) / 2)` → 自动形成居中内容列 ✓
- 布尔开关不能当 CSS 变量 → 传特殊值 + webview 切 `:root.centered` 类
- **不删任何配置**：关闭时各项独立可调（逻辑合并，非删除 ✓）

### webview 资源拆分（架构变更 → FACTS 第 12 条）
- `media/chat.html`（仅 1.4KB 结构）+ `chat.css` + `chat.js`（debug 同样）
- loader 用 `asWebviewUri()` 注入 `{{css}}` / `{{js}}`；CSP 放开 `{{cspSource}}`
- 教训：**不要用正则解析 HTML** ✗（注释里的 `<style>` 字样会被误匹配，
  把 CSP meta 一并吃掉 ✗）——一次性任务就手工拆 ✓

### 配置新增
| 项 | 默认 | 说明 |
|---|---|---|
| `inputRadius` | 14 | 输入框圆角 |
| `inputWidth` | 100 | 输入框宽度（%，边界模式用）|
| `inputMinRows` / `inputMaxRows` | 1 / 8 | 输入框最小/最大行数 |
| `inputBottomGap` | 22 | 底部悬空高度 |
| `sideGap` | 12 | 气泡与视图左右边界的间距 |
| `centerColumn` | false | 居中内容列开关 |

### 修掉的两个 bug
1. **`ready` 时没重放 `styleVars`** → 布尔开关（centerColumn）在视图重建后
   “设置里开着、但视觉不生效” ✗
   - 教训：webview 重建时要重放【**所有**初始状态】（不只是消息快照）
2. **stderr 挂载失败在激活阶段误报 error**（那时 pi 还没启动）→ 改静默 ✓

---

## B4：工具通用渲染 + 折叠体系（已完成）

### ① 工具【通用渲染】（不丢字段）

**关键认知**：所有工具的执行模型是**统一的**，所以不需要为每个工具写渲染 ✗
```
    toolName + args(JSON)  →  result(content 数组)
```
| 部分 | 渲染方式 |
|---|---|
| **参数** | **键值对**（grid 两列，多行值续行自动对齐 ✓）—— 比原始 JSON 字符串好读 ✓ |
| **结果** | 按 content 元素的 **`type` 分发**：`text`→文本 · `image`→`<img data:...>` · 其他→JSON 兜底 |
| **状态** | 转圈（running）· ✓（ok）· ✗（error，来自 `isError`）|

**已确认 content 只有 4 种 type**（`text` / `thinking` / `image` / `toolCall`）；
工具结果通常只有 `text` / `image` 两种 ✓（没有 video/audio/document ✓）

**白名单特化**（bash→终端风、read→文件卡片、edit→diff）**后续再做**；
其他工具永远回落通用渲染 → 零维护 ✓

### ② 折叠体系（四处，行为一致）
| 位置 | 头部 | 收起效果 |
|---|---|---|
| 思考气泡 | ✳ 正在思考… / 已思考（用时 X 秒） | 隐藏思考内容 |
| 工具气泡 | 🔧 工具名 + 状态图标 | 隐藏全部内容（参数+结果）|
| 结果区 | ▾ 结果（文字可配）| 隐藏结果内容 |
| 参数行 | ▾ 参数名 | `line-clamp: 1` → 只显示第一行 ✓ |

- 箭头用 **SVG**（之前用字符 `˅` 太小 ✗），**放在名字前面**（短参数也不违和 ✓）
- 头部结构：名字串 = 一个按钮 + 右侧 `head-actions`【预留未来按钮位】（复制/重试…）
- hover 反馈统一：文字**下划线** ✓

### ③ 占位三点
- `agent_start` → 立即显示跳动的三点（不再空荡荡地等第一个数据包 ✓）
- 第一个真实内容到达 → 自动移除占位 ✓
- `thinking_start` → 开始计时；`thinking_end` → 头部变“已思考（用时 X 秒）”

### ④ 数据层改造（为通用渲染铺路）
```
    Block.args          参数【对象】（toolcall_end 时解析，不再传字符串）
    Block.resultParts   结果的 content 【数组】原样（不再拍平成文本）
```
`format-backend` 相应调整：`toolEnd` 带 `args`；`toolResult` 带 `parts`（content 数组）

### ⑤ 类型拆分
- 新增 `src/view/chat-types.ts`（80 行）：ChatRole / BlockType / Block / Bubble / ChatPatch
- `chat-state.ts` **207 → 144 行**（状态机与类型分离，改动时匹配范围更小 ✓）
- `chat-state.ts` 里 re-export 类型（旧 import 仍可用 ✓）

### ⑥ 新增配置（3 个）
| 项 | 默认 | 说明 |
|---|---|---|
| `thinkCollapsed` | false | 思考气泡默认收起 |
| `toolCollapsed` | false | 工具气泡默认收起 |
| `resultLabel` | "结果" | 结果区标题文字（留空隐藏 ✓）|

### ⑦ 修掉的 3 个 bug
1. **工具气泡被 flex 压扁成一条线** ✗
   - 根因：把 `#messages` 改成 flex 纵向容器后，子项默认 `flex-shrink: 1` → 内容一多就被压缩
   - 修：`.bubble { flex-shrink: 0 }` ✓
2. **参数名比它的值高半行** ✗
   - 根因：`inline-flex` 容器的 baseline = 它第一个子元素（SVG 箭头）的 baseline
   - 修：`align-items: baseline` → `start` ✓
3. **结果区丢失左缩进** ✗
   - 根因：结果元素被 append 到 `.bubble` 而不是 `.tool-body` → 跑到 padding 之外
   - 修：`(bubble.querySelector(".tool-body") || bubble).appendChild(...)` ✓

---

## B5：工具执行阶段（`tool_execution_*`）—— 消掉“实时输出”盲区

### ① 为什么这是盲区

三组事件各管一段，而中间那段【原本完全没渲染】✗：

```
toolcall_start/delta/end      LLM 生成参数（流式 JSON）            ✅ B2 已消灭
tool_execution_start/update/end   pi 真正执行工具                   ❌ B5 才消灭
   ↑ 这段里界面一动不动，用户不知道在跑还是卡死了
toolResult                    最终结果（作为一条消息）              ✅ B2 已消灭
```

### ② ★ 实测关键发现（动手前必须先测）

拿一个带输出的慢命令跑了一次，在调试板抓到 **11 个** `tool_execution_update`：

```
#1   len=   0    ""
#2   len=  26    "[02:26:20] 第 1 行 / 共 10 行\n"
#3   len=  52    “前 2 行”（从头开始的全文）        ★累积
#4   len=  78    “前 3 行”                        ★累积
...
#11  len= 261    “全部 11 行”                     ★累积
```

**两个结论**：
1. **`partialResult.content` 是【累积全文】，不是增量** ✗
   → 前端必须【整块替换】而不是追加 ✓（追加会重复一万遍 ✗）
2. **`partialResult.content` 的结构与 `toolResult.message.content` 完全同构** ✓
   → `[{type:"text", text}]` → **渲染层可直接复用 `renderResultParts()`** ✓ 零新渲染代码 ✓

> 配套工具：`scripts/inspect-debug.mjs` —— 解析调试板导出的 JSON，自动判定累积/增量 ✓

### ③ 三层实现

```
【format 层】tool_execution_start / update / end  →  toolExecStart / toolExecUpdate / toolExecEnd
【ChatState】Block 加两个字段：
              partialParts?: unknown[]   （执行中的实时内容）
              executing?: boolean
             toolExecUpdate 里【直接赋值】→ 实现“替换”语义 ✓
【渲染层】  ensureResultHost()      抽出结果区/折叠头的创建（原来内联在 renderResultParts）
             renderResultParts(..., streaming)  复用 ✓
             markStreamingDone()
【CSS】    .tool-result[data-streaming="true"] .result-label::before { content: "执行中…" }
```

**头部标签动态切换**：执行中显示“执行中…”，结束后变回“结果”（或用户配的文字）✓

**边界细节**：
- `#1` 是空 update（`content` 为空）→ 流式中不要显示“（无输出）”✗ 改为留空 ✓
- 状态图标在 `exec_end` 先定一次，`toolResult` 到达时再覆盖（后者更权威）✓

### ④ 验收

```bash
在聊天里：跑这个命令：for i in 1 2 3 4; do echo "[$(date +%T)] 第 $i 行"; sleep 1; done
```
→ 结果区【逐行冒字】✓ 头部显示“执行中…”✓ 结束后变“结果”+ 勾 ✓

---

## B5（续）：顶部状态栏 + 重连提示 + 中断按钮

### ⑤ 顶部常驻状态栏（手机式）

```
┌────────────────────────────────────────────────┐
│  ¥ 0  │  out 68  │  cache 93%  │  🔋▓▓▓░░ 62   │
└────────────────────────────────────────────────┘
   花费      输出token    缓存命中     对话长度（剩余 %）
```

- **数据源**：`message_end.message.usage` / `.model`（实测发现**每条 delta 也带 usage** ✓ 未采用）
- **分母（电池）**：新模块 `src/pi/model-limits.ts` 读 `models.json` 的 `contextWindow`
  - 拿不到 → 整块电池显示 `?` ✓（不写绝对 token ✗）
- **电池语义**：一个外形 + 内部填充 + 内部数字；★ 填充 = **剩余**%（越用越少）✓ 无 `%` 号
- **路径可配**：新模块 `src/pi/paths.ts` → `pi-bridge.piCliPath` / `pi-bridge.piAgentDir`（留空=自动探测）

### ⑥ 重连提示（`auto_retry_start` / `auto_retry_end`）

- 临时胶囊气泡，**不进快照** → webview 重建后自然消失 ✓（与字段语义一致）
- **同一批原地更新**：1/3 → 2/3 → 3/3 ✓
- 文案**复用 pi 原文**（`errorMessage` / `finalError`）✓
- 进行中 = 红色转圈；最终 = ✖ / ✓ / ■
- **实测字段**：`{attempt, maxAttempts, delayMs, errorMessage}` / `{success, attempt, finalError}`

### ⑦ 中断按钮

- 发送按钮**转圈时点击 = 中断** ✓（设计天然对应）；白名单放开 `abort` ✓
- ★ **中断 vs 成功的判定（重要）**：
  ```
  实测：中断与真成功【结构完全一样】✗
       { success:true, attempt:N }  且都【没有】finalError
  → 唯一判据是【前端自己的标志 userAborted】✓
  → 且清标志的时机很关键：实测时序 aborted 先到、auto_retry_end 后到 ✗
     若在 endBubble(aborted) 里清 → auto_retry_end 就误判成“成功”✗
     必须放到 agent_settled（必然晚于 auto_retry_end）✓
  → 另发现：agent_start 在【每次重试】都会发 ✗ 所以不能挂在它上面
  ```

### ⑧ 异常结束提示（`stopReason`）

- **只带 `length` / `aborted`，★ 不带 `error`** ✗
- 原因：重试过程中 pi 对**每次失败的尝试**都发 `message_end(stopReason="error")` 且**内容为空**，
  若也挂提示 → 会贴到**上一条正常回复**底部 ✗（重试失败的告知由重试气泡负责 ✓）

### ⑨ 调试板修复 + 分析工具

- **导出文件名**：原来记住的是**完整文件路径** → 连续导出同一个名字 → 覆盖 ✗
  → 改为只记**目录**，文件名用可读时间戳 `pi-debug-20261002-153349.json` ✓
- **新脚本** `scripts/analyze-debug.mjs`：总览（类型分布 + 消费进度对照）
- **新脚本** `scripts/schema-debug.mjs`：★ **按 type 提取字段 schema**（路径 / 类型 / 取值分布 / 是否可选）
- **新文档** `docs/PROTOCOL.md`：协议字段手册（13 个 type 的真实现状）

### ⑩ 本批修掉的 bug（9 个）

| # | 现象 | 根因 |
|---|---|---|
| 1 | 状态栏数字一直 0 | `format-backend` 漏了一行 `usage` 产出（edit 失败未重试 ✗）|
| 2 | 电池画反 | 填充用**已用%** ✗ → 改**剩余%** ✓ |
| 3 | 三点跑到用户消息**上方** | 用户气泡插入后未把占位挪回末尾 |
| 4 | 正常回复也显示“生成出错” | 见 ④ |
| 5 | “已中断”钻进重试气泡里 | `appendStopNote` 查找未排除 `.notice` |
| 6 | 中断被显示成“重连成功” | 见 ③ |
| 7 | 重连提示**复用**旧气泡 | 判据用 `attempt===1` ✗（实测 attempt 跨批次重置）→ 改用 `final` 状态 ✓ |
| 8 | 参数名比它的值高半行 | `inline-flex` 的 baseline 取【第一个子元素（SVG）】→ 改 `align-items: start` |
| 9 | 工具气泡被压扁成一条线 | `#messages` 改 flex 后子项默认 `flex-shrink:1` → 显式 `flex-shrink: 0` |

### ⑪ 已知 / 待办

- 僵尸气泡的修复（#7）**待复测** ✓
- `delayMs` 显示的秒数与实际略有差异（pi 侧问题，用户决定不修）

### ⑫ 下一步：★ 前端工程化

**背景**：本批 9 个 bug 中大多数源自**前端没有工程化** ✗：
```
media/chat.js  700 行单文件
  · 无类型（`p.text` 早就不存在了 → 界面默默显示 undefined）
  · 无契约（字段名靠人肉对齐）
  · 状态散在 5 个模块级 let → 生命周期靠约定 → 出僵尸气泡
  · 零测试 → 只能肉眼看
```

**方案**：webview 改用 **TS + esbuild**（HTML/CSS 不动 ✓）
```
src/webview/*.ts  →  esbuild  →  media/chat.js（产物）
★ 可直接 import type { ChatPatch } from "../view/chat-types.js"
  → 改了契约，前端不跟就【编译报错】✓
```
