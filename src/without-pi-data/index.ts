

import { getCwd } from "./util.js"
export { getSetting as getVSSetting } from "./vs-settings.js";
export { settingDefaults } from "./vs-settings-type.js"



const cwd: string = getCwd()

interface ChatInitData {
    cwd: string
}
export const chatInitData: ChatInitData = {
    cwd: cwd
}
