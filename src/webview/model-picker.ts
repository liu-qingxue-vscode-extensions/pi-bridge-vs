/**
 * model-picker.ts —— 模型 / 思考深度的选择器（B23）
 *
 * 【UI 要求（用户定的 ✓）】
 *   · 位置：输入区下方那一排的最左端（模型在最左 ✓ 思考深度紧跟它右边 ✓）
 *   · 交互：★【左键点击】弹出列表 ✗（不是右键 ✓）
 *   · 方向：★ 向【上】弹 ✗（它们在屏幕底部 ✓ 往下会出屏 ✓）
 *   · 滚动：★ 支持滚轮 ✓（列表长了要能滚 ✓ 用原生 overflow-y 即可 ✓）
 *   · 范围：★ 两个列表都只用【启用列表】✗（B24 设置面板来编辑它 ✓）
 *
 * 【显示格式（用户定的 ✓）】
 *   · 模型：`模型名 (供应商)` ✓
 *   · 思考深度：`思考:中等` ✓
 */
import { footModel, footThinking } from "./dom.js";
import { log, vscode } from "./vscode-api.js";

/** 缓存最近一次的候选（避免每次点击都问宿主 ✓）*/
let cachedModels: { provider: string; id: string; name?: string }[] = [];
let cachedLevels: string[] = [];

/**
 * ★ 思考等级【不翻译】✗（用户定的 ✓）
 *
 * 用户原话：
 *   "不要中文，就连思考都不要用，直接叫 thinking 即可"
 *   "这个翻译成多也是有点儿（怪）"
 *
 * → 直接显示 pi 自己的词：off / minimal / low / medium / high / xhigh / max
 *   理由：它们是【协议里的枚举值】✗ 翻译反而增加一层心智负担 ✓
 *         而且用户以后要对齐 pi 文档时，原词更好查 ✓
 */

/** 当前弹层（同一时刻只有一个 ✓）*/
let pickerEl: HTMLElement | null = null;
let pickerFor: "model" | "thinking" | null = null;

function closePicker(): void {
    pickerEl?.remove();
    pickerEl = null;
    pickerFor = null;
}

/**
 * 在锚点按钮【上方】弹出一个列表
 *
 * 【为什么用 position:fixed + 手算坐标？】
 *   输入区的父级有 overflow 裁剪 ✗ 用 absolute 会被切掉 ✓
 *   而 fixed 相对视口 ✓ 不会被任何祖先裁剪 ✓（和 .ctx-menu 同理 ✓）
 */
function openPicker(anchor: HTMLElement, forWhat: "model" | "thinking", items: PickerItem[]): void {
    closePicker();
    if (!items.length) {
        log.info(`[picker] 候选为空（${forWhat}）`);
        return;
    }
    const box = document.createElement("div");
    box.className = "picker";
    for (const it of items) {
        const b = document.createElement("button");
        b.className = "picker-item";
        b.dataset.current = it.current ? "true" : "false";
        const main = document.createElement("span");
        main.textContent = it.label;
        b.appendChild(main);
        if (it.sub) {
            const sub = document.createElement("span");
            sub.className = "pk-sub";
            sub.textContent = it.sub;
            b.appendChild(sub);
        }
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            closePicker();
            it.onPick();
        });
        box.appendChild(b);
    }
    document.body.appendChild(box);

    // ★ 定位：底边贴住按钮顶边（向上弹 ✓）
    const a = anchor.getBoundingClientRect();
    const r = box.getBoundingClientRect();
    box.style.left = `${Math.max(4, Math.min(a.left, window.innerWidth - r.width - 6))}px`;
    box.style.top = `${Math.max(4, a.top - r.height - 4)}px`;
    // 如果上方空间不够 → 改向下弹（不至于被裁掉 ✓）
    if (a.top - r.height - 4 < 4) {
        box.style.top = `${Math.min(window.innerHeight - r.height - 6, a.bottom + 4)}px`;
    }
    pickerEl = box;
    pickerFor = forWhat;
}

interface PickerItem {
    label: string;
    sub?: string;
    current?: boolean;
    onPick: () => void;
}

// ── 全局关闭（与右键菜单同一套思路 ✓）──
document.addEventListener("click", closePicker);
window.addEventListener("blur", closePicker);
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePicker();
});
// ★ 滚轮：让它在列表里滚动 ✗ 不要穿透到消息区去滚页面 ✓
document.addEventListener(
    "wheel",
    (e) => {
        if (pickerEl && pickerEl.contains(e.target as Node)) e.stopPropagation();
    },
    { capture: true, passive: true },
);

/** 绑定两个按钮 ✓ */
export function setupModelPicker(): void {
    footModel.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pickerFor === "model") return closePicker();
        // ★ 先弹空的？不 ✗ 直接问宿主，回来再弹（本地往返，很快 ✓）
        vscode.postMessage({ kind: "listModels" });
    });
    footThinking.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pickerFor === "thinking") return closePicker();
        vscode.postMessage({ kind: "listThinkingLevels" });
    });
}

/**
 * ★ 收到状态 → 更新两个按钮的文字（B23 的统一入口 ✓）
 *
 * 显示格式：`模型名 (供应商)` / `思考:中等`
 * ★ 空值 → 隐藏按钮（data-empty ✓ 不给用户看空按钮 ✓）
 */
export function setModelInfo(p: { model?: string; provider?: string; thinkingLevel?: string }): void {
    const model = p.model ?? "";
    const provider = p.provider ?? "";
    if (model) {
        footModel.textContent = provider ? `${model} (${provider})` : model;
        footModel.title = `当前模型：${provider ? `${provider}/` : ""}${model}\n点击切换`;
        delete footModel.dataset.empty;
    } else {
        footModel.textContent = "";
        footModel.dataset.empty = "true";
    }

    const lv = p.thinkingLevel ?? "";
    if (lv) {
        footThinking.textContent = `thinking: ${lv}`;
        footThinking.title = `思考深度：${lv}\n点击切换`;
        delete footThinking.dataset.empty;
    } else {
        footThinking.textContent = "";
        footThinking.dataset.empty = "true";
    }
}

/** 宿主回来了模型候选 → 弹出列表 ✓ */
export function showModelPicker(
    models: { provider: string; id: string; name?: string; current?: boolean }[],
): void {
    cachedModels = models;
    openPicker(
        footModel,
        "model",
        models.map((m) => ({
            label: m.name || m.id,
            sub: m.provider,
            current: m.current,
            onPick: () => vscode.postMessage({ kind: "setModel", provider: m.provider, modelId: m.id }),
        })),
    );
}

/** 宿主回来了思考等级候选 → 弹出列表 ✓ */
export function showThinkingPicker(levels: string[], current?: string): void {
    cachedLevels = levels;
    openPicker(
        footThinking,
        "thinking",
        levels.map((lv) => ({
            label: lv,
            current: lv === current,
            onPick: () => vscode.postMessage({ kind: "setThinkingLevel", level: lv }),
        })),
    );
}

/** 供 apply.ts 判断当前是否开着 picker（避免重复弹 ✓）*/
export function isPickerOpen(): boolean {
    return pickerEl !== null;
}
