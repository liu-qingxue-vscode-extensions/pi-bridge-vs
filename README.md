# pi-bridge-vs
<p align="center">
  <a href="README_EN.md">English</a> | <b>简体中文</b>
</p>
**让 VS Code 成为 [Pi](https://github.com/earendil-works/pi) 的前端,尝试让派获得更强的前端表现力，并且尝试找寻AI coding与手写编程平衡点**

Pi 是一个跑在终端里的 AI 编码代理。这个扩展把它的会话搬进 VS Code 侧边栏 ——
聊天气泡、工具调用、会话管理、命令栏全都在编辑器里，尝试让 Pi 获得更强的**前端表现力**

未来尝试探索 **AI coding 与手写编程的平衡点**,因此选择 VS Code/VS Codium

---

## 基本框架

```
┌─────────────────┐      ┌──────────────┐      ┌─────────┐
│  VS Code 侧边栏  │ ←──→ │  扩展宿主     │ ←──→ │  Pi     │
│  （webview）     │      │  （状态/渲染） │      │ （进程） │
└─────────────────┘      └──────────────┘      └─────────┘
        对话区              权威状态 + 数据翻译        执行工具
```

- **webview 是"显示器"**：没有状态，只有渲染。拔掉重建后由宿主重放快照恢复画面
- **宿主是"大脑"**：会话状态、数据翻译、面板管理都在这里
- **Pi 是"手"**：真正执行命令、读写文件

## 特性

### 渲染

#### 正文渲染


#### 工具渲染
| 工具 | 渲染 |
|---|---|
| `bash` | 终端样式（黑底 + 提示符 + 命令高亮），摘要行显示**命令主体**并按危险等级着色 |
| `read` / `write` | 路径行 + 代码块（按扩展名高亮 ✗ Markdown 直接复用正文渲染器 ✗ 带行号） |
| `edit` | **diff 渲染**（增绿删红 ✗ 用 Pi 给的 unified diff ✗ 行号自算） |
| 其他 | 通用键值对 + 结果按 content 类型分发 |

（bash 的命令解析在**宿主侧**做，用 `bash-parser` 出 AST —— 手写 shell 解析是无底洞。）

拖选文字时会自动不折叠；`0:0` 全折，`all` 不折。

#### 跳转编辑器 


### 面板与Pi自定义命令栏

- 命令栏：把常用命令做成按钮，支持分组拖拽排序
- **调试板**：抓 Pi 与宿主之间的原始数据包，出问题时导出一份就能定位
- 会话 / 设置 / 技能 / 交互面板,优良的交互设计以及明显强于TUI的表现力

## 安装

暂时缺少脚本

## 使用

1. 确保 `pi` 在 PATH 里（或者设置 `pi-bridge.piCliPath` 指向它）
2. 点侧边栏的 Pi 图标
3. 直接在输入框里对话 —— 工具调用会实时渲染成上面那些气泡

## 配置

**强调自由哲学**
设置里搜 `pi-bridge` 有 19 组（样式几乎全部可调）。常改的几项：

| 配置 | 默认 | 说明 |
|---|---|---|
| `pi-bridge.piCliPath` | `""` | `pi` 可执行文件路径（留空则用 PATH 里的） |
| `pi-bridge.style.toolFold` | 见上 | 工具块收起时显示多少 |
| `pi-bridge.style.codeAutoFit` | `true` | 代码块过宽时自动缩小字号（否则横向滚动） |
| `pi-bridge.style.bashBg` | `#000000` | bash 块的底色（清空则跟随主题） |
| `pi-bridge.style.centerColumn` | `false` | 内容列居中 |
| `pi-bridge.style.bubbleWidth` | `88` | 气泡最大宽度（%） |
| `pi-bridge.debug.enabled` | `true` | 调试板（`Ctrl+Alt+D`） |

## 架构速览

```
src/
├── main.ts              扩展入口 + 事件订阅（扇出到多个订阅者）
├── bridge/              ★ 纯逻辑层（无 vscode 依赖 ✗ 可单测）
│   ├── format-backend.ts    Pi 事件 → 内部 patch 格式
│   ├── replay.ts            会话文件 → patch 流
│   ├── tool-facts.ts        ★ 读 Pi 数据的唯一处（多通道字段收敛在这）
│   └── patch-reverse.ts     ★ unified diff 逆运算（重建"改前"）
├── view/                宿主侧状态与视图
│   ├── chat-state.ts        权威聊天状态（webview 是它的显示器）
│   ├── chat-view.ts         推快照 / 收前端消息
│   └── virtual-docs.ts      虚拟文档 provider（不落盘的内容也能在编辑器显示）
├── panels/              面板动作逻辑（每个面板一个 actions + host）
└── webview/             前端（浏览器里跑的部分）
    ├── apply.ts             消息分发 + 快照重放
    ├── tool.ts              工具气泡渲染 + ★ fillToolBubble（唯一填充入口）
    ├── tool-fold.ts         折叠规则
    └── code-fit.ts          代码过宽自动缩放
```


## 开发

```bash
npm run compile    # 检查 + tsc + 单测 + 打包 webview（F5 前会自动跑）
npm run watch      # tsc 监听
```

`compile` 里串了几个守门脚本，任何一步失败都会拦住构建：

| 脚本 | 守什么 |
|---|---|
| `check-html.mjs` | HTML 里的元素 id 与 JS 引用是否对得上 |
| `check-style-vars.mjs` | 声明的样式变量有没有人消费（三环：声明→映射→消费） |
| `check-patch-reverse.mjs` | diff 反推算法（7 个用例，含真实数据） |

**开发日志在 `docs/batches/`** —— 每轮一个文件，记录了当时的取舍和踩的坑
（比如"为什么用库而不是手写解析"、"为什么 CSS 变量里不能用分号当分隔符"）。
`docs/ITERATION.md` 是当前位置的索引。

## 许可

[AGPL-3.0](LICENSE)
