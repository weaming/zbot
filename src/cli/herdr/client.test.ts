import { describe, expect, test } from "bun:test";
import { buildCreateTabArgs, readHerdrCaller, readHerdrSpawnContext } from "./client.js";

describe("buildCreateTabArgs", () => {
    test("环境变量拆成 --env KEY=VALUE 两个 token（herdr 只认空格分词）", () => {
        expect(buildCreateTabArgs({
            workspaceId: "w24",
            cwd: "/tmp/x y",
            label: "复审",
            focus: false,
            env: { ZBOT_STATE_DIR: "/s", ZBOT_CONFIG_FILE: "/e" },
        })).toEqual([
            "tab", "create",
            "--workspace", "w24",
            "--cwd", "/tmp/x y",
            "--label", "复审",
            "--no-focus",
            "--env", "ZBOT_STATE_DIR=/s",
            "--env", "ZBOT_CONFIG_FILE=/e",
        ]);
    });

    test("--focus 与无 env 时的 argv", () => {
        expect(buildCreateTabArgs({ workspaceId: "w25", cwd: "/tmp", label: "x", focus: true })).toEqual([
            "tab", "create", "--workspace", "w25", "--cwd", "/tmp", "--label", "x", "--focus",
        ]);
    });
});

describe("readHerdrSpawnContext 与 readHerdrCaller", () => {
    test("HC_TERMINAL_ID 存在时切换到 hc 后端", () => {
        const env = {
            HC_TERMINAL_ID: "t1k",
            HC_BIN_PATH: "/usr/local/bin/hc",
        } as NodeJS.ProcessEnv;
        expect(readHerdrSpawnContext(env)).toEqual({
            backend: "hc",
            binPath: "/usr/local/bin/hc",
            workspaceId: "hc",
        });
        expect(readHerdrCaller(env)).toEqual({
            workspaceId: "hc",
            tabId: "t1k",
            paneId: "t1k",
        });
    });

    test("HERDR_ENV=1 优先于 HC_TERMINAL_ID", () => {
        const env = {
            HERDR_ENV: "1",
            HERDR_BIN_PATH: "/opt/homebrew/bin/herdr",
            HERDR_WORKSPACE_ID: "w1",
            HERDR_TAB_ID: "w1:t1",
            HERDR_PANE_ID: "w1:p1",
            HC_TERMINAL_ID: "t1k",
            HC_BIN_PATH: "/usr/local/bin/hc",
        } as NodeJS.ProcessEnv;
        expect(readHerdrSpawnContext(env)).toEqual({
            backend: "herdr",
            binPath: "/opt/homebrew/bin/herdr",
            workspaceId: "w1",
        });
    });
});
