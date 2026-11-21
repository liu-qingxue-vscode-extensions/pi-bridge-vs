# in-pi 扩展排查记录（2026-11-21）

> 结论先行：**故障不可复现，非代码缺陷**。留这份文档是为了下次遇到同样症状时不用重走一遍。

## 现象

模型调用 `vs_write` 时，pi 返回：

```
Tool vs_write not found
```

同时宿主侧偶尔能收到提案数据（说明工具确实执行过），但前端没有任何审核 UI 出现。
`vs_answer` / `vs_show` 同样不可用。

## 关键证据

pi 的 bundle 里有两处产生这句话，我们命中的是第二处（不带引号）：

```js
// 1. 带引号
if (!tool) throw new Error(`Tool "${toolCall.name}" not found`);

// 2. 不带引号 ← 我们命中的是这个
async function prepareToolCall(ctx, msg, toolCall, config, signal, tools = ctx.tools ?? []) {
    let tool = tools.find(t => t.name === toolCall.name);
    if (!tool) return { kind: "immediate", result: createErrorToolResult(`Tool ${toolCall.name} not found`), isError: true };
```

判断依据是 **`currentContext.tools`** —— 工具虽然 `pi.registerTool()` 注册成功（`pi.getAllTools()` 能看到），但没进这份运行时列表。

## 排除过程（全变量单点验证）

| 变量 | 试过的值 | 结果 |
|---|---|---|
| pi 版本 | 1.0.0 / 1.3.0 / 1.4.0 / 1.5.0 / 1.5.2 / 1.6.0 | 全部成功 |
| 代码版本 | 0.0.6 (a47d94f) / 0.0.7 (2a7b385) | 全部成功 |
| 扩展 | 全禁用 / 全部加载 / 单独加 `@juicesharp/rpiv-ask-user-question` / 加回 `my_pi_plugin` | 全部成功 |
| 启动参数 | 有 `--no-extensions` / 无 | 全部成功 |
| 模式 | full / standard | 全部成功 |
| 构建方式 | inline typebox / external typebox | 全部成功 |

最初失败的那套配置（1.5.2 + 0.0.7 + 全部扩展 + my_pi_plugin）后来**一模一样地复现，却是成功的**。

## 最可能的解释（都无法再验证）

1. **`rsync --delete` 的删除窗口**：回退软链时跑过 `rsync -a --delete`，会先删扩展目录的 `dist/` 再重建。pi 懒启动若正好落在那一瞬，`-e` 指向的文件不存在 → 加载失败。pi 失败后不重试，整个进程生命周期内工具都缺席。
2. **扩展加载顺序竞态**：某些扩展在 `before_agent_start` 里 `getActiveTools()` → `setActiveTools(...)` 整份写回（如 `@juicesharp/rpiv-ask-user-question`），若和 `-e` 扩展的加载顺序反过来，会把我们的工具抹掉一次。重启后顺序变化即恢复。

两者都符合"怎么重试都不行、重启一次就好"。

## 固化规则

> **pi 对扩展加载失败完全静默**——不打日志、不报错，工具凭空消失。
> 遇到 `Tool xxx not found`：
> 1. 先**重启 pi**（不是改代码）
> 2. 再检查 `-e` 指向的文件能否被 `import`（扩展目录里能否解析 `typebox` 等 external 依赖）
> 3. 最后才怀疑代码

## 有用的诊断手段

**确认扩展是否真的执行了**（在 `default(pi)` 函数开头写标记）：

```ts
try {
    writeFileSync("/tmp/in-pi-loaded.txt",
        `at=${new Date().toISOString()}\npid=${process.pid}\ncwd=${process.cwd()}\nargv=${process.argv.join(" ")}\n`);
} catch { /* 诊断用，失败无所谓 */ }
```

> 注意：pi 启动后会设置 `process.title = "pi"`，导致 `/proc/<pid>/cmdline` 只剩一个 "pi"，看不到真实参数。所以标记文件里的 `argv` 比 `/proc` 可靠。

**逐个工具包 try/catch**（避免一个 schema 出错连累其他工具）：

```ts
const reg = (t: Parameters<ExtensionAPI["registerTool"]>[0]): void => {
    try { pi.registerTool(t); }
    catch (e) { /* 记录错误 */ }
};
```

**验证工具能否真的被调用**（命令行，必须分两轮）：

```bash
# 第一轮让 agent 初始化完，再发第二轮才调得到工具
printf '%s\n%s\n' '{"type":"get_state"}' '{"type":"prompt","message":"hi"}' | pi --mode rpc -e <ext>
```

用 `--print` 模式测更快（但它跑完就退出，不存在"第一轮"这个概念，所以能绕过某些初始化问题）。

## 当前环境（写文档时的状态）

```
pi      1.5.2
代码    2a7b385 (0.0.7)
扩展    全部加载，含 my_pi_plugin
模式    standard
vs_write  正常
```

## 未完成

- [ ] 提案的四种 mode（`create` / `insertAfter` / `insertBefore` / `append`）只做过单元验证，未在真实审核流程里跑过
- [ ] 讨论区文字收集（`harvestReply`）未实测
- [ ] `vs-settings` 的缓存化已完成，但还有约 20 处 `getConfiguration` 未迁移
- [ ] `in-pi` 加载探针（`appendEntry("in-pi-loaded")` + 宿主超时告警）未实现

---

## 补充（同日，第二轮）

### 现象会反复出现，且随机

```
失败 → 换 pi 版本(1.0.0) → 成功 → 换回 1.5.2 → 成功 → 编译一次 → 失败
```

**同一份代码、同一份 1.5.2 安装，能成功也能失败。** 排查过并排除：

- 版本：1.0.0 / 1.3 / 1.4 / 1.5.0 / 1.5.2 / 1.6.0 全部能成功过
- 代码版本：0.0.6 / 0.0.7 都能成功过
- 扩展：全禁用 / 全加载 / 单独加 / 加回 my_pi_plugin
- 启动参数：有/无 `--no-extensions`
- 模式：full / standard
- 环境变量：`NODE_OPTIONS` / `NODE_PATH` / `PI_*` 全空，`ELECTRON_RUN_AS_NODE=1` 对真 node 无影响
- cwd：/tmp 与项目根都试过
- 扩展目录里的文件：md5 与项目 dist 完全一致
- `dist/in-pi/index.mjs`：存在、大小正常、含 vs_write

**唯一稳定的规律：每次成功都是"没重新编译"的时候，每次失败都跟在一次 `npm run compile` 后面。**

### 与 compile 的关联（未证实）

`scripts/f5/sync-to-ext.mjs` 这一步是：

```js
rmSync(destDist, { recursive: true, force: true });   // 整个 dist 先删
cpSync(join(ROOT, "dist"), destDist, { recursive: true }); // 再复制
```

这期间 `dist/in-pi/index.mjs` **完全不存在**。VS Code 会监视扩展目录、发现变化后自动重载扩展并重新 spawn pi；如果这次 spawn 正好落在删除与复制之间，pi 的 `-e` 加载会失败且完全静默。

**但这一条无法解释"手动 Reload Window 之后仍然失败"**，所以未定论。

### 临时处置（坏的时候怎么办）

1. `npm i -g @earendil-works/pi-coding-agent@<当前版本>` —— 重新安装同一个版本
2. Reload Window / 重启 pi
3. 再试

成功率不保证，但这是目前唯一有效的动作。**不要**在这上面继续改代码。

### 诊断极简扩展（已验证可用）

把 `src/in-pi/index.ts` 换成 20 行版本，能一刀切分清"加载问题"还是"内容问题"：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

console.error("[in-pi-test] module evaluated");

export default function (pi: ExtensionAPI): void {
    console.error("[in-pi-test] default() called");
    pi.registerTool({
        name: "vs_ping",
        label: "VS Ping (test)",
        description: "最小化测试工具。调用后返回 pong。",
        parameters: Type.Object({}),
        async execute() {
            return { content: [{ type: "text", text: "pong" }], details: {} };
        },
    });
    console.error("[in-pi-test] vs_ping registered");
}
```

实测结果：极简版能被加载并调用成功（返回 pong），说明**加载链路本身没问题**。
用 `pi --mode rpc` 在命令行跑同一文件，事件流里能看到完整 tools 数组含 `vs_write`，说明**扩展内容也没问题**。
