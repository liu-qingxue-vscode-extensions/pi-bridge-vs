#!/usr/bin/env node
/**
 * sync-to-ext —— 把编译产物同步进已安装的扩展目录
 *
 * [为什么要这一步]
 *   扩展是 vsix 安装在 ~/.vscode-oss/extensions/<publisher>.<name>-<version>/，
 *   它加载的是【那个目录里的 dist/】，不是项目里的 dist/。
 *   改完代码只 npm run compile 的话，reload window 拿到的还是旧文件。
 *
 * [为什么不用软链]
 *   试过把 dist 软链到项目目录：扩展能激活，但 webview 全部 404。
 *   VS Code 给 webview 提供资源走自己的资源服务器（file+.vscode-resource...），
 *   它会校验路径必须在扩展目录内。软链解析后跑到了项目目录，直接拒绝。
 *   症状是 HTML 骨架在、CSS/JS 全没加载 —— 内容全挤在左上角。
 *
 * [为什么失败不算错]
 *   没装过扩展（或者版本号变了）时目录不存在，这时候同步没意义但编译
 *   本身是成功的，不该让整个 F5 流程报错中断。
 */
import { cpSync, existsSync, rmSync, copyFileSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const ROOT = process.cwd();

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const dirName = `${pkg.publisher}.${pkg.name}-${pkg.version}`;
const dest = join(os.homedir(), ".vscode-oss", "extensions", dirName);

if (!existsSync(dest)) {
    console.log(`未安装（${dirName}），跳过同步`);
    console.log("装过一次 vsix 之后，这一步才会开始工作");
    process.exit(0);
}

// 目标如果还是软链（之前手工试过），先拆掉换回真实目录
const destDist = join(dest, "dist");
try {
    if (lstatSync(destDist).isSymbolicLink()) {
        rmSync(destDist, { force: true });
        console.log("目标 dist 是软链，已拆掉重建");
    }
} catch {
    // 不存在就走下面的复制
}

rmSync(destDist, { recursive: true, force: true });
cpSync(join(ROOT, "dist"), destDist, { recursive: true });

// package.json 也要同步：新增配置项后 VS Code 从扩展目录的这份读
copyFileSync(join(ROOT, "package.json"), join(dest, "package.json"));

console.log(`已同步到 ${dirName}`);
