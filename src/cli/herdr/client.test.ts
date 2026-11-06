import { describe, expect, test } from "bun:test";
import { buildCreateTabArgs } from "./client.js";

describe("buildCreateTabArgs", () => {
    test("环境变量拆成 --env KEY=VALUE 两个 token（herdr 只认空格分词）", () => {
        expect(buildCreateTabArgs({
            workspaceId: "w24",
            cwd: "/tmp/x y",
            label: "复审",
            focus: false,
            env: { ZBOT_STATE_DIR: "/s", ZBOT_ENV_FILE: "/e" },
        })).toEqual([
            "tab", "create",
            "--workspace", "w24",
            "--cwd", "/tmp/x y",
            "--label", "复审",
            "--no-focus",
            "--env", "ZBOT_STATE_DIR=/s",
            "--env", "ZBOT_ENV_FILE=/e",
        ]);
    });

    test("--focus 与无 env 时的 argv", () => {
        expect(buildCreateTabArgs({ workspaceId: "w25", cwd: "/tmp", label: "x", focus: true })).toEqual([
            "tab", "create", "--workspace", "w25", "--cwd", "/tmp", "--label", "x", "--focus",
        ]);
    });
});
