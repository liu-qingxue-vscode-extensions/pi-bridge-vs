#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

// ---------- 类型 ----------

type PropertySchema = {
    type?: string | string[];
    default?: unknown;
    description?: string;
    enum?: unknown[];
    [key: string]: unknown;
};

type ConfigurationGroup = {
    title?: string;
    properties?: Record<string, PropertySchema>;
};

type PackageJson = {
    contributes?: {
        configuration?: ConfigurationGroup | ConfigurationGroup[];
    };
    [key: string]: unknown;
};

// ---------- 读写 ----------

function loadPkg(filePath: string): { abs: string; pkg: PackageJson } {
    const abs = path.resolve(process.cwd(), filePath);
    const pkg = JSON.parse(fs.readFileSync(abs, 'utf8')) as PackageJson;
    return { abs, pkg };
}

function savePkg(abs: string, pkg: PackageJson) {
    fs.writeFileSync(abs, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
}

function getGroups(pkg: PackageJson): ConfigurationGroup[] {
    const raw = pkg.contributes?.configuration;
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
}

function collectAllProps(pkg: PackageJson): { key: string; schema: PropertySchema }[] {
    const out: { key: string; schema: PropertySchema }[] = [];
    for (const group of getGroups(pkg)) {
        for (const [key, schema] of Object.entries(group.properties ?? {})) {
            out.push({ key, schema });
        }
    }
    return out;
}

function findProp(
    pkg: PackageJson,
    key: string,
): { props: Record<string, PropertySchema> } | null {
    for (const group of getGroups(pkg)) {
        const props = group.properties ?? {};
        if (key in props) return { props };
    }
    return null;
}

function ensureProps(pkg: PackageJson): Record<string, PropertySchema> {
    if (!pkg.contributes) pkg.contributes = {};
    const groups = getGroups(pkg);

    if (groups.length === 0) {
        const g: ConfigurationGroup = { title: 'Configuration', properties: {} };
        pkg.contributes.configuration = g;
        return g.properties!;
    }

    const first = groups[0];
    if (!first.properties) first.properties = {};
    return first.properties;
}

/** 把字符串解析成 JSON 值：数字、布尔、null、对象/数组都认 */
function parseValue(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

// ---------- 代码生成 ----------

function toTsType(t: string | string[] | undefined): string {
    if (!t) return 'unknown';
    if (Array.isArray(t)) return t.map(toTsType).join(' | ');

    const map: Record<string, string> = {
        string: 'string',
        number: 'number',
        integer: 'number',
        boolean: 'boolean',
        null: 'null',
        object: 'Record<string, unknown>',
        array: 'unknown[]',
    };
    return map[t] ?? 'unknown';
}

function toValueType(schema: PropertySchema): string {
    if (schema.enum && Array.isArray(schema.enum) && schema.enum.length > 0) {
        return schema.enum.map((v) => JSON.stringify(v)).join(' | ');
    }
    return toTsType(schema.type);
}

function toDefaultType(schema: PropertySchema): string {
    if (schema.default === undefined) return 'undefined';
    return JSON.stringify(schema.default);
}

function generateTs(pkg: PackageJson): string {
    const items = collectAllProps(pkg);
    if (items.length === 0) return '// 没有找到任何配置项\n';

    const typeEntries = items
        .map(({ key, schema }) => `  ${JSON.stringify(key)}: ${toValueType(schema)};`)
        .join('\n');

    // 字面量类型：值原样写进 interface
    const defaultTypeEntries = items
        .map(({ key, schema }) => `  ${JSON.stringify(key)}: ${toDefaultType(schema)};`)
        .join('\n');

    // 运行时对象：值原样写进 const
    const defaultValueEntries = items
        .map(({ key, schema }) => `  ${JSON.stringify(key)}: ${toDefaultType(schema)},`)
        .join('\n');

    return `// 自动生成，请勿手动修改

export interface SettingTypeMap {
${typeEntries}
}

/** 每个配置项默认值的字面量类型 */
export interface SettingDefaultMap {
${defaultTypeEntries}
}

export type SettingName = keyof SettingTypeMap;
export type SettingValue<K extends SettingName> = SettingTypeMap[K];

/** 运行时默认值 */
export const SettingDefaults: SettingDefaultMap = {
${defaultValueEntries}
};
`;
}

// ---------- CLI ----------

const program = new Command();

program
    .name('conf')
    .description('管理 VS Code 扩展的 contributes.configuration')
    .version('1.0.0')
    .option('-f, --file <path>', 'package.json 路径', 'package.json');

// list
program
    .command('list')
    .description('列出所有配置项')
    .action(() => {
        const { pkg } = loadPkg(program.opts().file);
        const items = collectAllProps(pkg);

        if (items.length === 0) {
            console.log('没有配置项。');
            return;
        }

        for (const { key, schema } of items) {
            const def = schema.default === undefined ? '-' : JSON.stringify(schema.default);
            console.log(`  ${key}  (type=${schema.type ?? '?'}, default=${def})`);
        }
    });

// get
program
    .command('get <key>')
    .description('查看某个配置项')
    .action((key: string) => {
        const { pkg } = loadPkg(program.opts().file);
        const found = findProp(pkg, key);
        if (!found) {
            console.error(`找不到配置项: ${key}`);
            process.exit(1);
        }
        console.log(JSON.stringify(found.props[key], null, 2));
    });

// set-default
program
    .command('set-default <key> <value>')
    .description('修改配置项的默认值，value 会被解析成 JSON')
    .action((key: string, value: string) => {
        const { abs, pkg } = loadPkg(program.opts().file);
        const found = findProp(pkg, key);
        if (!found) {
            console.error(`找不到配置项: ${key}`);
            process.exit(1);
        }
        found.props[key].default = parseValue(value);
        savePkg(abs, pkg);
        console.log(`已设置 ${key}.default = ${JSON.stringify(found.props[key].default)}`);
    });

// set-desc
program
    .command('set-desc <key> <text>')
    .description('修改配置项的描述')
    .action((key: string, text: string) => {
        const { abs, pkg } = loadPkg(program.opts().file);
        const found = findProp(pkg, key);
        if (!found) {
            console.error(`找不到配置项: ${key}`);
            process.exit(1);
        }
        found.props[key].description = text;
        savePkg(abs, pkg);
        console.log(`已更新 ${key} 的描述`);
    });

// set-type
program
    .command('set-type <key> <type>')
    .description('修改配置项类型，如 boolean / number / string / array')
    .action((key: string, type: string) => {
        const { abs, pkg } = loadPkg(program.opts().file);
        const found = findProp(pkg, key);
        if (!found) {
            console.error(`找不到配置项: ${key}`);
            process.exit(1);
        }
        found.props[key].type = type;
        savePkg(abs, pkg);
        console.log(`已设置 ${key}.type = ${type}`);
    });

// add
program
    .command('add <key>')
    .description('添加一个配置项')
    .option('-t, --type <type>', '类型', 'string')
    .option('-d, --default <value>', '默认值')
    .option('--desc <text>', '描述')
    .action((key: string, opts: { type: string; default?: string; desc?: string }) => {
        const { abs, pkg } = loadPkg(program.opts().file);

        if (findProp(pkg, key)) {
            console.error(`配置项已存在: ${key}`);
            process.exit(1);
        }

        const props = ensureProps(pkg);
        const schema: PropertySchema = { type: opts.type };

        if (opts.default !== undefined) schema.default = parseValue(opts.default);
        if (opts.desc) schema.description = opts.desc;

        props[key] = schema;
        savePkg(abs, pkg);
        console.log(`已添加 ${key}`);
    });

// remove
program
    .command('remove <key>')
    .alias('rm')
    .description('删除一个配置项')
    .action((key: string) => {
        const { abs, pkg } = loadPkg(program.opts().file);
        const found = findProp(pkg, key);
        if (!found) {
            console.error(`找不到配置项: ${key}`);
            process.exit(1);
        }
        delete found.props[key];
        savePkg(abs, pkg);
        console.log(`已删除 ${key}`);
    });

// gen
program
    .command('gen')
    .description('生成 TypeScript 类型定义')
    .option('-o, --out <file>', '输出到文件（默认打印到 stdout）')
    .action((opts: { out?: string }) => {
        const { pkg } = loadPkg(program.opts().file);
        const code = generateTs(pkg);

        if (opts.out) {
            const abs = path.resolve(process.cwd(), opts.out);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, code, 'utf8');
            console.log(`已写入 ${opts.out}`);
        } else {
            process.stdout.write(code);
        }
    });

program.parse();