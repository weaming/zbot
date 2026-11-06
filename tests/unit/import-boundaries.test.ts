/**
 * 分层依赖边界守卫：引擎层与宿主层不得反向依赖前端，
 * 两个前端（tui / web）互不依赖。违规时这里会直接失败并列出方向。
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { expect, test } from "bun:test";
import { checkImportBoundaries } from "../../src/scripts/check-import-boundaries.js";

const SRC_ROOT = path.resolve(import.meta.dir, "../../src");

test("分层依赖无违规", () => {
    const violations = checkImportBoundaries(SRC_ROOT).map(item => `${item.from} → ${item.to}：${item.file}（${item.specifier}）`);

    expect(violations).toEqual([]);
});

test("检查器能检出反向依赖（自测，防止空转）", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-boundary-"));
    try {
        fs.mkdirSync(path.join(root, "host"));
        fs.mkdirSync(path.join(root, "tui"));
        fs.writeFileSync(path.join(root, "tui", "b.ts"), "export const b = 1;\n");
        fs.writeFileSync(path.join(root, "host", "a.ts"), 'import { b } from "../tui/b.js";\n');

        const violations = checkImportBoundaries(root);

        expect(violations).toEqual([
            { file: "host/a.ts", specifier: "../tui/b.js", from: "host", to: "tui" },
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("web 入口按 web 层校验，不得依赖 tui/", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-boundary-web-"));
    try {
        fs.mkdirSync(path.join(root, "tui"));
        fs.mkdirSync(path.join(root, "cli"));
        fs.writeFileSync(path.join(root, "tui", "terminal-state.ts"), "export const reset = 1;\n");
        fs.writeFileSync(
            path.join(root, "cli", "web.ts"),
            'import { reset } from "../tui/terminal-state.js";\n',
        );

        const violations = checkImportBoundaries(root);

        expect(violations).toEqual([
            {
                file: "cli/web.ts",
                specifier: "../tui/terminal-state.js",
                from: "web",
                to: "tui",
            },
        ]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
