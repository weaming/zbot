import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { SkillRegistry } from "../../src/skills/skill-registry.js";
import { parseSkillMarkdown } from "../../src/skills/base-skill.js";
import { restoreEnv } from "./test-env.js";

/** 构造一个技能目录（Claude Codex 结构：SKILL.md frontmatter + body + 可带伴生文件）。 */
function makeSkill(skillDir: string, name: string, description: string, extraYaml = ""): void {
    const dir = path.join(skillDir, name);
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "helper.sh"), "#!/bin/sh\necho helper\n");
    fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n${extraYaml}---\n\n# ${name}\n\n技能正文。\n`,
    );
}

describe("skill registry multi-source loading", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-skill-state-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-skill-home-"));
    const userSkillsDir = path.join(stateDir, "skills");
    const agentsSkillsDir = path.join(homeDir, ".agents", "skills");

    let previousStateDir: string | undefined;
    let previousHome: string | undefined;
    let previousTuiPlatform: string | undefined;

    beforeEach(() => {
        previousStateDir = process.env.ZBOT_STATE_DIR;
        previousHome = process.env.HOME;
        previousTuiPlatform = process.env.TUI_PLATFORM;
    });

    afterEach(() => {
        restoreEnv("ZBOT_STATE_DIR", previousStateDir);
        restoreEnv("HOME", previousHome);
        restoreEnv("TUI_PLATFORM", previousTuiPlatform);
        fs.rmSync(stateDir, { recursive: true, force: true });
        fs.rmSync(homeDir, { recursive: true, force: true });
    });

    test("loads skills from user dir with priority over shared dir", async () => {
        makeSkill(userSkillsDir, "alpha", "user-alpha");
        makeSkill(userSkillsDir, "beta", "user-beta");
        makeSkill(agentsSkillsDir, "alpha", "shared-alpha");
        makeSkill(agentsSkillsDir, "gamma", "shared-gamma");

        const registry = new SkillRegistry([userSkillsDir, agentsSkillsDir]);
        await registry.load();

        expect(registry.getSkillNames().sort()).toEqual(["alpha", "beta", "gamma"]);
        expect(registry.getSkillMeta("alpha")?.description).toBe("user-alpha");
        expect(registry.getSkillDir("alpha")).toBe(path.join(userSkillsDir, "alpha"));
        expect(registry.getSkillDir("beta")).toBe(path.join(userSkillsDir, "beta"));
        expect(registry.getSkillDir("gamma")).toBe(path.join(agentsSkillsDir, "gamma"));
    });

    test("init({watch:false}) 只加载不挂监听，close 可摘掉监听", async () => {
        makeSkill(userSkillsDir, "alpha", "user-alpha");

        const registry = new SkillRegistry([userSkillsDir]);
        await registry.init({ watch: false });
        expect(registry.getSkillNames()).toEqual(["alpha"]);
        expect((registry as any).fileWatcher).toBeNull();

        await registry.init();
        expect((registry as any).fileWatcher).not.toBeNull();
        await registry.close();
        expect((registry as any).fileWatcher).toBeNull();
    });

    test("loads ~/.agents/skills in TUI and keeps local skills first", async () => {
        makeSkill(userSkillsDir, "local", "local-skill");
        makeSkill(agentsSkillsDir, "shared", "shared-skill");

        process.env.HOME = homeDir;
        process.env.TUI_PLATFORM = "test";
        process.env.ZBOT_STATE_DIR = stateDir;

        const registry = new SkillRegistry();
        await registry.load();

        expect(registry.getSkillNames().sort()).toEqual(["local", "shared"]);
        expect(registry.getSkillDir("shared")).toBe(path.join(agentsSkillsDir, "shared"));
    });

    test("handles claude-codex style frontmatter with extra fields", async () => {
        makeSkill(userSkillsDir, "alpha", "user-alpha", "allowed-tools:\n  - Bash(git *)\nmodel: sonnet\n");

        process.env.ZBOT_STATE_DIR = stateDir;

        const registry = new SkillRegistry();
        await registry.load();

        expect(registry.hasSkill("alpha")).toBe(true);
        // 额外 yaml 字段不阻塞解析，正文完整保留
        expect(parseSkillMarkdown(path.join(userSkillsDir, "alpha")).systemPrompt).toContain("技能正文");
    });

    test("dir name fallback when frontmatter lacks name", async () => {
        const dir = path.join(userSkillsDir, "bare");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "SKILL.md"), "---\ndescription: no name field\n---\n# Bare\n");

        process.env.ZBOT_STATE_DIR = stateDir;

        const registry = new SkillRegistry();
        await registry.load();

        expect(registry.hasSkill("bare")).toBe(true);
        expect(registry.getSkillMeta("bare")?.description).toBe("no name field");
    });

    // 目录显式注入：不依赖进程环境，也就不会因宿主 ~/.agents/skills 有内容而失真。
    test("empty registry when no skill dir exists", async () => {
        const registry = new SkillRegistry([path.join(stateDir, "empty", "skills")]);
        await registry.load();

        expect(registry.getSkillNames()).toEqual([]);
        expect(registry.buildSkillListing()).toContain("- 暂无可用技能");
    });
});
