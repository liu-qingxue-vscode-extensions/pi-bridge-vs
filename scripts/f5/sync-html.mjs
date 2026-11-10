// scripts/sync-html.mjs
import * as fs from "node:fs";
import * as path from "node:path";

const rootDir = process.cwd();
// 假设你的 HTML 源码在 webview-src 目录下 (如果不在，请修改这里)
const srcDir = path.join(rootDir, "webview-src");
const destDir = path.join(rootDir, "dist", "webview");

if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

const htmlFiles = fs.readdirSync(srcDir).filter(f => f.endsWith(".html"));

for (const file of htmlFiles) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);
    fs.copyFileSync(srcPath, destPath);
    console.log(`  ✓ 已同步 ${file} -> dist/webview/`);
}