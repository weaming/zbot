/**
 * 观察 socket 的路径约定：sessions/observe/<sessionId>.sock。
 *
 * 与控制 socket 的唯一区别是**它不表达归属**：归属永远只由
 * sessions/control/<id>.sock 表达，观察 socket 是持有者顺手开的只读旁路，
 * 残留文件随时可删，不会被误当成"有人持有这个会话"。
 */

import fs from "fs";
import path from "path";
import { getSessionsDir } from "../utils/runtime-paths.js";
import { sanitizeSessionId } from "../utils/session-id.js";

const SOCKET_SUFFIX = ".sock";

function getObserveDir(): string {
    return getSessionsDir("observe");
}

/** 单个会话的观察 socket 路径。 */
export function getObserveSocketPath(sessionId: string): string {
    return path.join(getObserveDir(), `${sanitizeSessionId(sessionId)}${SOCKET_SUFFIX}`);
}

/** 按需创建 socket 目录。 */
export function ensureObserveDir(): void {
    fs.mkdirSync(getObserveDir(), { recursive: true });
}

/** 列出磁盘上存在观察 socket 文件的会话 id；目录不存在时返回空数组。 */
export function listObserveSessionIds(): string[] {
    try {
        return fs
            .readdirSync(getObserveDir())
            .filter(name => name.endsWith(SOCKET_SUFFIX))
            .map(name => name.slice(0, -SOCKET_SUFFIX.length));
    } catch {
        return [];
    }
}
