/** 判断 Responses 是否使用 WebSocket；未显式配置时按模型名启发式。 */
export function isResponsesWebSocketEnabled(configured: boolean | undefined, model?: string): boolean {
    return configured ?? isGptModel(model);
}

/** 是否允许上游保存 Responses（未配置即关闭）。 */
export function isResponsesStoreEnabled(configured: boolean | undefined): boolean {
    return configured === true;
}

export function isGptModel(model?: string): boolean {
    return /^(?:openai\/)?gpt-/i.test(model?.trim() ?? "");
}

/** 返回状态栏中的协议名称。 */
export function protocolStatusLabel(protocol: string | undefined, model?: string, websocket?: boolean): string {
    if (protocol !== "responses") return "Chat";
    return isResponsesWebSocketEnabled(websocket, model) ? "Responses in WS" : "Responses";
}
