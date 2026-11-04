/**
 * slash 命令的纯文本视图：帮助、技能、快捷键。
 *
 * TUI 与会话间投递共用这一份渲染（`--json` 的结构化版本见 `peer-command.ts`）。
 */

import { skillRegistry } from "../skills/skill-registry.js";
import { getAgentsSkillsDir, getUserSkillsDir } from "../utils/runtime-paths.js";
import { SLASH_COMMAND_SPECS } from "./slash-command.js";
import { SHORTCUT_GROUPS } from "./shortcuts.js";

/** 可用命令：直接由命令矩阵生成，避免帮助与实现漂移。 */
export function buildHelpText(): string {
    const width = Math.max(...SLASH_COMMAND_SPECS.map(spec => spec.usage.length));
    const lines = SLASH_COMMAND_SPECS.map(spec => `  ${spec.usage.padEnd(width)}  ${spec.description}`);
    return ["可用命令：", ...lines, "", "会话间投递（session send）支持同样的命令；面板类命令有文本/JSON 等价视图。"].join("\n");
}

/** /skills：列出已加载技能及技能目录位置。 */
export function buildSkillsHelpText(): string {
    const metas = skillRegistry.getAllSkillMetas();
    const lines = metas.length > 0
        ? metas
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((meta) => `  - ${meta.name}: ${meta.description || "（无描述）"}`)
        : ["  （暂无技能）"];
    return [
        "可用技能（会自动扫描并热加载）：",
        ...lines,
        "",
        `技能目录：${getUserSkillsDir()}（用户级，优先） · ${getAgentsSkillsDir()}（共享）`,
        "提示：每个技能为一个子目录，内含 SKILL.md（frontmatter 含 name/description）。",
    ].join("\n");
}

/** /keys：按生效场景列出快捷键。 */
export function buildShortcutsText(): string {
    const lines: string[] = ["快捷键："];
    for (const group of SHORTCUT_GROUPS) {
        lines.push("", `【${group.title}】`);
        for (const entry of group.entries) lines.push(`  ${entry.keys}  ${entry.desc}`);
    }
    return lines.join("\n");
}

/** /skills --json / /keys --json 的共用形状。 */
export function buildSkillsJson(): Array<{ name: string; description: string }> {
    return skillRegistry
        .getAllSkillMetas()
        .map(meta => ({ name: meta.name, description: meta.description ?? "" }))
        .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildShortcutsJson(): Array<{ group: string; keys: string; description: string }> {
    return SHORTCUT_GROUPS.flatMap(group =>
        group.entries.map(entry => ({ group: group.title, keys: entry.keys, description: entry.desc })));
}
