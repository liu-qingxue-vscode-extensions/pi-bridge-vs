> 批次 C / D / E + 可选项（未来工作）。上级索引：[ITERATION.md](./ITERATION.md)
> 不变量（架构决议 / 数据契约）见 [FACTS.md](./FACTS.md)

# 批次 C：命令扩展（前端 → 后端）

- [ ] `abort` 按钮（中断生成）
- [ ] `set_model` / 模型选择器
- [ ] `new_session` / 会话管理
- [ ] `compact`（压缩上下文）

# 批次 D：MyCmd（远期，实现方式待讨论）

- [ ] MyCmd 类型空间与通道设计
- [ ] 三层归宿：本层消化 / 翻译成标准命令 / 捆绑 pi 扩展（`-e` 加载）

# 批次 E：健壮性与发布

- [ ] pi 路径探测（配置项覆盖 + PATH/npm-global 等自动探测 + 版本检查告警）
- [ ] 工作区切换 / 多根工作区处理 + 重启 pi 命令
- [ ] `RpcExtensionUIRequest` 原生对话框桥（select→quickPick / confirm / input / notify）
- [ ] 打包 `.vsix`

# 可选项（非必须，视 UX 需要）

- [ ] 给命令加可见 UI 入口（`menus` 声明，如视图标题栏按钮）——目前命令只有快捷键 + 命令面板两个入口
