# HANDOVER —— 交接文档（写给下一位助手）

> 写于 B32 进行中。作者不敢再自称"接手顺畅"，所以这份文档写得尽量啰嗦。
> ★ **先读完这一份，再按第 3 节的顺序读其他文档。** 不要跳。

---

## 1. 这个项目是什么

**一句话**：把 `pi`（一个终端里的 AI 编码助手）包装成 VS Code 扩展，让 VS Code 当它的前端。

```
┌─────────────────────────────────────────────────────────┐
│  VS Code 窗口                                            │
│  ┌──────────────┐  ┌──────────────────────────────────┐ │
│  │ 左侧栏        │  │ 编辑器区                          │ │
│  │  #chatView   │  │  交互面板 / 技能面板 / 调试板      │ │
│  │  （我们自己   │  │  （独立 WebviewPanel）            │ │
│  │   造的 UI）   │  │                                  │ │
│  └──────┬───────┘  └──────────────────────────────────┘ │
└─────────┼───────────────────────────────────────────────┘
          │ postMessage（两条方向不通）
┌─────────▼───────────────────────────────────────────────┐
│  扩展宿主（Node 进程） src/main.ts                        │
│    · 权威状态 chatState（"显示器"没脑子，状态都在这）      │
│    · 表驱动 format 层：pi 的数据包 → 前端 UI 消息          │
└─────────┬───────────────────────────────────────────────┘
          │ RPC（stdin/stdout 的 JSON 行）
┌─────────▼───────────────────────────────────────────────┐
│  pi 子进程（@earendil-works/pi-coding-agent）             │
└─────────────────────────────────────────────────────────┘
```

**关键概念**（这几个词在代码和文档里到处都是）：

| 词 | 含义 |
|---|---|
| **气泡** | 一个可见的圆角矩形。用户消息 / 思考 / 正文 / 工具各是一个气泡 |
| **轮次（turn）** | 用户发一条 → pi 回一堆（思考+正文+工具调用+结果） |
| **快照（snapshot）** | 插件端的权威聊天状态。webview 重建后靠它恢复画面 |
| **调试板** | 一个独立面板，显示 pi 推来的**原始数据包**（不翻译） |

**技术栈**：TypeScript + esbuild（打包 webview 前端）+ tsc（编译扩展主体）。
没有框架、没有 UI 库 —— webview 里是手写 DOM。

---

## 2. 怎么跑起来（5 分钟上手）

### 路径

```
项目根      /home/liuqingxue/Projects/pi-bridge-vs
pi 包       ~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent
日志        <logUri>/pi-bridge.log
            （日志文件路径随 VS Code 版本变，调试时会自动清空 ✓）
```

### 三个必须知道的命令

```bash
npm run compile     # ★ 全量构建（改任何东西之后都要跑）
                    #   里面串了 5 个检查脚本，任何一个失败都会中断
npm run watch       # 只盯着扩展主体的 tsc（改 webview 前端不管用）
npm run watch:webview  # 只盯着 webview 前端（改 main.ts 不管用）
```

**★ `npm run compile` 的实际内容**（记住这个顺序，出错时能判断卡在哪）：

```
1. check-html.mjs        HTML 占位符 / 标签平衡 / 注释配对
2. check-style-vars.mjs  「配置项 → CSS 变量 → 实际消费」三环是否有断点
3. bundle-css.mjs        把 media/*.css 的 @import 展开成 media/out/*.bundle.css
                         ★ 顺带查 CSS 括号平衡（踩过一个大坑，见 §6）
4. sync-katex.mjs        拷 KaTeX 字体
5. tsc -p ./             编译扩展主体 → dist/
6. tsc -p tsconfig.webview.json --noEmit   只查类型（webview 前端）
7. build-webview.mjs     esbuild 打包 4 个 webview 入口 → media/out/*.js
```

### 调试

```
F5（或 launch.json 里的 "Run Extension"）
  → preLaunchTask 会先【清空上一轮日志】再编译（见 .vscode/tasks.json）
  → 起一个新的 VS Code 窗口，扩展以开发模式加载

看日志：输出面板（Ctrl+Shift+U），频道选 "pi-bridge"
★ 日志是分级的：debug 默认隐藏 ✓ 排查时把等级调下来看 ✓
```

### ⚠️ 一个必须记住的坑

```bash
# npm install 会清掉手工软链，装完必须重建：
mkdir -p node_modules/@earendil-works
ln -sfn ~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent \
        node_modules/@earendil-works/pi-coding-agent
```

---

## 3. ★ 文档地图（按这个顺序读）

这个项目文档很多，**不要乱读**。按下面顺序：

### 第一优先：必读三份

| 文档 | 讲什么 | 什么时候读 |
|---|---|---|
| **`docs/ITERATION.md`**（51 行）| **入口导航** + 当前状态 + 下一步 | 第一个读，30 秒看完 |
| **`docs/FACTS.md`**（523 行）| **不变量**：架构决议 / pi 数据契约 / 实测事实 / 重大问题存档 | 第二个读。★ 里面的"教训"章节解释了为什么代码长这样 |
| **`docs/UI-GUIDE.md`**（124 行）| ★ **写前端代码的规矩** | ★ 动手写任何前端之前读 |

### 第二优先：按需查

| 文档 | 讲什么 |
|---|---|
| `docs/PROTOCOL.md`（246 行）| pi RPC 协议字段手册（13 个 type 的字段+取值分布）。**自动生成**，可用 `node scripts/schema-debug.mjs test_date/*.json` 重生成 |
| `docs/batch-B.md` | 批次 B 的**台账**（"消灭进度表"：哪些 pi 数据包已经变成真实 UI 了）|
| `docs/batches/B*.md` | 每一轮的详细记录（30+ 份）。★ 想了解某个功能**为什么这样做**，搜对应批次 |
| `docs/design/B32-通用容器.md` | ★ **当前正在做的事**的设计文档（自由按钮容器）|

### 辅助

| 路径 | 讲什么 |
|---|---|
| `scripts/check-*.mjs` | ★ 编译期守门员。**它们拦住过的错误**就是最有价值的经验 |
| `scripts/test-ext/ui-bridge.ts` | 测试用 pi 扩展（注册了 6 个测试命令，见 §5）|
| `test_date/` | 真实抓包导出（调试板导出的 JSON），PROTOCOL.md 的数据来源 |

---

## 4. ★★ 当前状态（B32）

### 已完成

```
B31 及之前：全部完成并提交（最新 commit: 7e2bbd6）
            侧栏聊天 UI 基本完整：气泡/工具气泡/输入区/顶栏/通知板/调试板/
            会话管理/设置面板/技能面板/交互面板/Markdown 渲染

B32（未提交，37 个改动文件）：
  ✅ 自由按钮容器的外壳 —— 气泡区左侧一根竖条（#cmd-rail）
     · 位置：侧栏聊天页内部，跟气泡区同 top/bottom
     · 结构：外层 #cmd-rail（边框背景，盒子到底）
             内层 #cmd-rail-list（滚动区）
     · 滚动条隐形；overscroll-behavior: contain
  ✅ 配置项分组「pi-bridge：自由按钮容器」（在 VS Code 设置里）
     · style.cmdRailShow / cmdRailWidth / cmdRailBtnSize / cmdRailGap
     · commands.buttons —— 按钮数据（对象数组）
  ✅ 数据层 src/panels/command-store.ts
     · CmdItem / CmdField 类型定义
     · readCommands / writeCommands / buildCommandLine / normalizeItem
     · isImageIcon / isManagedIcon
  ✅ 配置页面 src/view/command-panel.ts + media/command.html + src/command/index.ts
     · 编辑器区独立 WebviewPanel
     · 名字/悬停/图标/命令（一行两个）+ 类型（按钮/收纳器）
     · 参数列表：一行一个，点「＋ 添加参数」就地展开编辑卡片
     · 参数三种类型：固定值 / 有限值可选 / 任意值（可限定数字）
     · 输入方式：串行弹窗 / 独立窗口（★ 独立窗口还没做，见下）
  ✅ 参数收集（串行）—— src/main.ts 的 collectSerial()
     · 循环 VS Code 原生 showQuickPick / showInputBox
     · fixed 不弹窗直接拼；中途取消则整条不发
  ✅ 无参数按钮：点一下直接注入 /命令
  ✅ 图标：三级源头（本地图片 / emoji / codicon / 名字首字）
     · 本地图片会复制到 <globalStorage>/icons/ 并清理旧图
```

### ★★ 未完成（按优先级）

#### ① 图标渲染不出来（★ 卡住的点，有完整证据）

```
现象：<img> 触发 error，Network 面板显示 401 Unauthorized (from service worker)

已排除的因素（都验证过）：
  ✗ 文件不存在          → ls 确认存在，334 字节的 SVG
  ✗ 白名单没设          → 日志打印了 3 个路径，globalStorage 在里面
  ✗ URL 格式不对        → asWebviewUri 的标准输出
  ✗ CSP 拦的            → 改成 img-src * 仍然 401
  ✗ SVG 有问题          → 纯 path，自包含

⇒ 结论：VSCodium 内部 "URL → 本地文件" 的授权链问题，扩展侧改不动

★★ 建议的解法：data URI（★ 用户已认可这个方向）
   推送时把 icons/xxx.svg 读成 base64 → "data:image/svg+xml;base64,..."
   → 跟命令列表一起 postMessage 进去 → <img> 直接渲染，不发网络请求
   加一个大小上限（比如 128KB）防止用户塞大图
   ★ 配置里仍然只存 icons/xxx.svg，不污染

   ★ 改哪里：src/main.ts 的 iconForWeb()（当前实现是 asWebviewUri）
```

#### ② 参数收集的「独立窗口」模式（假的）

```
现状：src/main.ts 的 commandRun 分支里
      if (item.inputMode === "panel") { logWarn("还没做，先用串行") }
      → 也就是说选了"独立窗口"实际还是走串行弹窗

★★ 用户的想法（已讨论过，认为可行）：
   复用【交互面板】（B26/B27 做的，src/view/interaction-panel.ts）
   它已经有 select / confirm / input / editor 四种控件
   参数收集只需要 select + input ⇒ 完全覆盖

   唯一要处理的是【来源】：
     pi 的请求   → 回复 extension_ui_response 给 pi（现状）
     我们自己的  → 拼装命令后注入输入框（要新增）
   ⇒ 给面板加一个 source: "pi" | "local" 字段就够了
   ★ 交互面板的"答卷模式"本来就是"一次填多题、一次性提交"，
     跟"一次填完所有参数"是同一个形状 ✓

   ★ 涉及文件：src/view/interaction-panel.ts（宿主）、
               src/interaction/index.ts（前端）、src/main.ts（接线）
```

#### ③ 收纳器（group）只是个壳

```
现状：能配置（名字+预设命令+强制开关），容器里会带个右下角小三角标记，
      但【点它什么都不做】（src/webview/cmdrail.ts 里只 log.info 一句）

要做（按用户的设计）：
  · 点收纳器 → 在气泡区上方【横向弹出】一排子按钮
  · 横向容器里最后一项【仍然是「＋」】
  · 往收纳器里加按钮时，type【锁定为 button】（不能再套收纳）
  · 如果父亲勾了"强制"，子按钮的 command 被锁死成父亲预设的那个
  · 往收纳器里加子按钮的入口 —— 用户说过是"横向容器里的那个＋"
```

#### ④ 假按钮残留

```
media/chat.html 里 #cmd-rail-list 现在是空的（真数据由 JS 渲染 ✓）
★ 但如果你发现容器里冒出一堆 emoji 假按钮，检查是不是某处又硬编码了
```

---

## 5. 测试用扩展（很重要，改参数相关功能时用）

`scripts/test-ext/ui-bridge.ts` —— pi 的一个扩展，注册了 6 个命令：

```
/uitest             依次触发 4 种交互（select/confirm/input/editor）
/uitest-batch       并发 3 个交互（测答卷模式）
/uitest-slow        串行 + 每问间隔 3 秒 × 4 回
/uitest-parallel    并发 5 个交互（测答卷模式 + 确认页）
★ /test-args        把收到的参数原样回报 ← 测自由按钮拼装对不对
```

★ 用法：`pi --ext <此文件> --mode rpc`（用户的启动参数里已经加载了它）

**`/test-args` 的用法**（验证自由按钮的参数拼装）：

```
/test-args                → 通知「无参数」
/test-args add write 42   → 通知「3 个参数：参数1 = add，参数2 = write，参数3 = 42」
原样回报，能看出有没有多空格、顺序对不对
```

---

## 6. ★★★ 踩过的坑（必读，能省你几小时）

### 坑 1：CSS 少一个 `}` → 后面全部 CSS 被吞

```
base.css 曾经少一个 } ✗
后果：后面所有 CSS 都被当成 :root 的嵌套规则
     document.styleSheets 顶层只剩 1 条规则
     部分选择器变成 :root #messages 仍然能匹配
     ⇒ 有些样式歪打正着还在，有些完全失效
     ⇒ 症状："好像只改了一半"，极难排查
★ 浏览器不报错（CSS 容错解析）
★ 已加防护：bundle-css.mjs 会查括号平衡
```

### 坑 2：CSS `@import` 的子文件带不上版本号 → 缓存

```
{{css}} → media/chat.css?v=<mtime>  ← 主文件永远新
但它 @import 的子文件 URL 写在 CSS 里 → 带不上版本号 → 被缓存
⇒ 主文件新 + 子文件旧 = "改了一半"
★ 已修：构建期展开成单个 media/out/*.bundle.css（只有一个 URL）
```

### 坑 3：开关类首屏不生效

```
CSS 变量是 HTML 静态注入的（<style>{{styleVars}}</style>）
但 centered 这类"开关类"只由 JS 的 applyStyleVars 切
⇒ 而 applyStyleVars 在首次加载时【根本不会被调用】
⇒ 所有开关类（centered / 折叠…）首屏全部失效
★ 已修：抽 classNamesFromVars()，html-loader 在服务端直接写 <html class="...">
```

### 坑 4：`post()` 包装器 vs 扁平消息（★ 两个方向的格式不同！）

```
前端 → 宿主：扁平 { kind, xxx }        ← format-frontend.ts 定义
宿主 → 前端：{ kind, payload }         ← chat-view.post 包装

★ 我在 cmdrail.ts 里用了 post("commandRun", {id}) → 变成 {kind, payload:{id}}
  而宿主读 msg.id → undefined → "找不到就 return" → 静默什么都不做
  症状：日志里只有一句"删除按钮：undefined"

★ 例外：编辑器区的独立面板（skills-panel / command-panel）
  有自己的私有通道，两边都统一用 payload 包 ✓
```

### 坑 5：switch 里 case 重名 → 后面的永远进不去

```
我加了 case "railCommands"，但一开始叫 "commands"
⇒ 跟 slash-menu 的命令补全列表同名
⇒ switch 第一个匹配就执行，斜杠菜单的 case 永远进不去
⇒ 症状：斜杠命令预选框突然消失
★ 现在容器用的是 railCommands ✓
```

### 坑 6：可选字段是静默失败的温床

```
SkillEntry.mine 一开始写成 `mine?: boolean`
构建时漏赋值 → TypeScript 完全合法，一声不吭
⇒ 所有技能都被当成"只读"
★ 修法：改成必填（`mine: boolean`）→ 漏了就是编译错误
★ 一般化：可选字段 / 可选参数 / 可选回调 = 静默失败高发区
```

### 坑 7：改代码不要用脚本做字符串替换

```
用 Python/str.replace 改现有代码 → 不匹配也不报错 → 静默失败
★ 改代码一律用 edit 工具（不匹配会当场报错）
★ 脚本只用来做"整体搬文件"那种机械操作
（我因此栽过三次：mine 字段、out 声明、scanDir 参数）
```

### 坑 8：UI 布局的两个必须

```
① 边距不能做成父容器的 padding
   改 padding → 改变内容区宽度 → 所有子元素跟着变（"耦合"）
   ★ 正确做法：边距下沉到元素自己的 margin

② flex 子项要能收缩
   滚动容器里如果内层 flex 子项没写 min-height: 0 → 根本不滚
```

### 坑 9：`elementFromPoint` —— 排查"谁挡住了谁"

```
当"看起来被遮挡但 CSS 又找不到原因"时：
  document.elementFromPoint(x, y) 直接问浏览器"这一点最上面是谁"
⇒ 比猜十次都快。见 src/webview/diag.ts 的 probeRail()
```

---

## 7. ★★★ 用户的工作方式（想合作愉快，这一节最重要）
### 关于质量标准

```
· 但★ 每次说"做完了"之前必须真的编译/验证过
  （我因为没编译就说做完了，被批评过多次）
· 出现 bug 时用户会实测并给截图/日志 → 认真读，不要猜
· ★ 卡住超过两三轮时，主动停下来讲清难点，跟用户一起想
  （用户非常愿意一起分析，但他讨厌你闷头瞎试）
```

### 用户的术语对照

```
"绘画/绘画面板"  = 会话
"块 / bubble"    = 气泡
"对话框"         = 输入框（textarea）
"顶栏"           = 顶部状态栏
"缩"             = 折叠
"加目录"         = ~/.pi/agent/（agent 目录）
"自由按钮容器"    = B32 正在做的东西（气泡区左侧那根竖条）
```

---

## 8. 下一步建议（给你一个开工清单）

```
① 先跑通
   npm run compile  →  应该零错误
   F5 启动          →  侧栏出现聊天界面
   在聊天里发一条消息，确认 pi 能跑

② 读三份必读文档（§3）
   ITERATION.md → FACTS.md → UI-GUIDE.md

③ 处理图标 401（§4 的 ①）—— 用户已认可 data URI 方向
   改 src/main.ts 的 iconForWeb()
   ★ 这是唯一"卡住"的功能，其它都能用

④ 做参数收集的「独立窗口」（§4 的 ②）
   用户建议复用交互面板 + 加 source 字段

⑤ 做收纳器的横向展开（§4 的 ③）

⑥ 全部做完后提醒用户提交
   （commit message 格式参考 git log：`3.3.33: B32 > 自由按钮容器（...）`）
```

---

## 9. 快速参考

### 关键文件（按重要性）

```
src/main.ts                      ★ 大管家（1700+ 行），所有接线都在这
src/view/chat-view.ts            侧栏视图（webview 生命周期 + post）
src/webview/apply.ts             ★ 所有"宿主→前端"消息的统一入口
src/bridge/format-frontend.ts    前端消息的类型定义（白名单）
src/webview/dom.ts               所有 DOM 元素引用（集中一处）
src/pi/rpc-client.ts             跟 pi 进程的通信层
src/panels/command-store.ts      ★ B32 数据层（自由按钮）
src/view/command-panel.ts        ★ B32 配置页面（宿主）
src/command/index.ts             ★ B32 配置页面（前端）
src/webview/cmdrail.ts           ★ B32 容器渲染（前端）
media/css/cmdrail.css            ★ B32 容器样式
```

### 目录约定

```
media/           源文件（html / css，进 git）
media/out/       构建产物（js / bundle.css / 字体，gitignore）
src/view/        VS Code 侧视图类（继承 WebviewViewProvider / 手写 panel）
src/webview/     侧栏聊天页的前端
src/command/     配置页面的前端（B32）
src/skills/      技能面板的前端
src/interaction/ 交互面板的前端
src/panels/      面板的纯逻辑（扫描 / 读写 / 工具函数）
src/pi/          跟 pi 进程打交道
```

### webview 入口（build-webview.mjs）

```
src/webview/index.ts      → media/out/chat.js         侧栏
src/interaction/index.ts  → media/out/interaction.js  交互面板
src/webview/mermaid-entry.ts → media/out/mermaid.js   （按需加载）
src/skills/index.ts       → media/out/skills.js       技能面板
src/command/index.ts      → media/out/command.js      配置页面（B32）
★ 加新入口要同步改：build-webview.mjs + tsconfig.webview.json
```

---

**祝顺利。这个项目的代码本身是干净的（有守门员脚本、有分层日志、文档齐全），
难的部分是跟上用户的节奏和思维方式 —— 那部分看第 7 节。**
