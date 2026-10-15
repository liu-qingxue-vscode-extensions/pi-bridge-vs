import * as vscode from "vscode";
import { type SettingName, type SettingValue } from "./vs-settings-type.js";

export function getSetting<K extends SettingName>(setting: K): SettingValue<K> | undefined {
    const i = setting.lastIndexOf(".");
    const section = setting.slice(0, i);
    const key = setting.slice(i + 1);

    return vscode.workspace
        .getConfiguration(section)
        .get<SettingValue<K>>(key);
}