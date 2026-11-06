/**
 * 分层依赖边界检查：宿主与各前端不得互相反向依赖。
 *
 * 规则表是唯一事实源，测试与命令行共用同一口径：
 * - 引擎层（events / tools / services / control / mcp / skills / types / pricing）
 *   与宿主层（host）、格式化层（format）不得 import 任何前端；
 * - 两个前端（tui / web）互不 import，也都不 import cli；
 * - cli 是装配层，允许 import 任意层（唯一的跨层入口）。
 * - 例外是前端入口 `cli/web.ts`：它装配的是 web 前端，规则按 web 层算，
 *   否则"web 入口不碰任何 TUI 组件"就只是口头约定（见 FRONTEND_ENTRY_LAYERS）。
 *
 * 只检查项目内相对 import（`./x`、`../x`），跳过测试文件与外部包。
 */

import fs from "node:fs";
import path from "node:path";

/** 层名（src 下一级目录）→ 禁止依赖的层。改这里就是改规则。 */
const LAYER_RULES: Record<string, string[]> = {
    events: ["tui", "web", "cli", "host"],
    tools: ["tui", "web", "cli", "host"],
    services: ["tui", "web", "cli", "host"],
    commands: ["tui", "web", "cli", "host"],
    control: ["tui", "web", "cli"],
    mcp: ["tui", "web", "cli"],
    skills: ["tui", "web", "cli"],
    types: ["tui", "web", "cli", "host"],
    pricing: ["tui", "web", "cli", "host"],
    utils: ["tui", "web", "cli", "host"],
    format: ["tui", "web", "cli", "host"],
    host: ["tui", "web", "cli"],
    /** Job 层依赖宿主执行，但不得反过来被宿主依赖，也不认识任何前端。 */
    jobs: ["tui", "web", "cli"],
    tui: ["web"],
    web: ["tui", "cli"],
};

export interface BoundaryViolation {
    /** 违规文件（相对 src 根）。 */
    file: string;
    /** 原始模块说明符。 */
    specifier: string;
    /** 违规层与目标层，便于直接读出方向。 */
    from: string;
    to: string;
}

/**
 * 前端入口按对应前端层校验：`cli/web.ts` 是 web 前端的装配入口，
 * 与 web/ 一样不得反向依赖 tui/ —— 否则"web 入口不碰任何 TUI 组件"就没有守卫。
 */
const FRONTEND_ENTRY_LAYERS: Record<string, string> = {
    "cli/web.ts": "web",
};

/** 递归列出源文件，跳过 .d.ts 与测试文件。 */
function listSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...listSourceFiles(full));
            continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts") || entry.name.endsWith(".test.ts")) continue;
        files.push(full);
    }
    return files;
}

/** 提取 import / import() 里的模块说明符。 */
function extractSpecifiers(source: string): string[] {
    const specifiers: string[] = [];
    const pattern = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
        if (match[1]) specifiers.push(match[1]);
    }
    return specifiers;
}

/** 说明符落在 src 下哪一层；指到 src 之外或外部包时返回 undefined。 */
function resolveLayer(fromFile: string, specifier: string, srcRoot: string): string | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const target = path.resolve(path.dirname(fromFile), specifier);
    const relative = path.relative(srcRoot, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep)[0];
}

/** 扫描 src 根下所有源文件，返回违规清单（空数组表示边界成立）。 */
export function checkImportBoundaries(srcRoot: string): BoundaryViolation[] {
    const violations: BoundaryViolation[] = [];

    for (const file of listSourceFiles(srcRoot)) {
        const relativePath = path.relative(srcRoot, file).split(path.sep).join("/");
        const fromLayer = FRONTEND_ENTRY_LAYERS[relativePath] ?? relativePath.split("/")[0];
        const forbidden = LAYER_RULES[fromLayer!];
        if (!forbidden?.length) continue;

        const source = fs.readFileSync(file, "utf8");
        for (const specifier of extractSpecifiers(source)) {
            const toLayer = resolveLayer(file, specifier, srcRoot);
            if (!toLayer || !forbidden.includes(toLayer)) continue;
            violations.push({
                file: path.relative(srcRoot, file),
                specifier,
                from: fromLayer!,
                to: toLayer,
            });
        }
    }

    return violations;
}

if (import.meta.main) {
    const srcRoot = path.resolve(import.meta.dir, "..");
    const violations = checkImportBoundaries(srcRoot);
    if (violations.length === 0) {
        process.stdout.write("依赖边界检查通过\n");
    } else {
        for (const item of violations) {
            process.stderr.write(`✗ ${item.from} → ${item.to}：${item.file}（${item.specifier}）\n`);
        }
        process.exitCode = 1;
    }
}
