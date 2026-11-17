/**
 * 观察 socket 的残留回收。
 *
 * 观察 socket 从不表达归属，所以它的清理也不能替代归属判定：
 * 只回收「连不上的文件」——持有者已经退出（含被 kill）留下的死文件。
 * 连得上就保留：可能是别的实例正在服务，也可能只是忙得还没读帧。
 */

import fs from "fs";
import { getObserveSocketPath, listObserveSessionIds } from "./paths.js";
import { probeObserveSocket } from "./server.js";

/** 回收无人应答的观察 socket 文件，返回被清掉的会话 id。 */
export async function cleanupStaleObserveSockets(timeoutMs?: number): Promise<string[]> {
    const removed: string[] = [];
    for (const sessionId of listObserveSessionIds()) {
        const socketPath = getObserveSocketPath(sessionId);
        if (await probeObserveSocket(socketPath, timeoutMs)) continue;
        try {
            fs.unlinkSync(socketPath);
            removed.push(sessionId);
        } catch {
            // 已被别的实例清理
        }
    }
    return removed;
}
