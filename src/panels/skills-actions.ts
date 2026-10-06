/**
 * skills-actions.ts —— 技能领域的【动作】（B36 ✓）
 *
 * 【★ 它解决什么问题？】
 *   原来这些动作全长在 main.ts 里（6 个函数 + 2 段内联逻辑 ✗ 约 180 行 ✓）
 *   ⇒ main.ts 既管接线又管业务 ✗ 越滚越大 ✓
 *   ⇒ B36 把它们按【领域】搬出来 ✓
 *
 * 【★ 和 skills-host 的分工】
 *   skills-host.ts   消息 → 动作的【映射】（哪个 kind 调哪个动作 ✓）
 *   skills-actions.ts 动作的【实现】（读盘 / 写盘 / 弹窗 / 推消息 ✓）
 *   ★ 这样“技能的事”只在这两个文件里 ✗ 不会再散在 main.ts 各处 ✓
 *
 * 【★ 依赖注入】
 *   推消息的两个出口由外面传进来 ✗ 因为宿主才知道面板与聊天页是谁 ✓
 *     post      → 推给【技能面板】（skills / skillToast / skillsRefresh ✓）
 *     postChat  → 推给【聊天页】（insertToInput / sendText ✓）
 *   （跟 panels/settings-post.ts 的工厂套路一致 ✓ 见 B30 ✓）
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readSkills } from "./skill-scan.js";
import { deleteSessionFile } from "../pi/session-store.js";
import { logError, logInfo, logWarn } from "../logger.js";
import { toErrorMessage } from "../utils.js";

export interface SkillsActionsDeps {
    /** 推给技能面板（宿主侧 panel.post ✓）*/
    post: (kind: string, payload: unknown) => void;
    /** 推给聊天页（chatView.post ✓）*/
    postChat: (kind: string, payload: unknown) => void;
}

export interface SkillsActions {
    /** 扫技能 → 推给面板（含"单击行为"/隐藏过滤 ✓）*/
    refresh(): Promise<void>;
    /** 在 VS Code 编辑器里打开 SKILL.md（reveal = 只在文件管理器定位 ✓）*/
    openFile(name: string, reveal: boolean): Promise<void>;
    /** 删除技能（整个目录进回收站 ✓ 二次确认 ✓）*/
    remove(name: string): Promise<void>;
    /** 隐藏（只是不显示 ✓ 可恢复 ✓）*/
    hide(name: string): Promise<void>;
    /** 新建技能（输入名字 → 建目录 + 写模板 → 直接打开 ✓）*/
    create(): Promise<void>;
    /** 把技能正文注入【聊天输入框】✓ */
    insertToChat(name: string): void;
    /** 作为 `/skill:<name>` 命令【直接发送】✓ */
    sendAsCommand(name: string): void;
}

/** 造一份技能动作集（闭包持有 deps ✓）*/
export function createSkillsActions(deps: SkillsActionsDeps): SkillsActions {
    /** ★ 扫技能并推给面板（顺带把"单击行为"配置一起发 ✗ 前端要用 ✓）*/
    const refresh = async (): Promise<void> => {
        try {
            const data = readSkills();
            const cfg = vscode.workspace.getConfiguration("pi-bridge");
            const clickAction = cfg.get<string>("skills.clickAction", "insert");
            // ★ 过滤掉被隐藏的（B31 ✓）
            const hidden = new Set(cfg.get<string[]>("skills.hidden", []));
            const visible = data.skills.filter((x) => !hidden.has(x.name));
            deps.post("skills", { ...data, skills: visible, clickAction });
        } catch (err) {
            logError(`扫技能失败: ${toErrorMessage(err)}`);
        }
    };

    /**
     * ★ 在 VS Code 编辑器里打开技能的 SKILL.md（B31 ✓）
     *
     * 【★ 为什么不用"我们的弹层"编辑？】
     *   用户定的：“临时去拿还能理解 ✗ 我这边修改完保存好了 ✗ 用到的就是最新的 ✓”
     *   → ★ 用原生编辑器打开【磁盘上那个文件本身】✗ 保存即落盘 ✓
     *   → 没有暂存 / 没有同步问题 ✓✓✓
     */
    const openFile = async (name: string, reveal: boolean): Promise<void> => {
        const hit = readSkills().skills.find((x) => x.name === name);
        if (!hit?.path) {
            logWarn(`打开技能文件：找不到 ${name}`);
            return;
        }
        const uri = vscode.Uri.file(hit.path);
        if (reveal) {
            await vscode.commands.executeCommand("revealFileInOS", uri);
            return;
        }
        // ★★ 只读技能 → 打开成【未命名文档】✗（用户要求 ✓）
        //   ★ 为什么？→ 扩展包里的技能改了会被下次装包覆盖 ✗ 不如不给改 ✓
        //   ★★ 未命名文档的物理特性 ✗：
        //     你改了想保存 ✗ VS Code 会弹"另存为"✗ 不会覆盖原文件 ✓✓✓
        if (!hit.mine) {
            const doc = await vscode.workspace.openTextDocument({
                content: fs.readFileSync(hit.path, "utf8"),
                language: "markdown",
            });
            await vscode.window.showTextDocument(doc, { preview: false });
            void vscode.window.showInformationMessage(
                `这是只读预览（扩展包提供的技能 ✗ 改了会被下次安装覆盖 ✓）。原文件：${hit.path}`,
            );
            return;
        }
        await vscode.window.showTextDocument(uri, { preview: false });
    };

    /**
     * ★ 删除一个技能（B31 ✗ 删整个目录 ✓）
     *
     * 【★ 只允许删用户自己的】
     *   扩展包提供的技能是【包的一部分】✗ 删了下次装包又回来 ✓
     *   → 直接拒绝 ✓（前端也不会给入口 ✗ 这里是第二道防线 ✓）
     */
    const remove = async (name: string): Promise<void> => {
        const hit = readSkills().skills.find((x) => x.name === name);
        if (!hit?.path || !hit.mine) {
            deps.post("skillToast", { text: "只读技能不能删除 ✓", err: true });
            return;
        }
        // ★ 二次确认（删目录不可逆 ✗ 虽然会进回收站 ✓）
        const ok = await vscode.window.showWarningMessage(
            `删除技能「${name}」？（整个目录会进回收站）`,
            { modal: true },
            "删除",
        );
        if (ok !== "删除") return;
        const dir = path.dirname(hit.path);
        const r = await deleteSessionFile(dir);
        if (r.ok) {
            logInfo(`删除技能：${name}（${r.method}）`);
            deps.post("skillToast", { text: `已删除：${name}` });
        } else {
            logError(`删除技能失败：${r.error}`);
            deps.post("skillToast", { text: `删除失败：${r.error}`, err: true });
        }
        await refresh();
    };

    /**
     * ★ 隐藏一个技能（B31 ✗ 不删 ✗ 只是不显示 ✓）
     *
     * 【为什么需要它？】
     *   有些技能是别人包的 ✗ 删不掉 ✓ 但又不想天天看见 ✓
     *   → 加进隐藏清单 ✓（VS Code 配置里一个字符串数组 ✓）
     */
    const hide = async (name: string): Promise<void> => {
        const cfg = vscode.workspace.getConfiguration("pi-bridge");
        const cur = cfg.get<string[]>("skills.hidden", []);
        if (cur.includes(name)) return;
        await cfg.update("skills.hidden", [...cur, name], vscode.ConfigurationTarget.Global);
        deps.post("skillToast", { text: `已隐藏：${name}（可在设置里恢复 ✓）` });
        await refresh();
    };

    /**
     * ★★ 新建技能（B31 ✓）
     *
     * 【流程】输入名字 → 校验 → 建目录 + 写模板 → 直接用编辑器打开 ✓
     *
     * 【为什么要模板？】
     *   SKILL.md 必须带 YAML front-matter（name / description ✓）
     *   否则不会被识别 ✗ 也不能只给它一个空文件 ✓
     *   → 给一个能直接开写的骨架 ✗ 用户改两行就好了 ✓
     */
    const create = async (): Promise<void> => {
        const root = path.join(getAgentDir(), "skills");
        const name = await vscode.window.showInputBox({
            title: "新建技能",
            prompt: "起个名字（当目录名 ✗ 建议用英文小写 + 连字符 ✓）",
            placeHolder: "my-skill",
            // ★ 校验（防路径穿越 ✗ 防重名 ✓）
            validateInput: (v) => {
                const t = v.trim();
                if (!t) return "名字不能为空";
                if (!/^[A-Za-z0-9._-]+$/.test(t)) return "只能用字母 / 数字 / . _ -（别用空格和斜杠 ✓）";
                if (t === "." || t === "..") return "这个名字不合法";
                if (fs.existsSync(path.join(root, t))) return `已存在同名技能：${t}`;
                return undefined;
            },
        });
        if (!name) return;

        const dir = path.join(root, name.trim());
        const file = path.join(dir, "SKILL.md");
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
                file,
                [
                    "---",
                    `name: ${name.trim()}`,
                    "description: （一句话说明这个技能是干什么的 ✗ 会显示在技能列表里 ✓）",
                    "---",
                    "",
                    `# ${name.trim()}`,
                    "",
                    "（在这里写指令 ✗ 模型读到的就是这段内容 ✓）",
                    "",
                ].join("\n"),
                "utf8",
            );
            logInfo(`新建技能：${file}`);
            // ★ 直接打开让它开写 ✓
            await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
            deps.post("skillToast", { text: `已创建：${name.trim()}（改完保存即可 ✓）` });
            await refresh();
        } catch (err) {
            logError(`新建技能失败：${toErrorMessage(err)}`);
            deps.post("skillToast", { text: `新建失败：${toErrorMessage(err)}`, err: true });
        }
    };

    /**
     * ★★ 把技能正文注入【聊天输入框】（B36 ✗ 从 main.ts 的内联逻辑搬来 ✓）
     *
     * 【为什么宿主来读文件？】
     *   技能面板是【独立页面】✗ 它碰不到侧栏的 textarea ✓
     *   → 它只给【名字】✗ 宿主读盘 + 推给聊天页 ✓
     */
    const insertToChat = (name: string): void => {
        const hit = readSkills().skills.find((x) => x.name === name);
        if (!hit?.path) {
            logWarn(`技能注入：找不到 ${name}`);
            return;
        }
        try {
            deps.postChat("insertToInput", { text: fs.readFileSync(hit.path, "utf8") });
            logInfo(`技能注入输入框：${name}`);
        } catch (err) {
            logError(`读技能内容失败: ${toErrorMessage(err)}`);
        }
    };

    /**
     * ★★ 作为命令【直接发送】（B36 ✓）
     *
     * ★★ 必须带斜杠（B31 修 ✗）
     *   pi 文档：“Run one through the `prompt` command by
     *           prefixing its name with `/`” ✓
     *   少了它 → pi 把它当成【普通消息】✗ 技能不会执行 ✓
     */
    const sendAsCommand = (name: string): void => {
        const text = `/skill:${name}`;
        logInfo(`技能作为命令发送：${text}`);
        deps.postChat("sendText", { text });
    };

    return { refresh, openFile, remove, hide, create, insertToChat, sendAsCommand };
}
