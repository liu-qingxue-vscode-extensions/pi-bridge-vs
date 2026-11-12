// scripts/compile.mjs
// f5 编译
import { execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ==========================================
// 💡 终极环境变量补丁
// ==========================================
// 1. 绝对定位到项目根目录的 node_modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, ".."); // 假设脚本在 scripts/ 下
const localBinPath = path.resolve(projectRoot, "node_modules", ".bin");

// 2. 把 fnm 的 node 路径也加进来 (防止连 node 都找不到)
const fnmPath = `${os.homedir()}/.local/share/fnm/node-versions/v24.1.0/installation/bin`;

// 3. 拼接到 PATH 的最前面
process.env.PATH = `${localBinPath}${path.delimiter}${fnmPath}${path.delimiter}${process.env.PATH}`;



// 注意!!!这里的顺序要讲究
const tasks = [
    // ===== Extension =====
    { cmd: "tsc -p ./ --noEmit", desc: "TS 类型检查 (扩展端)" },
    { cmd: "node scripts/f5/build-extension.mjs", desc: "构建扩展端代码" },
    { cmd: "node scripts/f5/check-patch-reverse.mjs", desc: "检查补丁反转(防止代码被改坏)" },
    // ===== webview =====
    // HTML
    { cmd: "node scripts/f5/sync-html.mjs", desc: "同步 HTML" },
    { cmd: "node scripts/f5/check-html.mjs", desc: "检查 HTML 结构" },
    // CSS
    { cmd: "node scripts/f5/check-style-vars.mjs", desc: "检查 CSS 变量" },
    { cmd: "node scripts/f5/bundle-css.mjs", desc: "打包 CSS" },
    // webview-JS
    { cmd: "tsc -p tsconfig.webview.json --noEmit", desc: "TS 类型检查 (Webview端)" },
    { cmd: "node scripts/f5/build-webview.mjs", desc: "打包 Webview 的JS" },
    // other
    { cmd: "node scripts/f5/sync-katex.mjs", desc: "同步 KaTeX 资源" },
    // ===== Pi =====
    { cmd: "node scripts/f5/check-pi-env.mjs", desc: "检查 Pi 环境" },
    { cmd: "node scripts/f5/check-session-file.mjs", desc: "检查会话文件" },
    { cmd: "npm run check:in-pi", desc: "in-pi 检查" },
    { cmd: "npm run build:in-pi", desc: "in-pi 构建" },
];

console.log("🚀 开始全量编译流程...\n");
const startTime = Date.now();

for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const step = `[${i + 1}/${tasks.length}]`;

    // 打印进度
    process.stdout.write(`${step} ⏳ ${task.desc}... `);

    try {
        // 核心：同步执行命令，如果失败会直接抛出异常
        execSync(task.cmd, { stdio: "inherit" }); // stdio: "inherit" 让脚本自身的彩色输出直接显示在终端
        console.log(`✅ 完成`);
    } catch (error) {
        console.log(`❌ 失败`);
        console.error(`\n💥 在步骤 ${step} 出错：${task.desc}`);
        console.error(`执行命令：${task.cmd}`);
        process.exit(1); // 中断整个流程，并给 npm 返回错误码
    }
}

const duration = ((Date.now() - startTime) / 1000).toFixed(2);
console.log(`\n🎉 编译全部成功！总耗时: ${duration} 秒`);