/**
 * `zbot herdr`：herdr 相关操作的入口 —— `spawn`（新建标签页 + 新会话 + 首条输入）与
 * `teardown`（归档会话 + 关标签页）。
 *
 * 与 `zbot session` 同层：在 dotenv / 宿主初始化之前分流 —— 这条路径只调 herdr CLI
 * 和会话事件日志，不启动模型，也不该把 TUI/HTTP 的模块图拉进进程。
 */

import { HERDR_CLI_USAGE } from "./help.js";
import { parseHerdrArgs } from "./herdr/args.js";
import { runSpawn, type SpawnDeps } from "./herdr/spawn.js";
import { runTeardown, type TeardownDeps } from "./herdr/teardown.js";

type HerdrDeps = SpawnDeps & TeardownDeps;

/** 入口：按解析出来的命令分派。 */
export async function runHerdrCli(argv: string[], deps: HerdrDeps = {}): Promise<void> {
    const command = parseHerdrArgs(argv);
    const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
    switch (command.kind) {
        case "help":
            write(`${HERDR_CLI_USAGE}\n`);
            return;
        case "spawn":
            return runSpawn(command, { ...deps, write });
        case "teardown":
            return runTeardown(command, { ...deps, write });
    }
}
