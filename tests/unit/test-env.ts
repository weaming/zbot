/**
 * 测试环境隔离：把会话/状态目录指向临时目录，并在清理时恢复原值。
 *
 * 持久化数据路径统一使用 ZBOT_STATE_DIR。
 * （bunfig.toml 的 preload 已全局删除一次，这里再显式处理，保证单文件直跑也安全。）
 */

import fs from "fs";
import os from "os";
import path from "path";

export interface TmpStateDir {
    /** 临时目录绝对路径。 */
    dir: string;
    /** 删除临时目录并恢复环境变量。 */
    cleanup: () => void;
}

/** 创建临时状态目录并设为应用数据根。 */
export function useTmpStateDir(prefix: string): TmpStateDir {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const previousStateDir = process.env.ZBOT_STATE_DIR;

    process.env.ZBOT_STATE_DIR = dir;

    return {
        dir,
        cleanup: () => {
            fs.rmSync(dir, { recursive: true, force: true });
            restoreEnv("ZBOT_STATE_DIR", previousStateDir);
        },
    };
}

/** 恢复环境变量：原值为 undefined 时删除而不是写回字符串 "undefined"。 */
export function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
    } else {
        process.env[name] = value;
    }
}

/**
 * 清空与模型/会话相关的进程环境，返回还原函数。
 *
 * 配置已全面迁到 config.yaml（见 env-isolation.ts 的删除清单），这里只需处理
 * 用例自己会设置的运行期变量；preload 已删过一次，本函数保证单文件直跑也一致。
 */
export function isolateModelEnv(): () => void {
    const names = ["ZBOT_STATE_DIR", "ZBOT_CONFIG_FILE", "ZBOT_SESSION_ID", "TUI_CWD"];
    const saved = new Map(names.map(name => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    return () => {
        for (const [name, value] of saved) restoreEnv(name, value);
    };
}
