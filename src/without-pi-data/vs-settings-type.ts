// 自动生成，请勿手动修改

export interface SettingTypeMap {
    "pi-bridge.piCliPath": string;
    "pi-bridge.piAgentDir": string;
    "pi-bridge.launchArgs": unknown[];
}

/** 每个配置项默认值的字面量类型 */
export interface SettingDefaultMap {
    "pi-bridge.piCliPath": "/home/liuqingxue/.npm-global/bin/pi";
    "pi-bridge.piAgentDir": "~/.pi/agent/";
    "pi-bridge.launchArgs": [];
}

export type SettingName = keyof SettingTypeMap;
export type SettingValue<K extends SettingName> = SettingTypeMap[K];

/** 运行时默认值 */
export const settingDefaults: SettingDefaultMap = {
    "pi-bridge.piCliPath": "/home/liuqingxue/.npm-global/bin/pi",
    "pi-bridge.piAgentDir": "~/.pi/agent/",
    "pi-bridge.launchArgs": [],
};
