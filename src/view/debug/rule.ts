import { PiAllEvent } from "../../types/pi-type.js";
import { vsSettings } from "../../external-data/vs-settings.js";
import { isPiType } from "../../types/pi-type.js";
import { createVSLogger } from "../../logger.js";
const log = createVSLogger("debug-collapse-rule")

/**
 * 折叠规则 - 把连续的高频事件连续折叠
 * [pi-bridge.debug.collapse]来配置(形式为string)
 * 
 * 如{type:"prompt",a:{b:"test"}},想要:
 * [type]字段的值为某值时连续折叠:[prompt]
 * [type]字段的值为某值下,基于另一个字段以更细的颗粒度:
 * 1. [prompt:a.b="test"]--type值为[prompt]的基础上缩小要求[a.b="test"]
 * 2. [prompt:a.b]       --type值为[prompt]的基础上缩小要求[a.b]存在
 *
 * [相邻判定]两条数据归为同一段,当且仅当:
 *   ① 它们都被[同一条规则]命中
 *   ② 按 by 取出的[值串]相等(无 by 时恒等 )
 * [English]:[Collapse]折叠
 */
export interface CollapseRuleType {
    /** 事件类型(顶层字段必填) */
    type: string;
    child?: {
        /** 字段:,如 "assistantMessageEvent.type"的点号来深入*/
        childField: string[];
        /** 子字段的值[等于]它, 不写 value → 只要取得到值就算命中(范围更宽 )*/
        value?: string;
    }
}

/**
 * 折叠规则
 */
export class CollapseRule {
    private rules: CollapseRuleType[] = [];

    constructor() {
        this.refresh();
        log.info(`正在注册回调`)
        vsSettings.onSC("pi-bridge.debug.collapse", () => { this.refresh() })
    }

    /**
     * 这条数据该折叠吗？该则返回折叠段标签
    */
    check(payload: PiAllEvent): string | undefined {
        log.info(`正在检查`)
        for (const rule of this.rules) {
            const label = this.checkOne(payload, rule);
            if (label !== undefined) return label; // 先匹配到的先生效
        }
        return undefined;
    }

    /**
     * 判断一条数据是否被规则命中;
     * 命中则返回[折叠段标签] ( 相邻数据的“同一段”判定靠它 )
     * @returns 命中的标签;不命中返回 undefined
     */
    private checkOne(payload: PiAllEvent, rule: CollapseRuleType): string | undefined {
        const t = payload.type;
        if (t !== rule.type) return undefined;

        // 只写了锚点1 → 整个 type 折一段(标签就是 type )
        if (!rule.child) return rule.type;

        const got = this.deep(payload, rule.child?.childField);
        if (got === undefined) return undefined;
        if (rule.child?.value !== undefined && got !== rule.child?.value) return undefined;

        // 标签用[字段末段]而不是全路径(短一点好读 )
        const leaf = rule.child?.childField.pop() ?? rule.child?.childField.join("");
        return `${rule.type} › ${leaf}=${got}`;
    }

    /** 重新读取配置并解析。配置变化后、重放历史之前都要调一次 */
    refresh(): void {
        const raw = vsSettings.get("pi-bridge.debug.collapse");
        const out: CollapseRuleType[] = [];
        const seen = new Set<string>();
        for (const item of raw ?? []) {
            const rule = this.parseRule(item);
            if (!rule) continue;
            // 去重(完全相同的规则写两次没意义 )
            const key = rule.type + "|" + (rule.child?.childField.join("") ?? "") + "=" + (rule.child?.value ?? "");
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(rule);
        }
        this.rules = out;
    }

    /**
     * 把设置里的原始项解析成规则
     * 严格解析
     * 解析不了就返回 undefined
     */
    private parseRule(raw: string): CollapseRuleType | undefined {
        // "" 
        const s = raw.trim();
        if (!s) return undefined;

        // 模式一: 纯type
        if (/^[a-z]$/.test(s) && isPiType(s)) return { type: s }

        const colon = s.indexOf(":");
        if (colon < 0) return undefined

        const type = s.slice(0, colon).trim();
        const child = s.slice(colon + 1).trim();

        if (!child || !type) return undefined
        if (!isPiType(type)) return undefined;

        // 模式二: type+child
        if (
            /^[a-z.]+$/.test(child) &&
            child[0] != "." &&
            child[-1] != "."
        ) return { type, child: { childField: [child] } }

        const eq = child.indexOf("=");
        if (eq < 0 || eq === 0 || child[-1] === "=") return undefined;

        const path = child.slice(0, eq).trim();
        const value = child.slice(eq + 1).trim();
        if (!path || !value) return undefined


        const dot = path.indexOf(".");
        if (!(/^[a-z.]+$/.test(child) &&
            child[0] != "." &&
            child[-1] != ".")
        ) return undefined
        // 模式三: type+child(单层)+值
        if (dot < 0) return { type, child: { childField: [child], value: value } }

        // 模式四: type+child(多层)+值
        const field: string[] = path.split(".")
        if (field.includes("")) return undefined
        return { type, child: { childField: field, value } }
    }
    /**
     * 取值:按点号路径深入 payload
     * @returns 取到的标量值(字符串化);取不到/不是标量 → undefined
     *
     * 特点:不调工具函数,不抛错;中途遇到非对象就返回 undefined
     */
    private deep(payload: PiAllEvent, childField: string[]): string | undefined {
        // 💡 1. 游标必须从整个 payload 开始
        let cur: unknown = payload;

        for (const seg of childField) {
            // 💡 2. 防御：如果中途发现不是对象，直接退出
            if (cur === null || typeof cur !== "object") {
                return undefined;
            }

            // 💡 3. 用 Record<string, unknown> 骗过 TS，允许动态索引
            cur = (cur as Record<string, unknown>)[seg];
        }

        // 对象/数组不做串化
        if (cur === undefined || cur === null || typeof cur === "object") return undefined;

        return String(cur);
    }
}
