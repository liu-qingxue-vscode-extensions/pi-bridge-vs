/**
 * settings-post.ts —— 把设置面板的内容推给前端（B30 ✗ 从 main.ts 搬出）
 *
 * ★ 每次【现读磁盘】✗ 不用缓存 ✓ 理由：
 *   pi 进程也会写 settings.json（lastChangelogVersion 等 ✓）
 *   缓存的话用户会看到旧值 ✗ 而文件很小 ✓ 读它几乎免费 ✓
 *
 * ★ 依赖只有 chatView.post ✗ 所以用【工厂函数】把依赖显式传进来 ✓
 */
import { readSettings, settingsPath } from "../pi/settings.js";
import { SETTINGS_GROUPS } from "../pi/settings-schema.js";
import { listAuth } from "../pi/auth.js";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { sortCatalog, readModelCatalog } from "./model-catalog.js";
import { readInstalledExtensions } from "./extensions-scan.js";
import { defaultForKind } from "./settings-utils.js";
import { getByPath } from "../pi/settings-schema.js";

export function createSettingsPoster(deps: {
    post: (kind: string, payload: unknown) => void;
}): () => void {
    return function postSettings(): void {
    const all = readSettings();
    // ★ 模型目录（给下拉框用 ✓）
    const catalog = readModelCatalog();
    const providers = [...new Set(catalog.map((m) => m.provider))].sort();

    const groups = SETTINGS_GROUPS.map((g) => ({
        title: g.title,
        items: g.items.map((f) => {
            // ★ 动态注入选项（B24 用户要求：这些字段改成“有限字段”下拉 ✓）
            let options = f.options;
            if (f.key === "defaultModel") {
                // ★ 选项与值【都用 `provider/id`】✗（B24 合并决定 ✓）
                //   为什么值也用全名？→ 保存时能拆成两个字段 ✓
                //   （另外：只有 id 的话，同名模型在不同供应商下会歧义 ✓）
                options = sortCatalog(catalog).map((m) => ({
                    value: `${m.provider}/${m.id}`,
                    label: `${m.provider}/${m.id}`,
                }));
            } else if (f.kind === "extlist") {                    // ★ 已装扩展：选项 = 全部已装 ✓ 值 = 当前启用的 ✓
                //   前端用复选框列表渲染 ✓
                options = readInstalledExtensions().map((x) => ({
                    value: x.source,
                    label: x.source + (x.enabled ? "" : "（已停用）"),
                }));
            } else if (f.key === "enabledModels") {
                // ★ 列表控件也用它：下拉“选一个添加”✗ 不用手敲 ✓
                //   ★ 同样的排序 ✓（用户看下拉时体验一致 ✓）
                options = sortCatalog(catalog).map((m) => ({
                    value: `${m.provider}/${m.id}`,
                    label: `${m.provider}/${m.id}`,
                }));
            }
            // ★ defaultModel 要【合成】provider/id 显示 ✗（B24 合并 ✓）
            //   因为文件里是分开存的（provider + model 两个字段 ✓）
            let value = getByPath(all, f.key) ?? f.fallback ?? defaultForKind(f.kind);
            if (f.key === "defaultModel") {
                const prov = typeof all.defaultProvider === "string" ? all.defaultProvider : "";
                const id = typeof all.defaultModel === "string" ? all.defaultModel : "";
                value = id ? (prov ? `${prov}/${id}` : id) : "";
            }
            // ★ 供应商凭据（B24）：值直接给【凭据列表】✗（不是 settings 字段 ✓）
            //   ★ 注意：listAuth 已经做过【脱敏】✗ 不含原始 key ✓
            if (f.kind === "providers") {
                return {
                    key: f.key,
                    label: f.label,
                    desc: f.desc,
                    kind: f.kind,
                    value: listAuth(),
                    exists: true,
                };
            }
            return {
                key: f.key,
                label: f.label,
                desc: f.desc,
                kind: f.kind,
                options,
                min: f.min,
                max: f.max,
                needsRestart: f.needsRestart,
                value,
                exists: getByPath(all, f.key) !== undefined,
            };
        }),
    }));
    deps.post("settings", { path: settingsPath(), groups });
}
}
