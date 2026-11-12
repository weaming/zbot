export type ChatApiProtocol = "responses" | "chat_completions";

/** 支持的协议清单：命令解析、面板与校验共用这一份。 */
export const CHAT_API_PROTOCOLS = ["chat_completions", "responses"] as const satisfies readonly ChatApiProtocol[];

/**
 * 会话生效的模型选择。
 * `provider` 指向 config.yaml 里的服务名，`protocol` 随 provider 固定；
 * `model` 允许不在 provider.models 里（面板手输的临时模型，仅当前会话生效）。
 */
export interface ChatModelSelection {
    provider: string;
    protocol: ChatApiProtocol;
    model: string;
    reasoningEffort?: string;
}
