/**
 * `/model` 的统一语义：协议、模型、思考强度只有这一处解析。
 *
 * TUI（面板与命令行）与会话间执行共用：面板只是同一份数据的可视化入口，
 * 设置结果必须与 `/model <协议> <模型>` / `/model effort` 完全一致，避免两个入口各自解释。
 */

import { getChatApiSettings, getChatModelOptions } from "../services/chat-runtime.js";
import { getReasoningEffortChoices, getReasoningProvider } from "../utils/reasoning-effort.js";
import type { ChatApiProtocol, ChatModelSelection } from "../types/chat-model.js";
import type { ChatModelOption } from "../services/chat-runtime.js";

export interface ModelView {
    current: { protocol: string; model: string; reasoningEffort: string };
    options: ChatModelOption[];
    efforts: string[];
}

/**
 * 当前生效的思考强度：会话选择 → 配置 → 环境变量（`REASONING_EFFORT` /
 * `OPENAI_REASONING_EFFORT` / `DEEPSEEK_REASONING_EFFORT`）→ auto。
 * 面板默认高亮、切模型保留档位都用它，否则切模型会把 env 里的设置静默变成 auto。
 */
export function effectiveReasoningEffort(selection: ChatModelSelection | undefined): string {
    return selection?.reasoningEffort
        ?? getChatApiSettings(selection).reasoningEffort
        ?? process.env.REASONING_EFFORT
        ?? process.env.OPENAI_REASONING_EFFORT
        ?? process.env.DEEPSEEK_REASONING_EFFORT
        ?? "auto";
}

/** 会话当前的模型视图：待落盘选择优先（本回合设置、下一回合生效）。 */
export function describeModelView(selection: ChatModelSelection | undefined): ModelView {
    const settings = getChatApiSettings(selection);
    const protocol: ChatApiProtocol = selection?.protocol ?? settings.protocol ?? "chat_completions";
    const model = selection?.model ?? settings.model;
    return {
        current: {
            protocol,
            model,
            reasoningEffort: effectiveReasoningEffort(selection),
        },
        options: getChatModelOptions(),
        efforts: effortChoices(protocol, model, settings.apiBase, settings.reasoningEfforts),
    };
}

/**
 * 某协议/模型可用的思考强度（含 auto）：baseUrl 与 `*_EFFORTS` 取自**该协议自己的配置**，
 * 不能拿当前模型的 endpoint 去判断目标模型（跨协议切换时厂家判定会错）。
 */
export function effortChoicesFor(protocol: ChatApiProtocol, model: string): string[] {
    const settings = getChatApiSettings({ protocol, model });
    return effortChoices(protocol, model, settings.apiBase, settings.reasoningEfforts);
}

/** 某协议/模型可用的思考强度（含 auto）。 */
function effortChoices(
    protocol: ChatApiProtocol,
    model: string,
    apiBase: string,
    configured?: string[],
): string[] {
    return [
        ...getReasoningEffortChoices(protocol, getReasoningProvider(protocol, model, apiBase), configured),
        "auto",
    ];
}

/** 组合必须出现在可切换列表里（与面板同口径）。 */
function resolveModelOption(
    protocol: string,
    model: string,
    options: ChatModelOption[],
): ChatModelOption | undefined {
    return options.find(option => option.protocol === protocol && option.model === model);
}

/** 校验并归一化思考强度；未知取值给出可选值清单。 */
export function resolveEffort(
    requested: string,
    choices: string[],
): { ok: true; effort: string } | { ok: false; error: string } {
    const input = requested.trim().toLowerCase();
    if (choices.some(value => value.toLowerCase() === input)) return { ok: true, effort: input };
    return { ok: false, error: `未知思考强度：${requested}，可选值：${choices.join(" | ")}` };
}

/**
 * 切换模型时保留原思考强度：新模型支持同一档位才保留，否则退回 auto
 * （面板与命令行共用这一条规则）。
 */
export function preserveEffort(
    previous: string | undefined,
    protocol: ChatApiProtocol,
    model: string,
): string {
    if (!previous || previous === "auto") return "auto";
    const choices = effortChoicesFor(protocol, model);
    return choices.some(value => value.toLowerCase() === previous.toLowerCase()) ? previous : "auto";
}

/**
 * `/model` 设置路径的唯一解析：校验目标组合、按**目标模型**的档位校验并归一化强度，
 * 省略强度时按共享规则保留原档位。TUI 与 session send 必须都走这里，
 * 否则"当前模型的档位"与"目标模型的档位"会各校验一套。
 */
export function resolveModelUse(
    options: ChatModelOption[],
    protocol: string,
    model: string,
    requestedEffort: string | undefined,
    previousEffort: string | undefined,
): { ok: true; selection: ChatModelSelection } | { ok: false; error: string } {
    const option = resolveModelOption(protocol, model, options);
    if (!option) {
        const available = options.map(item => `${item.protocol}/${item.model}`).join(" | ") || "（无配置）";
        return { ok: false, error: `不可用的模型组合：${protocol} / ${model}。可选：${available}` };
    }

    if (requestedEffort === undefined) {
        return {
            ok: true,
            selection: {
                protocol: option.protocol,
                model: option.model,
                reasoningEffort: preserveEffort(previousEffort, option.protocol, option.model),
            },
        };
    }

    const resolved = resolveEffort(requestedEffort, effortChoicesFor(option.protocol, option.model));
    if (!resolved.ok) return resolved;
    return {
        ok: true,
        selection: { protocol: option.protocol, model: option.model, reasoningEffort: resolved.effort },
    };
}
