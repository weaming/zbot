/**
 * 判断 Responses 是否使用 WebSocket。
 *
 * WS 依赖上游对 steering / interrupt / 连接复用的支持，实测容易中断整轮请求，
 * 因此默认走 HTTP，只有 provider 显式配置 `websocket: true` 才启用。
 */
export function isResponsesWebSocketEnabled(configured: boolean | undefined): boolean {
    return configured === true;
}

/** 是否允许上游保存 Responses（未配置即关闭）。 */
export function isResponsesStoreEnabled(configured: boolean | undefined): boolean {
    return configured === true;
}

export function isGptModel(model?: string): boolean {
    return /^(?:openai\/)?gpt-/i.test(model?.trim() ?? "");
}

/** 返回状态栏中的协议名称。 */
export function protocolStatusLabel(protocol: string | undefined, websocket?: boolean): string {
    if (protocol !== "responses") return "Chat";
    return isResponsesWebSocketEnabled(websocket) ? "Responses in WS" : "Responses";
}
