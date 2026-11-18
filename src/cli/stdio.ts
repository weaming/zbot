/** 独立 stdio 宿主装配；stdout 专用于 JSONL，日志在运行时初始化前接管。 */
import type { SessionRuntimeCapabilities } from "../control/runtime.js";
import { runStdioProtocol } from "./stdio-protocol.js";
import { parseHeadlessArgs, runHeadless } from "./headless.js";
import type { UserAnswer, UserQuestionRequest } from "../utils/user-question.js";

/** 解析宿主工作目录，不接受模型或外部会话参数。 */
export function parseStdioArgs(argv: string[]): { cwd: string } {
    return parseHeadlessArgs(argv, "stdio");
}

/**
 * stdio 宿主的提问通道：客户端能作答（`question/answer`）就交给它，
 * 没有作答入口时明确取消，不批准任何待确认行为。
 */
export function createStdioCapabilities(
    notify: (method: string, params: unknown) => void,
    ownsSession: (id: string) => boolean,
    ask?: (request: UserQuestionRequest) => Promise<UserAnswer>,
): SessionRuntimeCapabilities {
    return {
        ownsSession,
        askUser: async request => {
            if (ask) return ask(request);
            notify("session/status", { state: "question_cancelled", requestId: request.requestId });
            return { cancelled: true };
        },
    };
}

export async function runStdio(argv: string[]): Promise<void> {
    const { cwd } = parseStdioArgs(argv);
    await runHeadless(cwd, async context => {
        const { registerSessionRuntime } = await import("../control/runtime.js");
        await runStdioProtocol({
            ...context, input: process.stdin, output: process.stdout, closeHost: false,
            readHistory: async (sessionId, limit) => {
                // 只有恢复会话才需要存储，按需加载，不让 stdio 启动多背一层 CLI 依赖。
                const { eventLog } = await import("./session/store.js");
                const last = await eventLog.lastSeq(sessionId);
                if (last <= 0) return [];
                const events = await eventLog.readBefore(sessionId, last + 1, limit);
                return events.map(event => ({ type: event.type, seq: event.seq, ts: event.ts, payload: event.payload }));
            },
            registerRuntime: (notify, ownsSession, ask) =>
                registerSessionRuntime(createStdioCapabilities(notify, ownsSession, ask)),
        });
    });
}
