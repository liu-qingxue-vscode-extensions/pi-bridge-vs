# pi 协议事实与架构决议（不变量）

> 这里放**不随迭代改变**的东西：已冻结的架构决议、pi 的数据契约、实测得到的事实、重大问题的存档。
> 迭代进度看 [ITERATION.md](./ITERATION.md)，各批次看 `batch-*.md`。

## 已冻结的架构决议（迭代基准）

1. **协议引擎**：官方 `RpcClient` + 我们自己的表驱动 format 层 + dispatcher
2. **后端 → 前端**：翻译层按"聊天渲染需要"挑选（不关心的事件返回 `undefined`）；
   调试板则收**原始数据**（不翻译）→ 两条流在 `main.ts` 扇出时分开
3. **调试板**：独立 panel + 命令/快捷键弹出，后台环形缓冲静默收集
4. **前端 → 后端**：白名单表驱动，`prompt` 起步，逐步增加
5. **MyCmd**：只留类型空间接口；实现方式待讨论（远期）
6. **RpcExtensionUIRequest**：先透传进调试板，后续做原生 UI 桥
7. **迭代节奏**：调试板 → 逐个"消灭"成 UI → 加命令 → 再加 UI
8. **数据分发模型**：**扇出/广播**（一个事件源 → 多个独立订阅者：调试板、聊天状态、日志），
   订阅者之间互不依赖、互不知晓（不是"串行管道"，也不需调试板中转）
9. **日志方案**：只用 `LogOutputChannel`（`createOutputChannel(name, { log: true })`）
   - VS Code 自动把内容写入它自己的日志目录（`Developer: Open Logs Folder` 可打开）
   - 自带分级（trace/debug/info/warn/error）+ 自动轮转/清理 → **无需自己写文件**
   - 不引入 winston 等依赖
10. **数据可见性原则**：pi 的**任何输出**（包括 stderr 的错误/诊断）都必须送到前端，**不得"捂着"**
    - 理由：用着用着突然报错，用户必须能立刻知道才能去修
    - stderr 要送到两个前端（调试板 + 聊天渲染）
11. **权威状态在插件端**（不在 webview）
    - 理由：VS Code 的 webview 在切走 tab 时会被**销毁** → 状态会丢
    - 因此 webview 只是“完全不长脑子的显示器”：状态在插件端维护，webview 重建时从快照重放
    - 三端生命周期互相独立：`pi 子进程`（插件端管）/ `插件端`（VS Code 管）/ `webview`（VS Code 管，可随时销毁）
12. **webview 资源拆分**：`media/<name>.html`（只放结构）+ `<name>.css` + `<name>.js`
    - 理由：早期把 CSS/JS 内联在 HTML 里 → 单文件巨大、编辑时容易匹配出错、无语法高亮
    - 加载：`html-loader.ts` 用 `webview.asWebviewUri()` 把 `{{css}}` / `{{js}}` 换成可加载 URI，
      CSP 放开 `{{cspSource}}`（否则外链资源被拦死）
    - 设置注入点 `{{styleVars}}` 放在 HTML 的内联 `<style>` 里（**CSS 文件不经 loader 替换，不能放占位符** ✗）

## 数据契约（实测，来自调试板导出）

> 来源：一轮对话 + 多轮对话的调试板导出（`/tmp/test/pi-debug-*.json`），
> 用 `hiddenTypes` 过滤 + 控制回复长度取得完整样本。

### 一轮对话的完整包序列
```
agent_start
  [extension_ui_request × n]        ← pi 扩展请求 UI（如 method:"setStatus"）
turn_start
  message_start (role=user)          ← ★ 用户消息【非流式】：内容就在 message.content 里
  message_end   (role=user)          ← 秒结束
  message_start (role=assistant)     ← content 此时是【空数组】
    message_update × N               ← 流式主体（见下）
  message_end   (role=assistant)     ← 带【完整】content + usage + stopReason
turn_end
agent_end
agent_settled
```

### `message_start` / `message_end` 的 `message` 结构
```jsonc
// user（含内容，非流式）
{ "role": "user", "content": [{ "type": "text", "text": "测试，返回我:太阳" }], "timestamp": ... }

// assistant（message_start 时为空，message_end 时是权威完整内容）
{ "role": "assistant", "content": [],
  "api": "openai-completions", "provider": "deepseek", "model": "deepseek-v4-flash",
  "usage": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
             "totalTokens": 8744, "cost": { "input": 0, "output": 0, ..., "total": 0 } },
  "stopReason": "pending" | "stop", "timestamp": ..., "responseId": ..., "rawStopReason": ... }
```
**要点**：`content` 是【块数组】，不是字符串。用户消息的文本必须从 `message_start.message.content` 取 —— 它没有 `text_delta` 补内容。

### `message_update.assistantMessageEvent`（11 种）
| 分类 | 事件 | `delta` | `content` | 说明 |
|---|---|---|---|---|
| 边界包 | `start` | — | — | 流开始 |
| 边界包 | `text_start` / `thinking_start` / `toolcall_start` | ❌ | ❌ | 块开始（只宣告结构） |
| **数据包** | `text_delta` / `thinking_delta` / `toolcall_delta` | ✅ | ❌ | **真正的流式增量** |
| 边界包 | `text_end` / `thinking_end` / `toolcall_end` | ❌ | ✅（toolcall 是 `toolCall`） | 块结束，附**完整**内容 |
| 边界包 | `done` / `error` | — | ✅（`message` / `error`） | 流终止 |

### `contentIndex` 语义（实测）
```
0 = thinking 块     （第二轮 16 条：1 thinking_start + 14 thinking_delta + 1 thinking_end）
1 = text 块         （第二轮 216 条：1 text_start + 214 text_delta + 1 text_end）
…后续更高 index 对应 toolcall 等
```
**一条 assistant 消息 = 多个块**，`contentIndex` 标识当前事件属于第几块。

### 实测的 delta 粒度
```
'太阳' / '二十' / '颗' / '星辰' / '的名称' …   ← 每条 1~4 个字 → 高频流
（单轮回复 200+ 条 text_delta 很常见 → 这也是调试板缓冲容易被挤爆的原因）
```

### 可用但尚未使用的字段（备选）
- `usage.totalTokens` / `usage.cost` → 未来做 token/花费显示
- `message_end` 的完整 `content` → 可用于**校对**累积的 text_delta（处理丢包）
- `extension_ui_request`（`method:"setStatus"` 等）→ 未来桥接到 VS Code 状态栏

### ★ `done` / `error` **不存在**于 RPC 事件流（实测，2026-10-01）

用 mock server 实测（`max_tokens` / `partial_disconnect` 场景）：

```
max_tokens 场景：
  message_start(assistant) → text_start → text_delta×9 → text_end
  → message_end stopReason=length      ← ★ 结束原因在这里！
  → turn_end → agent_end → agent_settled
（完全没有 message_update › done 或 error 事件）
```

**结论**：流的终止**不**通过 `message_update › done/error` 表达，而是通过
**`message_end.message.stopReason`**：

| stopReason | 含义 |
|---|---|
| `stop` | 正常说完 |
| `length` | 被长度截断（要提醒用户） |
| `toolUse` | 要去调用工具（→ 会有下一个 turn） |
| `aborted` | 被中断 |
| `error` | 出错 |

→ **所以“结束状态”要在 `message_end` 里取，不需要单独消灭 done/error** ✓

### `auto_retry_start`（实测发现的新事件）

mock `partial_disconnect`（发一半断连）场景下，pi **自己会重试**：
```
agent_start → turn_start → message_start → text_start → text_delta×n
→ （断连 reset）
→ auto_retry_start        ← ★ pi 自己发起的重试（新事件类型）
→ （重新）agent_start / turn_start / message_start …
```

### `toolcall` 的真实结构（实测）
```jsonc
// RPC 模式下 toolcall_start 带 id + toolName（ToJsonAssistantMessageEvent 追加的）
{ "type": "toolcall_start", "contentIndex": 0, "id": "mock-call-1", "toolName": "read" }
{ "type": "toolcall_delta", "contentIndex": 0, "delta": "..." }   // 参数 JSON 的片段
{ "type": "toolcall_end", "contentIndex": 0,
  "toolCall": { "type": "toolCall", "id": "mock-call-1", "name": "read", "arguments": {...} } }

// message_end 里工具调用是 content 的一个块：
content = [ { "type": "toolCall", "id": "mock-call-1", "name": "read", "arguments": {...} } ]
stopReason = "toolUse"

// 然后是真正的执行（另一组事件）：
tool_execution_start { toolCallId, toolName: "read", args }
```

### ★ 什么进会话文件、什么不进（实测，2026-10-01）

> 这是 UI 分层的**硬判据**：“进文件的 = 对话内容” 、“不进文件的 = 过程状态”。

| 信息 | 进会话文件？ | 验证方式 |
|---|---|---|
| 用户消息 | ✅ | `message role=user` |
| AI 消息（含 thinking / text / toolCall 块） | ✅ | `message role=assistant blocks=[thinking+text]` |
| 工具调用（toolCall 块） | ✅ | `blocks=[toolCall]` |
| 工具结果（成功/失败） | ✅ | `message role=toolResult`（失败体现在 content 里） |
| **中断状态** | ✅ | `stopReason=aborted`（附在 message 上） |
| **长度截断** | ✅ | `stopReason=length` |
| **出错** | ✅ | `stopReason=error` |
| 重试次数 / `auto_retry_start` | ❌ | 过程事件，不写文件 |
| `agent_*` / `turn_*` / `extension_ui_request` | ❌ | 同上 |
| 每一条流式 delta | ❌ | 只存合并后的最终 message |
| `stderr` | ❌ | 进程输出，不属于会话 |

**实测样本**（用 mock 的 `slow_success` + 中途 abort）：
```
[8] message role=user      "把数字念一遍"
[9] message role=assistant stopReason=aborted  blocks=[text] "一、二、三、四、五、"
（agent_start / turn_end / extension_ui_request / 5 条 text_delta 都不在文件里）
```

> 会话文件位置：`~/.pi/agent/sessions/--<cwd 转义>--/<时间戳>_<uuid>.jsonl`

## ★ 必须记住的协议陷阱（踩过 ✗）

### 1. streaming 时发 `prompt` 会被【静默丢弃】✗✗✗

```
实测（scripts/probe-steer-followup.mjs ✓）：
  跑着时发 { type: "prompt", message }
    → 回执 success: true      ← ★ 不报错 ✗
    → 但用户消息【不增加】✗    ← ★ 消息就这么没了 ✓
    → 前端【完全不会察觉】✗

★ 正确做法：busy 时改发 steer ✓
  steer      → queue_update 入队 ✓ → 下一 turn 投递 ✓（消息真的进去 ✓）
  follow_up  → 同样入队 ✓ 但等 agent 【完全停下】才投递 ✓

★ 但【空闲时发 steer】只入队 ✗【不投递】✗（实测 ✓）
  → 所以【必须判断忙/闲】✗ 不能永远用 steer ✓

★ 判断依据【只用 agent_settled】置空闲 ✗
  agent_end     = 这轮产出完毕 ✗ 但后面还有尾巴（重试/队列投递 ✓）
  agent_settled = 彻底空闲（重试、队列都空了 ✓）← 只有它 ✓
```

### 2. `queue_update` 事件官方类型【未收录】✗

```
实际会发 { steering: string[], followUp: string[] } ✓
但 JsonAgentSessionEvent 联合类型里没有 ✗（types 滞后于实现 ✓）
→ 需要显式收窄 ✓

★ 它的用途：“steering 里还有我的文本”= 还没被 AI 吃进去 ✓
  （排空 = 已投递 ✓）—— 这是实现“插话中” UI 的唯一依据 ✓
```

### 3. 命令白名单会把新命令悄悄拦掉 ✗

```
历史：PiClient.send 只放行 prompt / abort ✗ 其余抛错 ✓
后果：steer 被自己这层拦了 ✗ 而【报错只进日志】✗
      → 用户看到的就是“功能完全没效果”✗（排查绕了一大圈 ✓）
★ 现在：直接转发 ✓（类型层 + format 表两层白名单已足够 ✓）
★ 教训：拦截层【只报日志】＝ 在用户眼里就是“坏了”✗
```

### 4. `#input-area` 是 `position:absolute; bottom:0` ✗

```
它【沉在底部并盖在内容之上】✓
→ 任何放在它【后面的兄弟节点】都会被它遮住（看不见 ✗）
→ 要挂在输入区上方的东西【必须放进 input-area 内部】✓
   （顺带：syncPadding() 用 inputAreaEl.offsetHeight ✓ 会自动跟着涨 ✓）
```

### 5. ★ VS Code QuickPick 的 `disabled` 是【假禁用】✗

```
现象：QuickPickItem.disabled = true → 项目【确实变灰】✓
      但用户【依然能点进去并确认】✗（onDidAccept 照常触发 ✓）

★ 铁律：UI 的禁用【永远不可信】✗ —— 它只是装饰 ✓
      真正的约束【必须在逻辑层再校验一次】✗（踩过：导出 HTML ✓）
★ 对比：HTML button 的 disabled ✓ 浏览器会真的拦 click ✓（可信 ✓）
```

### 6. pi 会话目录的转义规则（导入/定位会话要用 ✓）

```js
// 来源：pi 的 dist/core/session-manager.js:242 getDefaultSessionDirPath
const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
// /home/liuqingxue          → --home-liuqingxue--
// /home/liuqingxue/Docs/简历 → --home-liuqingxue-Docs-简历--

★ pi 扇描会话目录的规则【只看后缀】✗：f.endsWith(".jsonl") ✓
  → 文件名格式不重要 ✓ 导入导出就是纯文件复制 ✓
```

### 7. pi 【没有】删除 / 导入会话的 RPC 接口 ✗

```
· delete_session  ✗ 不存在（TUI 里是前端自己删文件 ✓）
· import_*       ✗ 不存在
· export_html    ✓ 有，但★【只能导当前会话】✗（不接受 sessionPath ✓）

★ 删除要自己实现，且注意：
 官方只试 `trash` ✗ → 没装就 unlink 永删 ⚠
 而很多机器（如 KDE）只有 `gio trash` ✓ → 要多级回退 ✓
```

### 8. ★ pi 的模型目录在【两个文件】里（互补 ✗）

```
models.json       （用户手写）    { providers: { <prov>: { models: [...] } } }
models-store.json （pi 生成）    { <prov>: { models: [...] } }
★ 只读一个会缺内容：ollama 不全 · github-copilot 完全没有 ✓
★ 实测：models.json 的 ollama 5 个，models-store 里 github-copilot 34 个 ✓
→ 两个都读 + 按 provider/id 去重 ✓
```

### 9. ★ RPC 【没有】settings 接口（只能自己读写文件 ✗）

```
rpc-types.d.ts 里 grep "settings" → 零命中 ✗
pi 内部有 SettingsManager（getGlobalSettings / withLock … ✓）但没暴露 ✓
→ 自己读写 settings.json 时必须：
   ① 读-改-写（保存瞬间重读 ✗ 不能拿启动快照覆盖 ✓）
   ② 只改自己的字段 ✓ 未知字段原样保留 ✓
   ③ 原子写（temp + rename ✓）
★ pi 自己也在写这个文件（lastChangelogVersion 等 ✓）
```

### 10. ★ settings.json 里与我们相关的字段（实测清单 ✓）

```
defaultProvider / defaultModel / defaultThinkingLevel   ← 启动默认
enabledModels        ← ★ 就是用户说的“启用列表”✓（= scopedModels 的来源 ✓）
modelThinkingLevels  ← ★ 每个模型各自的思考等级（切模型自动选等级的依据 ✓）
compaction { enabled, reserveTokens, keepRecentTokens }  ← 自动压缩 + 阈值 ✓
steeringMode / followUpMode      ← 插话/追问投递模式 ✓
retry { enabled, maxRetries, baseDelayMs, provider{} }   ← 重试策略 ✓
sessionDir           ← ★ 会话目录（改了 pi 就写别处 ✓ 我们必须跟着改 ✓）
httpProxy            ← pi 请求 API 的代理 ✓
packages / extensions / skills / prompts / themes        ← 加载哪些资源 ✓
✗ TUI 专用（我们无关）：theme / markdown / hideThinkingBlock /
   showCacheMissNotices / tuiMode / terminal / showHardwareCursor …
   ★ showCacheMissNotices 【不会发数据包】✗ 是纯 TUI 显示开关 ✓
```

### 11. ★ 扩展 vs 依赖：看 package.json 有没有 `pi` 字段 ✗

```
~/.pi/agent/npm/package.json 的 dependencies 有【159 个】✗
但只有 9 个是真扩展 ✓（其余是依赖的依赖：ajv / better-sqlite3 …✓）

★ 判定：
   @mammothb/pi-mermaid   → "pi": { "skills": [...] }       ✓ 扩展
   @jamesjfoong/pi-ollama → "pi": { "extensions": [...] }   ✓ 扩展
   ajv                    → 只有 "main" ✗                     ✓ 依赖
```

### 12. ★ VS Code QuickPick 的 disabled 是【假禁用】✗

```
QuickPickItem.disabled = true → 项目确实变灰 ✓
但用户【依然能点进去并确认】✗（onDidAccept 照常触发 ✓）

★ 铁律：UI 的禁用【永远不可信】✗ —— 它只是装饰 ✓
      真正的约束【必须在逻辑层再校验一次】✗
★ 对比：HTML button 的 disabled ✓ 浏览器会真的拦 click ✓（可信 ✓）
```

### 13. ★★ 文本替换会【静默失败】✗ —— 改代码只用 edit 工具

```
bash / python 的 str.replace ✗
  → 没匹配上【不报错】✓ 也不提示 ✓
  → 看起来"改完了"✗ 实际根本没改 ✓

★ B23 踩了两次（都是用户先发现的 ✗）：
  ① 用 python 多插了一个 </div> → HTML 结构坏了 → 会话面板被挤出 top-area ✓
  ② 用 python 替换保存逻辑 → 没匹配上 → 文件被写成错配值 ✓

★★ 对策：改代码一律用 edit 工具 ✗
    它对 oldText 做精确匹配 ✓ 不匹配会【明确报错】✓
      （宁愿"没匹配上"✗ 也不要"静默改错"✗）
★ bash 只用于：查询 / 编译 / 一行的数据检查 ✓
```

### 14. ★ `#input-area` 是 `pointer-events: none` —— 新增子元素必须自己恢复

```
#input-area { pointer-events: none; }   ← 让渐变背景不挡鼠标 ✓
#input-box  { pointer-events: auto; }   ← 只有它和 #foot-bar 恢复了 ✓

★ 后果：任何【新加进 input-area 的子元素】如果不自己写 auto ✓
        → 会【继承 none】✗ → 整块区域【完全点不动】✓
          （B25 踩到：交互卡片成了"死卡片"✓ 用户报的 ✓）

★ 已恢复的：#input-box · #foot-bar · #queue-bar · #ui-request ✓
★ 以后往 input-area 里加东西，先想这一条 ✓
```

### 15. ★★ HTML 注释必须用标准结尾 ✗（这个坑复发了一次）

```
第一次（B8）：`<!-- … */` 未闭合 → 吞掉了 <div id="session-body"> ✓
第二次（B25）：同样写法 → 吞掉了 foot-model / foot-thinking 两个 button ✗
   → 表现成“找不到 DOM 元素”✓ 而且【完全不报错】✗ 极难定位 ✓

★ 记在文档里【不够】✗（我记过还犯 ✓）
★★ 必须【工具拦】✗ → scripts/check-html.mjs（接到 npm run compile ✓ 放最前 ✓）
   检查：注释配对 · 注释里误用 CSS 结尾 · 标签配对 · id 重复 · 未知占位符 ✓
```

### 16. ★★ 调试数据包【没有时间戳】✗ 不能从 index 推断时序（B26 踩的坑）

```
★ 我看到的：4 个 extension_ui_request 的 index 连续（1680/1681/1682/1683 ✓）
★ 我错误地断言：“背靠背发出 ⇒ 并行”✗✗✗

★★ 为什么错？
   串行时你在答题 ✗ pi 在 await ✗ 【期间没有任何事件】✗
   → 下一个 request 的 index 也是 +1 连续 ✓
   ⇒ ★【index 连续完全无法区分串行和并行】✗

★ 正确做法：
   · 看 tool_execution_start / tool_execution_end 之间的【时间】✗（导出里没有 ✓）
   · 或看 tool args 里有多少题 ✗（能知道“总共几题”✓ 但不知道发送方式 ✓）
   · ★ 最终靠【源码】定论 ✗（rpc-fallback.ts 的 for+await ✓）
```

### 16. ★★ HTML/CSS/JS 三件套必须【同级同前缀】

```
现象（B27）：改完 media/interaction.css ✗ 重开面板样式纹丝不动 ✓
根因：写到 media/css/interaction.css（子目录 ✗ 那是给 chat.css @import 的 ✓）
      而 html-loader 找 media/interaction.css ✗ → 404 ✓
★ 编译不报错 ✗ git status 看不出 ✗ 只有 ls 那个文件才会发现 ✓
⇒ 三个文件必须：media/<name>.html + media/<name>.css + media/<name>.js ✓
```

### 17. ★★ webview 会缓存 CSS/JS（要加 ?v=mtime）

```
现象：改了 media/*.css ✗ 重开面板样式不变 ✓
根因：VS Code webview 是真浏览器 ✗ asWebviewUri 的 URL 每次都一样 ✓
修：html-loader 里拼 `?v=<文件 mtime>` ✗ 文件一变 URL 就变 ✓
★ 不用 package version ✗ 改 CSS 不动它 ✓
```

### 18. ★★ webview 里的“虚拟等待页”与键盘越界

```
交互面板：page 允许 == totalPages()（一个虚构的“等下一题”位置 ✓）
★ 但它【不能手动走进去】✗（←→ 的最大值要减 1 ✓）
   否则下一题到达后 clamp 不回来 → 永远“等待下一个问题”✓
```

## 已解决的重大外部问题（存档）

### 会话文件断链（2026-09-30 定位）
- **症状**：扩展创建的会话在 TUI 里打不开（空白）
- **根因**：`pi-web.service`（第三方 web 工具 `github.com/ygncode/pi-web`，由 npm 安装时的 postinstall 悄悄创建 systemd user service，常驻）
  - 它每轮对话后往 pi 的会话文件追加一行**不带 id** 的 `session_info`（带 `autoTitle:true` 标记）
  - → pi 加载时 `leafId = entry.id = undefined` → 后续条目 `parentId` 丢失 → 变成孤立新根 → 历史不可达
- **定位方法**：`pgrep -af pi-web`（一行命令）；先用 `grep` 搜索代码无果，因为它是**外部服务**而非 pi 扩展卡壳在文件层面
- **修复**：`systemctl --user stop/disable pi-web.service` + 用用户自己的脚本 `~/ai_script/session-repair/repair_pi_session.py --fix --all` 修复已损坏文件
- **安全启示**：systemd **user service 不需要 root**（`~/.config/systemd/user/`）→ 任何程序都能悄悄装常驻服务；定期用 `systemctl --user list-unit-files --state=enabled` 体检

---
