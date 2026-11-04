export type ChatApiProtocol = "responses" | "chat_completions";

/** 支持的协议清单：命令解析、面板与校验共用这一份。 */
export const CHAT_API_PROTOCOLS = ["chat_completions", "responses"] as const satisfies readonly ChatApiProtocol[];

export interface ChatModelSelection {
    protocol: ChatApiProtocol;
    model: string;
    reasoningEffort?: string;
}
