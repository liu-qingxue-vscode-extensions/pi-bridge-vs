# UI-GUIDE —— 写前端代码时的规矩（B30）

> ★ **先读这段再往下看** ✗
>
> 我在 B25 把"HTML 注释必须用 `-->`"记进了 FACTS ✗ **然后 B25 又犯了一次** ✓
> 直到写了 `scripts/check-html.mjs` 在编译期拦 ✗ 才真正根治 ✓
>
> ⇒ ★ **文档救不了我** ✗ 能自动拦的必须写成脚本 ✓
> ⇒ ★ 这份文档只做两件事 ✗：
>   ① 记录**已被自动化拦住的**（附脚本名 ✓）
>   ② 记录**拦不住的**（附"出错时的症状"✗ 便于反查 ✓）

---

## 一、已被脚本拦住的（★ 不用记 ✗ 编译会报 ✓）

| 规则 | 拦截者 | 症状（如果拦不住会怎样）|
|---|---|---|
| HTML 注释必须 `<!-- -->` | `scripts/check-html.mjs` | 后面的元素被吞掉（B25 找不到 `#foot-model` ✓）|
| 标签配对 / id 重复 / 未知占位符 | 同上 | 元素渲染不出来 ✓ |
| 三个入口都能打包 | `scripts/build-webview.mjs` | 页面一片空白 ✓ |
| katex 字体齐全 | `scripts/sync-katex.mjs` | 公式变乱码方框 ✓ |

★ 改这几块时**不必小心翼翼** ✗ 编译会兜底 ✓

---

## 二、拦不住的（★ 这几条要主动想起 ✓）

### ① ★★ 高频事件里绝不能全量重绘

```
适用范围：focus / input / keydown(方向键) / scroll / mousemove

症状（真实踩过 ✗）：
  · focus 监听里调 redraw() → textarea 被换掉 → 【Enter 被吞】✓
    （用户："enter 没用了，必须去点那个按钮"✓）
  · ↑↓ 切选项时 redraw() → 输入框文字【在闪】✓
    （用户："我明明在上面切选项，下面输入框的文字在闪"✓）

正确做法：
  ★ 只改必要的高亮类（classList.toggle ✓）
  ★ 需要重算布局时用 requestAnimationFrame ✗ 不用同步重绘 ✓
```

### ② ★★ 异步流程里打"已处理"标记必须【同步】打

```
症状（真实踩过 ✗）：
  mermaid 的 data-mermaid-done 写在 await 之后 ✓
  → 三次 schedule 几乎同时跑 ✗ 都拿到同一批块 → 【图渲染了 3 次】✓

正确做法：
  ★ 取到列表后【立刻】打标记 ✗ 再进 await ✓
  ★ 重活加一把串行锁（busy 标志 ✓）
```

### ③ ★ 事件监听挂在【稳定父节点】上

```
症状：
  流式渲染会反复重建尾部 DOM ✗
  → 挂在子节点上的监听随节点一起消失 → 按钮点不动 ✓

正确做法：
  ★ 挂在 messagesEl 这类【永不重建】的祖先上 ✗ 用事件委托 ✓
  ★ 用 data-xxx 属性标记目标 ✗ 不要靠闭包捕获 ✓
```

### ④ ★ 状态与渲染分家（★ 这条最重要 ✗）

```
现状（我们自己定的 ✓）：
  src/interaction/state.ts   ← 纯状态 ✗ 零 DOM ✓
  src/interaction/views.ts   ← 只读 state 画 DOM ✓
  src/view/chat-state.ts     ← 纯状态（B1 就定的 ✓）

★★ 但有一层【没分干净】✗：
  · src/interaction/index.ts 里的键盘规则
    （"↑↓ 在选项和输入框之间循环" ✗ 它一边读 state 一边 querySelector ✓）
  · 这类"交互规则 + DOM 查询"混在一起的地方 ✗ 最容易出 bug ✓
    （B28 的"焦点在输入框里 → 键盘被吃掉"就是从这儿来的 ✓）

★ 写新 UI 时的建议 ✗：
  · 能写成纯函数的规则 → 尽量抽出来（输入 state → 输出新 state ✓）
  · 纯函数可以脱离界面测试 ✗ 混着 DOM 的只能手动点 ✓
```

### ⑤ ★ 目录约定（B29 定的 ✗）

```
media/            ★ 源：html / css（手写 ✗ 进 git ✓）
media/out/        ★ 产物：js / katex.css / fonts（生成 ✗ 忽略 ✓）
src/panels/       ★ 面板与扫描逻辑（B30 新开 ✗ main.ts 拆出来的 ✓）
src/view/         ★ VS Code 侧的视图类（ChatView / DebugPanel / InteractionPanel ✓）
src/webview/      ★ webview 侧的前端代码 ✓
src/pi/           ★ 与 pi 进程打交道的（client / rpc-client / settings / auth ✓）
```

### ⑥ ★ 新增一个前端板块的标准动作

```
① 状态放 state.ts ✗ 别塞在渲染函数里 ✓
② DOM 只由 views.ts 建 ✗ 事件处理里不 querySelector（尽量 ✓）
③ 事件委托挂 messagesEl 或面板根节点 ✓
④ 需要宿主动作（读文件 / 开面板 ✓）→ 走 postMessage ✗ 不在前端碰 fs ✓
   ★ 并且要在 src/bridge/format-frontend.ts 的联合类型里【登记】✓
     （否则 TS 会报 "no overlap" ✓ —— 这条实际上是被编译器拦住的 ✓）
⑤ 新加的消息 kind 要同步：format-frontend 类型 + main.ts 分支 ✓
```

---

## 三、为什么会有这份文档（背景 ✗）

```
★ 我们的 bug 分布（B25~B29 统计 ✗）：
   渲染层：约 90%（focus 吞 Enter / 闪 / 表格断开 / 重复渲染 / 缓存 ✓）
   逻辑层：约 10%（page 越界 / kbd 循环 / 脚注解析 ✓）

★★ 结论 ✗：逻辑层明显更干净 ✗ 因为它没有 DOM 可以乱来 ✓
   ⇒ 这正好印证了"状态与渲染分家"是对的 ✓
   ⇒ 也说明【以后新增 UI ✗ 应该优先把规则写成纯函数】✓
```
