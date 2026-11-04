/**
 * 在宿主里跑一轮并把最终结果写到 stdout。
 *
 * `resume -p` 与 `session run` 共用：认领、运行时初始化与宿主生命周期由调用方负责，
 * 这里只管订阅事件、处理中断信号与输出形态。
 */

import type { AgentEvent } from "../events/agent-events.js";
import type { SessionEventSource, SessionTurnHost } from "../host/session-host-types.js";

/** 跑一轮只需要订阅事件与驱动/中止回合。 */
type TurnHost = Pick<SessionEventSource, "subscribeEvents"> & Pick<SessionTurnHost, "sendMessage" | "abortSession">;

export interface HostTurnOptions {
    host: TurnHost;
    sessionId: string;
    prompt: string;
    json: boolean;
    write: (text: string) => void;
}

/** 从一个回合新落盘的事件里取最终 assistant 文本与工具调用次数。 */
export function extractTurnResult(events: AgentEvent[]): { content: string; toolCalls: number } {
    let content = "";
    let toolCalls = 0;
    for (const event of events) {
        if (event.type !== "turn_message") continue;
        const message = event.payload.message;
        if (message.role !== "assistant") continue;
        if (typeof message.content === "string" && message.content.trim()) {
            content = message.content;
        }
        toolCalls += message.tool_calls?.length ?? 0;
    }
    return { content, toolCalls };
}

/** 续聊一轮 + 输出；认领与宿主生命周期由调用方负责。 */
export async function runHostTurn(options: HostTurnOptions): Promise<void> {
    const { host, sessionId, prompt, json, write } = options;
    const events: AgentEvent[] = [];
    const unsubscribe = host.subscribeEvents((id, event) => {
        if (id === sessionId && event) events.push(event);
    });
    const abort = (code: 130 | 143) => () => {
        process.exitCode = code;
        void host.abortSession(sessionId);
    };
    const onSigint = abort(130);
    const onSigterm = abort(143);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    try {
        const result = await host.sendMessage(sessionId, prompt);
        unsubscribe();
        const { content, toolCalls } = extractTurnResult(events);
        if (json) {
            write(`${JSON.stringify({
                sessionId,
                content,
                aborted: result.aborted === true,
                toolCalls,
            })}\n`);
        } else {
            write(`${content}\n`);
        }
    } finally {
        unsubscribe();
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
    }
}
