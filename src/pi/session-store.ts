/**
 * session-store —— 会话的发现层：★ 两级 I/O 模型（用户定的 ✓）
 *
 * 【背景：为什么必须分两级？】
 *   列表要两类信息，成本差得远 ✗
 *     · 「有哪些会话」→ readdir 一次全拿到 ✓ 文件名里还有时间戳/id ✓
 *       → 便宜到可以每次打开面板都扫 ✓
 *     · 「会话名字」  → 只能【读文件末尾】（session_info 是追加的 ✗）
 *       → 80 个文件就是 240 次 syscall ✗ 不能每次扫 ✓
 *
 * 【两级模型】
 *   ① 条目层（自动 ✓）：打开面板 → readdir → 与缓存比对差异 → 增删条目
 *      ★ 零内容 IO ✓ 随便调 ✓
 *   ② 内容层（手动 ✓）：点【刷新】→ 才读文件补名字 / 标异常
 *      ★ 维护边界 = 用户点刷新的那一刻 ✓（文件内部改了但没刷新 → 显示旧名字 ✓）
 *
 * 【持久化】统一存在 globalState 的【一个 JSON】里 ✓
 *   {
 *     cwdMap: 目录名 → 真实 cwd      （目录名有损 ✗ → 只能读文件头补 ✓ 一次性 ✓）
 *     files:  path  → { name?, broken?, checked? }
 *   }
 *
 * 【cwd 的特殊性】它【无法从目录名反推】（有损 ✗）→ 只能读文件 ✓
 *   但好在【一个目录只需读 1 个文件】（同目录 cwd 必然相同 ✓）
 *   而且只对【新目录】读 → 一次性成本 ✓ 之后恒为 0 ✓
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import * as vscode from "vscode";
import { resolveAgentDir } from "./pi-env.js";
import { compactHome } from "../util/paths.js";
import { logDebug, logInfo, logError } from "../logger.js";

/** 一条会话的元信息（界面列表用 ✓） */
export interface SessionInfo {
    path: string;
    id: string;
    /** ★ 真实工作目录（来自 cwdMap ✓ 读不到则空串 → 界面显示"未知目录"） */
    cwd: string;
    cwdKey: string;
    createdAt: number;
    /** 会话名（★ 只有刷新过才有 ✓） */
    name?: string;
    /** 异常原因（刷新时检测出来 ✓ 前端标红且禁止切换 ✗） */
    broken?: string;
    /**
     * ★ 轮次（用户消息条数 —— 只有刷新过才有 ✓）
     *
     * 【为什么不能按文件大小估？】实测单条消息大小差异极大 ✗
     *   问“你好” ≈ 200B ✓ / read 一个大文件的 toolResult ≈ 2MB ✗
     *   → 同样 10 轮：纯聊天 2KB vs 带读文件 2MB（差 1000 倍 ✓）
     *   → 只能【真的数行】✓（但只需数 \n，不解析 JSON，很快 ✓）
     */
    turns?: number;
    /**
     * ★ 父会话路径（B24）—— fork / clone 出来的会话会带它 ✓
     *
     * 【它从哪来？】会话文件【首行的 parentSession 字段】✗
     *   实测：clone/fork 生成的会话 header：
     *     { type:"session", id, timestamp, cwd, parentSession: "/…/xxx.jsonl" }
     *   ★ 顺便读首行就拿得到 ✗（我们本来就要读首行验文件 ✓）
     *
     * 【用途】会话面板把它渲染成【缩进的分支】✗（把分支放主的下面 ✓）
     */
    parent?: string;
}

/** 持久化形状 */
interface StoreData {
    /** 目录名 → 真实 cwd（空/缺 = 待补 ✓） */
    cwdMap: Record<string, string>;
    /** 文件路径 → 内容信息（★ 只有刷新过才有 name/broken/turns/parent ✓） */
    files: Record<string, { name?: string; broken?: string; turns?: number; parent?: string }>;
}

const STORE_KEY = "pi-bridge.sessionStore";
const MAX_SESSIONS = 300;

/**
 * 文件名：2026-07-31T12-19-50-851Z_<uuid>.jsonl
 * ★ 实测两种：毫秒前可能是 - 也可能是 .（不同 pi 版本 ✓）
 */
const FILE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})[-.](\d{3})Z_([0-9a-f-]+)\.jsonl$/i;

/** 从文件名解析时间与 id（★ 零 IO ✓） */
function parseFileName(name: string): { createdAt: number; id: string } | undefined {
    const m = FILE_RE.exec(name);
    if (!m) return undefined;
    const iso =
        m[1].replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/, "$1T$2:$3:$4") +
        `.${m[2]}Z`;
    const ts = Date.parse(iso);
    return { createdAt: Number.isFinite(ts) ? ts : 0, id: m[3] };
}

// ────────────────────────────────────────────────────────────
//  文件读取小工具（只读头/尾，见文件头注释的 I/O 模型 ✓）
// ────────────────────────────────────────────────────────────

/** 读文件头（首行 = {"type":"session", cwd, id, timestamp} ✓） */
async function readHead(file: string): Promise<string | undefined> {
    const fh = await fs.open(file, "r");
    try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buf, 0, 4096, 0);
        return buf.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    } catch {
        return undefined;
    } finally {
        await fh.close();
    }
}

/** 从首行取 cwd */
async function readCwd(file: string): Promise<string | undefined> {
    const head = await readHead(file);
    if (!head) return undefined;
    try {
        const rec = JSON.parse(head) as { type?: string; cwd?: unknown };
        if (rec?.type !== "session") return undefined;
        return typeof rec.cwd === "string" && rec.cwd ? rec.cwd : undefined;
    } catch {
        return undefined;
    }
}

/**
 * 读文件尾找会话名（session_info 是每轮【追加】的 → 名字在末尾 ✓）
 *
 * ★ 为什么要读 16KB 而不是精确定位？
 *   jsonl 行不定长 ✗ → 无法"跳到第 N 行"（不知道它在哪个字节 ✓）
 *   只能 seek 到末尾读一段 → 按 \n 切 → 从后往前找 ✓
 *   可能切到行中间 → 那行 JSON 解析失败 → 跳过即可 ✓
 *
 * @returns { name, broken? } —— broken 有值表示文件异常 ✓
 */
async function readNameAndCheck(
    file: string,
): Promise<{ name?: string; broken?: string; parent?: string }> {
    // ① 先验首行（异常文件在这里就能判出来 ✓）
    const head = await readHead(file);
    if (head === undefined) return { broken: "文件读不了（权限/损坏）" };
    let parent: string | undefined;
    try {
        const rec = JSON.parse(head) as { type?: string; cwd?: unknown; parentSession?: unknown };
        if (rec?.type !== "session") return { broken: "首行不是 session 元数据（文件不完整？）" };
        if (typeof rec.cwd !== "string" || !rec.cwd) return { broken: "首行缺 cwd" };
        // ★ parentSession（B24）：fork/clone 出来的会话会带它 ✓
        //   顺便读一行就拿到了 ✗ 不用额外 IO ✓
        if (typeof rec.parentSession === "string" && rec.parentSession) {
            parent = rec.parentSession;
        }
    } catch {
        return { broken: "首行不是合法 JSON" };
    }

    // ② 读尾部找名字（★ 没名字是【正常】的 —— 审计发现约 31% 没有 ✓）
    let fh: Awaited<ReturnType<typeof fs.open>>;
    let size: number;
    try {
        fh = await fs.open(file, "r");
        size = (await fh.stat()).size;
    } catch {
        return { parent }; // ★ 读尾部失败不算异常 ✗ 但仍要带上 parent ✓
    }
    try {
        const want = Math.min(size, 16384);
        const buf = Buffer.alloc(want);
        await fh.read(buf, 0, want, size - want);
        for (const line of buf.toString("utf8").split("\n").reverse()) {
            if (!line.includes("session_info")) continue;
            try {
                const o = JSON.parse(line) as { type?: string; name?: unknown };
                if (o?.type === "session_info" && typeof o.name === "string" && o.name.trim()) {
                    // ★★ 这里【必须带上 parent】✗（B24 踩到的坑 ✓）
                    //   原来只 return { name } ✓ → parent 在成功路径上被丢掉了 ✓
                    //   → 缓存里 88 条全是 parent 缺失 ✓ 前端自然看不到任何分支 ✓
                    return { name: o.name.trim(), parent };
                }
            } catch {
                /* 被截断的行 ✓ 跳过 */
            }
        }
        return { parent }; // ★ 没名字（正常 ✓）但 parent 不能丢 ✗
    } finally {
        await fh.close();
    }
}

/**
 * ★ 数会话文件里的【轮次】（= 用户消息条数 ✓）
 *
 * 【怎么数】只看每行是不是 {"type":"message",…"role":"user"…} ✓
 *   → 不解析整个 JSON ✗ 只做【字符串包含判断】✓（快得多 ✓）
 *
 * 【为什么用流式读？】
 *   文件可能 11MB ✗ 一次读进来会占内存 ✓
 *   流式 chunk 处理 → 内存恒定 ✓ 也只读一遍 ✓
 */
async function countTurns(file: string): Promise<number> {
    const { createReadStream } = await import("node:fs");
    return new Promise((resolve) => {
        let turns = 0;
        let tail = ""; // 跨 chunk 的半行
        const rs = createReadStream(file, { encoding: "utf8", highWaterMark: 256 * 1024 });
        rs.on("data", (chunk: string) => {
            const text = tail + chunk;
            const lines = text.split("\n");
            tail = lines.pop() ?? ""; // 最后一段可能不完整 → 留给下一轮 ✓
            for (const line of lines) {
                // ★ 用户消息行特征（不解析 JSON ✓）
                if (line.includes('"type":"message"') && line.includes('"role":"user"')) {
                    turns++;
                }
            }
        });
        rs.on("end", () => resolve(turns));
        rs.on("error", () => resolve(0));
    });
}

/** 并发限流（避免一次开几百个文件句柄 ✗） */
async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let cursor = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (cursor < items.length) {
                const i = cursor++;
                out[i] = await fn(items[i]);
            }
        }),
    );
    return out;
}

// ────────────────────────────────────────────────────────────
//  SessionStore
// ────────────────────────────────────────────────────────────

export class SessionStore {
    private data: StoreData;

    constructor(private readonly context: vscode.ExtensionContext) {
        const saved = context.globalState.get<StoreData>(STORE_KEY);
        this.data = {
            cwdMap: saved?.cwdMap ?? {},
            files: saved?.files ?? {},
        };
    }

    /**
     * ★ 会话根目录（B24 变量化 ✗）
     *
     * 【为什么不再是硬编码？】
     *   pi 的 settings.json 里有个 sessionDir ✓ 改了它 pi 就把会话写别处 ✗
     *   我们若还写死 ~/.pi/agent/sessions → ★ 列表全空 ✗（用户报的隐患 ✓）
     *   （用户原话："我有概率会出错，不是有概率是一定会出错"✓）
     *
     * 值由 main.ts 在【激活时】用 resolveSessionRoot() 设置 ✓
     * 优先级：CLI --session-dir > settings.sessionDir > 默认 ✓
     */
    private sessionRoot: string | null = null;

    /** ★ 由外部注入（B24 ✓）—— 通常来自 settings.json 的 sessionDir ✓ */
    setRoot(dir: string): void {
        this.sessionRoot = dir;
        logInfo(`会话根目录 → ${dir}`);
    }

    private root(): string {
        return this.sessionRoot ?? path.join(resolveAgentDir(), "sessions");
    }

    /**
     * ★★ B42：额外扫描的会话目录（用户配置 ✗ 只读）
     *
     * 【为什么要它】
     *   pi 的 sessionDir 是【一个值同时管读和写】⇒ 不该让用户乱改（会数据分裂 ✓）
     *   但用户也可能"会话散落在多处"（从别的机器拷来的 / 旧目录）✓
     *   ⇒ ★ 用这个【只读探测列表】解决：多看几个地方 ✗ 但不碰 pi 的行为 ✓
     */
    private extraDirs: string[] = [];

    setExtraDirs(dirs: string[]): void {
        this.extraDirs = dirs.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim());
        if (this.extraDirs.length) logInfo(`额外会话目录：${this.extraDirs.join(", ")}`);
    }

    /** ★ 给人看的根目录说明（空列表时告诉用户"我在哪儿找过"）*/
    describeRoots(): string {
        return this.roots().map((r) => compactHome(r)).join(" ✗ ");
    }

    /** ★ 要扫描的全部根目录（主 + 额外 ✗ 去重）*/
    private roots(): string[] {
        const all = [this.root(), ...this.extraDirs];
        return [...new Set(all.map((d) => path.resolve(d)))];
    }

    private async persist(): Promise<void> {
        await this.context.globalState.update(STORE_KEY, this.data);
    }

    /**
     * ★ 第一级：只扫文件名 → 条目（零内容 IO ✓）
     *
     * 每次打开面板都可以调 ✓ 便宜 ✓
     * 名字/异常状态【只从缓存读】✗（要新的就点刷新 ✓）
     */
    async listEntries(): Promise<SessionInfo[]> {
        // ★★ B42：扫【主目录 + 额外探测目录】
        //   ★ cwdMap / cwdKey 的键用【完整目录路径】✗ 不再用目录名
        //     （不同根下可能有同名目录 ✗ 用名字会互相覆盖 ✓）
        const roots = this.roots();
        const pairs: { root: string; dir: string; full: string }[] = [];
        for (const root of roots) {
            let dirs: string[];
            try {
                dirs = (await fs.readdir(root, { withFileTypes: true }))
                    .filter((d) => d.isDirectory())
                    .map((d) => String(d.name));
            } catch {
                // ★ 主目录读不到要报（那是"前提"之一）✗ 额外目录读不到就算了（用户随手配的）
                if (root === this.root()) logError(`[sessions] 读不到会话目录: ${root}`);
                else logDebug(`[sessions] 额外目录读不到（忽略）: ${root}`);
                continue;
            }
            for (const dir of dirs) pairs.push({ root, dir, full: path.join(root, dir) });
        }

        // ① 补 cwd（★ 只对新目录；一个目录读 1 次 ✓）
        const needCwd = pairs.filter((p) => !this.data.cwdMap[p.full]);
        let cwdAdded = 0;
        if (needCwd.length) {
            const found = await mapLimit(needCwd, 8, async (p) => {
                let names: string[];
                try {
                    names = (await fs.readdir(p.full)).map((n) => String(n));
                } catch {
                    return null;
                }
                const any = names.find((n) => FILE_RE.test(n));
                if (!any) return null; // 空目录 → 不写映射 ✓
                const cwd = await readCwd(path.join(p.full, any));
                return cwd ? ([p.full, cwd] as const) : null;
            });
            for (const item of found) {
                if (!item) continue;
                this.data.cwdMap[item[0]] = item[1];
                cwdAdded++;
            }
            if (cwdAdded) await this.persist();
        }

        // ② 扫文件名 → 条目（★ 零内容 IO ✓）
        const out: SessionInfo[] = [];
        for (const p of pairs) {
            if (out.length >= MAX_SESSIONS) break;
            let names: string[];
            try {
                names = (await fs.readdir(p.full)).map((n) => String(n));
            } catch {
                continue;
            }
            for (const name of names) {
                if (out.length >= MAX_SESSIONS) break;
                const file = path.join(p.full, name);
                const parsed = parseFileName(name);
                const cached = this.data.files[file];

                if (!parsed) {
                    // 文件名不识认 → 仍列出（标异常 ✓ 便于排查）
                    out.push({
                        path: file,
                        id: name.replace(/\.jsonl$/i, ""),
                        cwd: this.data.cwdMap[p.full] ?? "",
                        cwdKey: p.full,
                        createdAt: 0,
                        broken: cached?.broken ?? "文件名格式不识认（无法解析时间/id）",
                    });
                    continue;
                }
                out.push({
                    path: file,
                    id: parsed.id,
                    cwd: this.data.cwdMap[p.full] ?? "",
                    cwdKey: p.full,
                    createdAt: parsed.createdAt,
                    // ★ 只从缓存取（要新名字/轮次请点刷新 ✓）
                    name: cached?.name,
                    broken: cached?.broken,
                    turns: cached?.turns,
                    parent: cached?.parent, // ★ 父会话（B24 fork 树用 ✓）
                });
            }
        }

        // ③ 清理缓存里【已经不存在的文件】（防止无限膨胀 ✓）
        const alive = new Set(out.map((s) => s.path));
        let cleaned = 0;
        for (const k of Object.keys(this.data.files)) {
            if (!alive.has(k)) {
                delete this.data.files[k];
                cleaned++;
            }
        }
        if (cleaned) await this.persist();

        out.sort((a, b) => b.createdAt - a.createdAt);
        logInfo(
            `[sessions] 条目 ${out.length} 个（根目录 ${roots.length} 个 / 补 cwd ${cwdAdded} / 清理 ${cleaned}）` +
                `★ 零内容 IO ✓`,
        );
        return out;
    }

    /**
     * ★ 手动更新某个会话的【名字缓存】（改名后调 ✓）
     *
     * 【为什么不一全量刷新？】（用户定的 ✓）
     *   改名是【我们自己发起的】→ 结果我们知道 ✓
     *   重读 80 个文件就为了刷新一个名字 → 浪费 ✗
     *   → 直接写缓存 ✓ 刷新按钮留给“后端其它行为改了文件”的情况 ✓
     */
    async setName(path: string, name: string): Promise<void> {
        this.data.files[path] = { ...(this.data.files[path] ?? {}), name };
        await this.persist();
    }

    /**
     * ★ 取当前会话文件（改名时要知道改哪个 ✓）
     * ★ 它不缓存 sessionFile —— 直接让调用方问 pi（get_state ✓）
     */
    async findName(path: string): Promise<string | undefined> {
        return this.data.files[path]?.name;
    }

    /**
     * ★ 第二级：手动刷新 —— 【全量】读文件补名字 / 标异常（唯一的内容 IO ✓）
     *
     * 【★ 为什么必须是全量，不能增量？】（用户点清楚的 ✓）
     *   会话名是【后来才可能出现】的：
     *     · 一个会话可能开了很久都没名字 ✓
     *     · 后来 pi 追加了 session_info → 名字才出现 ✓
     *   如果做“已读过就跳过”的增量 ✗
     *     → 那批“当时没名字”的会话永远看不到新名字 ✗
     *   → 所以每次刷新都【重读全部】✓（代价：80 文件 × 读头尾 ≈ 几十毫秒 ✓ 可接受）
     *
     * 维护边界 = 用户点【刷新】的那一刻 ✓
     * @returns 统计（好在界面/日志里给个反馈 ✓）
     */
    async refresh(): Promise<{ total: number; named: number; broken: number }> {
        const entries = await this.listEntries();
        const files = entries.map((e) => e.path);

        const results = await mapLimit(files, 8, async (file) => {
            const r = await readNameAndCheck(file);
            // ★ 顺便数轮次（用户要求的：和名字一样，刷新时才算 ✓）
            const turns = r.broken ? 0 : await countTurns(file);
            return [file, { ...r, turns }] as const;
        });

        let named = 0;
        let broken = 0;
        for (const [file, r] of results) {
            this.data.files[file] = r;
            if (r.name) named++;
            if (r.broken) broken++;
        }
        await this.persist();

        logInfo(
            `[sessions] 刷新完成：${files.length} 个文件 / ${named} 有名字 / ${broken} 异常`,
        );
        return { total: files.length, named, broken };
    }

    /**
     * ★★ B42：从"读全文"的结果回写缓存（渲染时顺便做 ✗ 零额外 I/O）
     *
     * 【为什么要有它】
     *   refresh() 为了快只读【尾部 16KB】找名字 ✗ 假设"名字在最后"
     *   但真相是：改名后又聊了很多 ⇒ 名字被推出 16KB ⇒ 读不到 ✓
     *   ★ 而我们【打开会话本来就要读整个文件】（渲染）⇒ 顺手把名字拿回来 ✓
     *     ⇒ 打开过的会话名字一定准 ✓ 越用越准 ✓
     */
    updateFromFullRead(file: string, meta: { name?: string; turns?: number; parent?: string }): void {
        const cur = this.data.files[file];
        const next = { ...(cur ?? {}) };
        let changed = false;
        if (meta.name && meta.name !== next.name) {
            next.name = meta.name;
            changed = true;
        }
        if (typeof meta.turns === "number" && meta.turns !== next.turns) {
            next.turns = meta.turns;
            changed = true;
        }
        if (meta.parent && meta.parent !== next.parent) {
            next.parent = meta.parent;
            changed = true;
        }
        if (!changed) return;
        this.data.files[file] = next;
        void this.persist();
        logInfo(`[sessions] 读全文补全元信息：${path.basename(file)} name=${next.name ?? "-"}`);
    }
}

/**
 * ★ 删除一个会话文件（B21）
 *
 * 【为什么在扩展里做，而不是发 RPC？】
 *   官方【没有】delete_session 命令 ✗（42 个命令里没它 ✓）
 *   而 TUI 里能删 ✓ → 因为它是【前端自己删文件】✓
 *   （照抄 dist/modes/interactive/components/session-selector.js:541 ✓）
 *
 * 【为什么先试 trash？】
 *   会话是用户的劳动成果 ✓ 直接 unlink 会让误触无法挽回 ✗
 *   → 先进回收站 ✓ 没装才回落 unlink（并在 UI 上如实说“永久删除”✓）
 *
 * ★ 比官方 TUI 【多做了什么】（B21 实测发现 ✓）：
 *   官方只试了 `trash` 一个命令 ✗
 *   而用户的 CachyOS（KDE）上【没装 trash-cli】✗ 只有 `gio` ✓
 *   → 照搬官方的话会直接 unlink（永删 ⚠）用户却以为进了回收站 ✗☠
 *   → 所以我们【多试几个候选】：trash → gio trash → unlink ✓
 *
 * 【注意】
 *   · 调用方必须先做【当前会话保护】和【二次确认】✗（本函数不做 ✗）
 *   · 返回 method 让调用方能【如实告知】到底发生了什么 ✓
 */
export async function deleteSessionFile(
    filePath: string,
): Promise<
    { ok: true; method: "trash" | "gio" | "unlink" } | { ok: false; error: string }
> {
    // ① `trash`（trash-cli 包 ✓ 路径以 - 开头会被当选项 ✗ → 用 -- 断开 ✓）
    const t = filePath.startsWith("-") ? ["--", filePath] : [filePath];
    const trash = spawnSync("trash", t, { encoding: "utf-8" });
    if (trash.status === 0) return { ok: true, method: "trash" };
    // 没装（ENOENT）或文件已被处理 ✓ → 继续试下一个
    if (!existsSync(filePath)) return { ok: true, method: "trash" };

    // ② `gio trash`（GLib ✓ 大多数桌面环境都有 ✓ 你的机器就是走这条 ✓）
    const gio = spawnSync("gio", ["trash", filePath], { encoding: "utf-8" });
    if (gio.status === 0) return { ok: true, method: "gio" };
    if (!existsSync(filePath)) return { ok: true, method: "gio" };

    // ③ 回落：真删（⚠ 不可恢复 ✓ 所以调用方必须已二次确认 ✓）
    try {
        await fs.unlink(filePath);
        return { ok: true, method: "unlink" };
    } catch (err) {
        const unlinkErr = err instanceof Error ? err.message : String(err);
        const hints = [
            trash.error?.message ?? trash.stderr?.trim().split("\n")[0],
            gio.error?.message ?? gio.stderr?.trim().split("\n")[0],
        ].filter(Boolean);
        return {
            ok: false,
            error: hints.length ? `${unlinkErr}（trash/gio: ${hints.join(" · ")}）` : unlinkErr,
        };
    }
}

/**
 * ★ 把 cwd 映射成它在 sessions 下的目录名（B21，导入会话要用 ✓）
 *
 * 【规则来源】照抄 pi 自己（dist/core/session-manager.js:242 getDefaultSessionDirPath ✓）
 *   safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
 *   例：/home/liuqingxue          → --home-liuqingxue--
 *       /home/liuqingxue/Docs/简历 → --home-liuqingxue-Docs-简历--
 *
 * 【为什么自己不 import 那个函数？】
 *   它只从 dist/core/session-manager.js 导出 ✗ 不在包主入口 ✓
 *   走内部路径 import 会【随版本升级而断】✗
 *   而这条规则【极简且稳定】✓ → 自己实现 + 注明来源更方便日后核对 ✓
 */
export function sessionDirForCwd(cwd: string, rootDir?: string): string {
    const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return path.join(rootDir ?? path.join(resolveAgentDir(), "sessions"), safe);
}

/**
 * ★ 校验一个文件像不像【pi 的会话文件】（B21 导入时的拦截 ✓）
 *
 * 【为什么必须拦？】（用户：“不检验一下，不拦一下吗？”✓）
 *   导入的是【外部文件】✗ 可能是任意 jsonl（日志 / 别的工具导出 ✓）
 *   放进去就是一条【切不过去、又得手动删】的垃圾条目 ✗
 *   （切换时 pi 会报 "Session file is not a valid pi session" ✓）
 *   → 宁可在入库前拒掉 ✓ 并说清原因 ✓
 *
 * 【判定规则（宽松但足够）】
 *   ① 后缀是 .jsonl ✓
 *   ② 非空文件 ✓
 *   ③ ★ 首行是合法 JSON 且 type === "session" ✓
 *      （实测：pi 自己写的会话文件【第一行必是 session 头】✓
 *        带 cwd / id / timestamp / version 字段 ✓）
 *
 * 【为什么不逐行全验？】
 *   会话文件可能 10MB+ ✗ 全读太贵 ✓
 *   而首行是 header ✓ 它对了基本就对了 ✓
 *   （真损坏的会在切换时被 pi 自己挡下 ✓）
 */
export async function validateSessionFile(
    filePath: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (!filePath.toLowerCase().endsWith(".jsonl")) {
        return { ok: false, reason: "不是 .jsonl 文件" };
    }
    let fh: fs.FileHandle | undefined;
    try {
        const st = await fs.stat(filePath);
        if (st.size === 0) return { ok: false, reason: "文件是空的" };
        fh = await fs.open(filePath, "r");
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const head = buf.subarray(0, bytesRead).toString("utf8");
        const firstLine = head.split("\n")[0]?.trim();
        if (!firstLine) return { ok: false, reason: "首行是空的" };
        let obj: unknown;
        try {
            obj = JSON.parse(firstLine);
        } catch {
            return { ok: false, reason: "首行不是合法的 JSON" };
        }
        const type = (obj as { type?: unknown })?.type;
        if (type !== "session") {
            return { ok: false, reason: `首行的 type 是「${String(type)}」，pi 会话应该是 "session"` };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
        await fh?.close();
    }
}
