import fs from "node:fs/promises"; // 💡 改成异步 IO，不阻塞
import path from "node:path";
import ts from "typescript";

const TARGET_PACKAGE = "@earendil-works/pi-coding-agent";
const IGNORE_DIRS = ["node_modules", ".git", "dist", "out", "build", ".vscode", ".turbo", "scripts", "my", "docs"];
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

const importedSymbols = new Set<string>();
let filesParsed = 0;

async function scanDir(dir: string) {
    console.log(`📂 正在扫描目录: ${dir}`); // 💡 打印当前在哪儿，一卡就知道

    const files = await fs.readdir(dir);

    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = await fs.stat(fullPath);

        if (stat.isDirectory()) {
            if (!IGNORE_DIRS.includes(file)) {
                await scanDir(fullPath);
            }
        } else if (EXTENSIONS.includes(path.extname(file))) {
            // 💡 优化：读取文件用异步
            const content = await fs.readFile(fullPath, "utf8");

            // 快速文本过滤：如果纯文本都没有包名，直接跳过，不建 AST
            if (!content.includes(TARGET_PACKAGE)) continue;

            console.log(`  🔍 发现引用: ${path.relative(process.cwd(), fullPath)}`);
            filesParsed++;
            parseFile(fullPath, content);
        }
    }
}

function parseFile(filePath: string, content: string) {
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);

    function visit(node: ts.Node) {
        if (ts.isImportDeclaration(node)) {
            const moduleSpecifier = node.moduleSpecifier;
            if (ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text === TARGET_PACKAGE) {
                const importClause = node.importClause;
                if (importClause) {
                    if (importClause.name) {
                        importedSymbols.add(`default (as ${importClause.name.text})`);
                    }
                    if (importClause.namedBindings) {
                        if (ts.isNamedImports(importClause.namedBindings)) {
                            for (const element of importClause.namedBindings.elements) {
                                const originalName = element.propertyName ? element.propertyName.text : element.name.text;
                                const aliasName = element.name.text;
                                if (originalName !== aliasName) {
                                    importedSymbols.add(`${originalName} (as ${aliasName})`);
                                } else {
                                    importedSymbols.add(originalName);
                                }
                            }
                        } else if (ts.isNamespaceImport(importClause.namedBindings)) {
                            importedSymbols.add(`* (as ${importClause.namedBindings.name.text})`);
                        }
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(sourceFile);
}

(async () => {
    const start = Date.now();
    console.log(`🔍 开始 AST 扫描...`);

    await scanDir(process.cwd());

    console.log(`\n✅ 扫描完成！耗时 ${Date.now() - start}ms，扫描了 ${filesParsed} 个文件。`);
    if (importedSymbols.size === 0) {
        console.log("没有找到任何导入。");
    } else {
        console.log(`\n📦 被提取的成员 (共 ${importedSymbols.size} 个):\n`);
        Array.from(importedSymbols).sort().forEach(sym => console.log(`  - ${sym}`));
    }
})();