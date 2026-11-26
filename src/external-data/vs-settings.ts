/**
 * vs-settings —— 配置的统一入口：自己维护一份快照，读的时候不碰 VS Code API
 *
 * [为什么要在本地存一份]
 *   1. 读得快：getConfiguration 每次调用都要过一次 VS Code 的配置服务，
 *      而这个值在两次变更之间根本不会变
 *   2. 读得一致：同一个 tick 里两个模块都读，拿到的一定是同一份值，
 *      不会出现"A 已经看到新值、B 还是旧值"
 *   3. 校验只做一次：读出来就校验、不合法就换默认值，之后所有消费者拿到的都是干净数据
 *
 * [和回调的分工]
 *   快照解决"值是不是新的"；回调解决"新的值要不要立刻做点什么"。
 *   两件事正交：
 *     · 只在渲染时读配置的，不订阅回调，下次渲染自然用新值
 *     · 改了要让界面当场变的(样式、缓冲容量），必须订阅，否则要等下次交互
 *
 * [监听常驻]
 *   快照要一直是最新的，所以 onDidChangeConfiguration 在模块加载时就注册，
 *   不依赖有没有订阅者。配置变化本来就低频，一个常驻监听器可以接受。
 */
import * as vscode from "vscode";
import { settingDefaults } from "../types/settings-type.js";
import type { SettingName, SettingTypeMap, SettingValue } from "../types/settings-type.js";
import { logWarn, createVSLogger } from "../logger.js";
import { schema } from "../util/simple-schema.js";
import { Any } from "typebox";

const log = createVSLogger("vs-settings")
const SECTION = "pi-bridge";
const PREFIX = `${SECTION}.`;

/** 所有配置项的 key(从默认值表推导，不用手写） */
const ALL_KEYS = Object.keys(settingDefaults) as SettingName[];

class VSSettingsManager {
    /** 当前快照。值已经过校验，不合法的一律是默认值 */
    private snapshot = new Map<SettingName, unknown>();

    /** 当前快照。值未经过校验 */
    private rawConfig = vscode.workspace.getConfiguration(SECTION);

    /** 一对一 */
    private watchs = new Map<SettingName, () => void>()
    /** 多个键 对 一个函数 */
    private watchsSome = new Map<SettingName[], () => void>()
    private watchsSomeL: Set<SettingName> = new Set<SettingName>()
    private dispose: vscode.Disposable | null = null

    constructor() {
        this.refresh()
        this.dispose = vscode.workspace.onDidChangeConfiguration((e) => {
            if (!e.affectsConfiguration(SECTION)) return;
            log.info("Pi的设置变化")
            log.info(`当前为${JSON.stringify([...this.watchs.keys()])}和${JSON.stringify([...this.watchsSome.keys()])}`)
            this.refresh()
            for (const [sn, h] of this.watchs) {
                if (!e.affectsConfiguration(sn)) continue;
                log.info(`回调发生在${sn}`)
                h()
            }
            for (const [sns, h] of this.watchsSome) {
                let changeOne = false
                for (const sn of sns) {
                    if (e.affectsConfiguration(sn) && changeOne === false) changeOne = true;
                }
                if (changeOne) h(); log.info(`回调发生在${sns}`)
            }
        })
    }

    getDispose(): vscode.Disposable {
        if (this.dispose === null) {
            throw new Error("不可能?vsSettings实例化晚于getDispose??")
        }
        const dispose = this.dispose
        this.dispose = null
        return dispose
    }

    refresh(): void {
        this.rawConfig = vscode.workspace.getConfiguration(SECTION)
        for (const key of ALL_KEYS) {
            this.load(key)
        };
    }

    /** 读一项并写进快照(带上校验和回退） */
    private load(key: SettingName): void {
        const def = settingDefaults[key];
        const raw = this.rawConfig.get(key.slice(PREFIX.length));

        // 没配过，静默给默认值
        if (raw === undefined || raw === null) {
            this.snapshot.set(key, def);
            return;
        }
        // 配了，且类型不对，才报错
        if (!schema(def, raw)) {
            logWarn(`配置 ${key} 的类型不对...`);
            this.snapshot.set(key, def);
            return;
        }
        this.snapshot.set(key, raw);
    }

    get<K extends SettingName>(key: K): SettingTypeMap[K] {
        const v = this.snapshot.get(key);
        return (v) as SettingTypeMap[K];
    }
    /** 为一个单独的设置变化单独，注册一个监听函数。*/
    onSC(sn: SettingName, handler: () => void): () => void {
        if (this.watchsSomeL.has(sn)) {
            throw new Error("在注册 VS Code 设置改变的监听里面，传入的监听对象重复");
        }
        if (this.watchs.has(sn)) {
            throw new Error(".在注册 VS Code 设置改变的监听里面,一对一重复监听!");
        }
        log.info(`回调注册了${sn}`)
        this.watchs.set(sn, handler);
        return () => {
            const set = this.watchs.get(sn);
            if (set) {
                this.watchs.delete(sn); // 如果没人监听了，删掉这个键省内存
            }
        }
    }
    /** 为每一个设置项部单独，注册一个监听函数。
     *  输入的sns的顺序和handler的传参顺序一致
    */
    onSCBatch(sns: SettingName[], handler: (() => void)[]): [(() => void)[], () => void] {
        if (sns.length !== handler.length) {
            throw new Error("在批量注册 VS Code 设置改变的监听里面，传入的监听对象数和函数数目不匹配");
        }

        let r = []
        for (let i = 0; i < sns.length; i++) {
            r.push(this.onSC(sns[i], handler[i]))
        }
        return [r, () => {
            for (const lr of r) {
                lr()
            }
        }]
    }

    /** 为多个设置项目，只注册一个回调函数 */
    onSomeSC(sns: SettingName[], handler: () => void): () => void {
        for (const sn of sns) {
            if (this.watchs.get(sn) || this.watchsSomeL.has(sn)) {
                throw new Error("在注册 VS Code 设置改变的监听里面，传入的监听对象重复");
            }
        }
        for (const sn of sns) {
            this.watchsSomeL.add(sn)
        }
        log.info(`回调注册了${sns}`)
        this.watchsSome.set(sns, handler)
        log.info(`当前为${JSON.stringify([...this.watchs.keys()])}和${JSON.stringify([...this.watchsSome.keys()])}`)
        return () => {
            if (!this.watchsSome.delete(sns)) {
                throw new Error("在注册 VS Code 设置改变的监听里面，还未监听就尝试释放对应句柄");
            };
            for (const s of sns) {
                this.watchsSomeL.delete(s)
            }
        }
    }
}

export const vsSettings = new VSSettingsManager



