/**
 * 明文思维链缺失时补进上行请求的占位文本。
 *
 * DeepSeek 思维模式要求每个助手轮都带回明文 `reasoning_text`，历史里总会有拿不到明文的
 * 轮次（中断后从流式增量恢复、换过 provider 的老消息），补一条占位比整轮失败划算。
 * 它只是协议需要：**不是模型说的话**，界面与历史都不该把它当成一段思考渲染。
 */
export const REASONING_PLACEHOLDER = "(thinking unavailable)";

/** 这段文本是不是那条占位（上游也可能把它原样回显回来）。 */
export function isReasoningPlaceholder(text: string): boolean {
    return text.trim() === REASONING_PLACEHOLDER;
}
