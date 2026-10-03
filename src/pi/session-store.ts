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
import path from "node:path";
import * as vscode from "vscode";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
}

/** 持久化形状 */
interface StoreData {
    /** 目录名 → 真实 cwd（空/缺 = 待补 ✓） */
    cwdMap: Record<string, string>;
    /** 文件路径 → 内容信息（★ 只有刷新过才有 name/broken ✓） */
    files: Record<string, { name?: string; broken?: string }>;
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
async function readNameAndCheck(file: string): Promise<{ name?: string; broken?: string }> {
    // ① 先验首行（异常文件在这里就能判出来 ✓）
    const head = await readHead(file);
    if (head === undefined) return { broken: "文件读不了（权限/损坏）" };
    try {
        const rec = JSON.parse(head) as { type?: string; cwd?: unknown };
        if (rec?.type !== "session") return { broken: "首行不是 session 元数据（文件不完整？）" };
        if (typeof rec.cwd !== "string" || !rec.cwd) return { broken: "首行缺 cwd" };
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
        return {};
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
                    return { name: o.name.trim() };
                }
            } catch {
                /* 被截断的行 ✓ 跳过 */
            }
        }
        return {};
    } finally {
        await fh.close();
    }
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

    private root(): string {
        return path.join(getAgentDir(), "sessions");
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
        const root = this.root();

        let dirs: string[];
        try {
            dirs = (await fs.readdir(root, { withFileTypes: true }))
                .filter((d) => d.isDirectory())
                .map((d) => String(d.name));
        } catch {
            logError(`[sessions] 读不到会话目录: ${root}`);
            return [];
        }

        // ① 补 cwd（★ 只对新目录；一个目录读 1 次 ✓）
        const needCwd = dirs.filter((d) => !this.data.cwdMap[d]);
        let cwdAdded = 0;
        if (needCwd.length) {
            const found = await mapLimit(needCwd, 8, async (dir) => {
                const dirPath = path.join(root, dir);
                let names: string[];
                try {
                    names = (await fs.readdir(dirPath)).map((n) => String(n));
                } catch {
                    return null;
                }
                const any = names.find((n) => FILE_RE.test(n));
                if (!any) return null; // 空目录 → 不写映射 ✓
                const cwd = await readCwd(path.join(dirPath, any));
                return cwd ? ([dir, cwd] as const) : null;
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
        for (const dir of dirs) {
            if (out.length >= MAX_SESSIONS) break;
            const dirPath = path.join(root, dir);
            let names: string[];
            try {
                names = (await fs.readdir(dirPath)).map((n) => String(n));
            } catch {
                continue;
            }
            for (const name of names) {
                if (out.length >= MAX_SESSIONS) break;
                const file = path.join(dirPath, name);
                const parsed = parseFileName(name);
                const cached = this.data.files[file];

                if (!parsed) {
                    // 文件名不识认 → 仍列出（标异常 ✓ 便于排查）
                    out.push({
                        path: file,
                        id: name.replace(/\.jsonl$/i, ""),
                        cwd: this.data.cwdMap[dir] ?? "",
                        cwdKey: dir,
                        createdAt: 0,
                        broken: cached?.broken ?? "文件名格式不识认（无法解析时间/id）",
                    });
                    continue;
                }
                out.push({
                    path: file,
                    id: parsed.id,
                    cwd: this.data.cwdMap[dir] ?? "",
                    cwdKey: dir,
                    createdAt: parsed.createdAt,
                    // ★ 只从缓存取（要新名字请点刷新 ✓）
                    name: cached?.name,
                    broken: cached?.broken,
                });
            }
        }

        // ③ 清理缓存里【已经不存在的文件】（防止无限膨胀 ✓）
        const alive = new Set(out.map((s) => s.path));
        let cleaned = 0;
        for (const p of Object.keys(this.data.files)) {
            if (!alive.has(p)) {
                delete this.data.files[p];
                cleaned++;
            }
        }
        if (cleaned) await this.persist();

        out.sort((a, b) => b.createdAt - a.createdAt);
        logInfo(
            `[sessions] 条目 ${out.length} 个（补 cwd ${cwdAdded} / 清理 ${cleaned}）` +
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
            return [file, r] as const;
        });

        let named = 0;
        let broken = 0;
        for (const [file, r] of results) {
            this.data.files[file] = r;
            if (r.name) named++;
            if (r.broken) broken++;
        }
        await this.persist();

        logInfo(`[sessions] 刷新完成：${files.length} 个文件 / ${named} 有名字 / ${broken} 异常`);
        return { total: files.length, named, broken };
    }
}
