#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const currentFilePath = fileURLToPath(import.meta.url);
const rootDir = path.dirname(path.dirname(path.dirname(currentFilePath)));

const DEFAULT_TS_PATH = path.join(rootDir, "src", "types", "pi-type.ts");

const pitypesrc = [
    "node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts",
    "node_modules/@earendil-works/pi-coding-agent/dist/modes/json-event.d.ts"
];

function createProgram() {
    const rootNames = pitypesrc.map(p => path.resolve(rootDir, p));
    for (const file of rootNames) {
        if (!fs.existsSync(file)) {
            throw new Error(`找不到文件: ${file}。请确保已安装依赖。`);
        }
    }

    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        strict: true,
        skipLibCheck: true,
    };

    return ts.createProgram(rootNames, options);
}

/**
 * 💡 升级：支持提取任意指定的属性字段
 */
function extractLiterals(
    program: ts.Program,
    checker: ts.TypeChecker,
    filePath: string,
    typeName: string,
    propName: string = "type" // 默认提取 type 字段
): string[] {
    const absPath = path.resolve(rootDir, filePath);
    const sourceFile = program.getSourceFile(absPath) || program.getSourceFiles().find(f => f.fileName.endsWith(path.basename(filePath)));

    if (!sourceFile) throw new Error(`无法找到文件: ${filePath}`);

    let targetType: ts.Type | undefined;

    function visit(node: ts.Node) {
        if (
            (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
            node.name.text === typeName
        ) {
            targetType = checker.getTypeAtLocation(node);
        }
        if (!targetType) ts.forEachChild(node, visit);
    }
    visit(sourceFile);

    if (!targetType) throw new Error(`在 ${filePath} 中找不到类型 ${typeName}`);

    const literals = new Set<string>();

    function traverseType(type: ts.Type) {
        if (type.isUnion()) {
            type.types.forEach(traverseType);
            return;
        }
        if (type.isIntersection()) {
            type.types.forEach(traverseType);
            return;
        }

        // 💡 核心改动：用传入的 propName 去获取属性
        const targetProp = type.getProperty(propName);
        if (targetProp) {
            const propDeclaration = targetProp.valueDeclaration || targetProp.declarations?.[0];
            if (propDeclaration) {
                const propType = checker.getTypeOfSymbolAtLocation(targetProp, propDeclaration);

                if (propType.isStringLiteral()) {
                    literals.add(propType.value);
                } else if (propType.isUnion()) {
                    propType.types.forEach(pt => {
                        if (pt.isStringLiteral()) literals.add(pt.value);
                    });
                }
            }
        }
    }

    traverseType(targetType);
    return Array.from(literals).sort();
}

/**
 * 💡 升级：生成包含 command 的新数组
 */
function generateCode(
    rpcResponseTypes: string[],
    rpcCommands: string[],
    sessionTypes: string[]
): string {
    const formatArray = (arr: string[]) => arr.map(s => `  "${s}",`).join("\n");

    return `// ⚠️ 自动生成，请勿手动修改
// 生成时间: ${new Date().toLocaleString()}

// =========================================
// 1. RpcResponse 相关
// =========================================

/** RpcResponse 的 type 字段字面量 (通常只有 "response") */
export const RPC_RESPONSE_TYPES = [
${formatArray(rpcResponseTypes)}
] as const;
export type RpcResponseType = typeof RPC_RESPONSE_TYPES[number];

/** RpcResponse 的 command 字段字面量 (具体业务分发) */
export const RPC_COMMANDS = [
${formatArray(rpcCommands)}
] as const;
export type RpcCommandType = typeof RPC_COMMANDS[number];

// =========================================
// 2. JsonAgentSessionEvent 相关
// =========================================

/** JsonAgentSessionEvent 的 type 字段字面量数组 */
export const JSON_AGENT_SESSION_EVENT_TYPES = [
${formatArray(sessionTypes)}
] as const;
export type JsonAgentSessionEventType = typeof JSON_AGENT_SESSION_EVENT_TYPES[number];

// =========================================
// 3. 联合与校验
// =========================================

/** 两者联合的 Type */
export type piPkgType = RpcResponseType | JsonAgentSessionEventType;

/** 两者联合的字符串数组 (用于运行时判断) */
export const PI_RESPONSE_TYPES = [
  ...RPC_RESPONSE_TYPES,
  ...JSON_AGENT_SESSION_EVENT_TYPES,
] as const;

/** 运行时校验：判断任意字符串是否属于 piResponseType */
export function isPiResponseType(s: string): s is piPkgType {
  return (PI_RESPONSE_TYPES as readonly string[]).includes(s);
}

/** 运行时校验：判断是否为合法的 RpcCommand */
export function isRpcCommand(s: string): s is RpcCommandType {
  return (RPC_COMMANDS as readonly string[]).includes(s);
}
`;
}

const programCli = new Command();

programCli
    .name('gen-pi-types')
    .description('基于 AST 生成 pi 的通信类型及数组')
    .version('1.0.0');

programCli
    .command('gen')
    .action(() => {
        console.log("🔍 正在初始化 TypeScript 编译器...");

        try {
            const program = createProgram();
            const checker = program.getTypeChecker();

            console.log("🔍 正在解析 RpcResponse 的 type 和 command...");
            // 提取 RpcResponse 的 type 字段
            const rpcResponseTypes = extractLiterals(program, checker, pitypesrc[0], "RpcResponse", "type");
            // 提取 RpcResponse 的 command 字段
            const rpcCommands = extractLiterals(program, checker, pitypesrc[0], "RpcResponse", "command");

            if (rpcCommands.length === 0) throw new Error("RpcResponse 没有提取到任何 command");

            console.log("🔍 正在解析 JsonAgentSessionEvent...");
            const sessionTypes = extractLiterals(program, checker, pitypesrc[1], "JsonAgentSessionEvent", "type");

            console.log("📦 正在生成代码...");
            const code = generateCode(rpcResponseTypes, rpcCommands, sessionTypes);

            const outDir = path.dirname(DEFAULT_TS_PATH);
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(DEFAULT_TS_PATH, code, "utf8");

            console.log(`\n✅ 成功！提取结果:`);
            console.log(`   - RpcResponse.type: ${rpcResponseTypes.length} 个`);
            console.log(`   - RpcResponse.command: ${rpcCommands.length} 个`);
            console.log(`   - JsonAgentSessionEvent.type: ${sessionTypes.length} 个`);
            console.log(`   - 输出文件: ${DEFAULT_TS_PATH}`);
        } catch (error: any) {
            console.error(`\n❌ 生成失败: ${error.message}`);
            process.exit(1);
        }
    });

programCli.parse(process.argv);