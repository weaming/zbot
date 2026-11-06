/**
 * 宣传面守卫：内部常驻宿主（`zbot web`，见 docs/web-api.md）不对外宣传。
 *
 * 这条规则靠人工 grep 守不住（改文档时很容易顺手加回去），所以钉成测试：
 * 用户会先看到的面（CLI 总览、README、会话 / herdr 文档、技能文档）里不许出现
 * `web` / `serve` 这两个词。允许出现的只有它自己的 `docs/web-api.md`，
 * 以及不随仓库走的 `.agents/warmup.md`。
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
    HERDR_CLI_USAGE,
    MAIN_CLI_USAGE,
    PRINT_CLI_USAGE,
    RESUME_CLI_USAGE,
    SESSION_CLI_USAGE,
} from "../../src/cli/help.js";
import { MCP_CLI_USAGE } from "../../src/mcp/help.js";

const ROOT = path.resolve(import.meta.dir, "..", "..");
/** 单独的 web / serve 词（`server`、`observe`、`WebMCP` 不算；`web_search` 由 `(?!_)` 放过）。 */
const FORBIDDEN_WORD = /\b(web|serve)\b(?!_)/i;
/** `ZBOT_WEB_TOKEN` 这类下划线连接的环境变量名：`_` 属 `\w`，`\b` 抓不到。 */
const FORBIDDEN_ENV = /(?:ZBOT_)?(?:WEB|SERVE)_[A-Z0-9]+/;

/** 命中的第一个违规片段；`web_search` 这类托管工具名不算（下面 `(?!_)` 会放过）。 */
function forbiddenHit(text: string): string | null {
    return FORBIDDEN_WORD.exec(text)?.[0] ?? FORBIDDEN_ENV.exec(text)?.[0] ?? null;
}

function read(relative: string): string {
    return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/** 递归收 markdown：技能目录将来加 references/ 之类也不会漏扫。 */
function markdownUnder(relative: string): string[] {
    const dir = path.join(ROOT, relative);
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) return markdownUnder(child);
        return entry.name.endsWith(".md") ? [child] : [];
    });
}

/** 收 README、docs（除自身文档）与技能目录下的 markdown。 */
function publicDocs(): string[] {
    const docs = fs.readdirSync(path.join(ROOT, "docs"))
        .filter(name => name.endsWith(".md") && name !== "web-api.md")
        .map(name => `docs/${name}`);
    return ["README.md", ...docs, ...markdownUnder("skills")];
}

describe("宣传面不含内部常驻宿主的关键词", () => {
    test("README / docs / skills 都零提及", () => {
        const files = publicDocs();

        expect(files.length).toBeGreaterThan(5);
        for (const file of files) {
            expect({ file, hit: forbiddenHit(read(file)) }).toEqual({ file, hit: null });
        }
    });

    test("CLI 用法文本（除它自己的 --help）都零提及", () => {
        // WEB_CLI_USAGE 是它自己的用法页，只在显式 `zbot web --help` 时出现，不在守卫范围
        const usages = {
            MAIN_CLI_USAGE, PRINT_CLI_USAGE, SESSION_CLI_USAGE, RESUME_CLI_USAGE,
            HERDR_CLI_USAGE, MCP_CLI_USAGE,
        };
        for (const [name, usage] of Object.entries(usages)) {
            expect({ name, hit: forbiddenHit(usage) }).toEqual({ name, hit: null });
        }
    });
});
