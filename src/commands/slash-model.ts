/**
 * `/model` 的统一语义：provider、模型、思考强度只有这一处解析。
 *
 * TUI（面板与命令行）与会话间执行共用：面板只是同一份数据的可视化入口，
 * 设置结果必须与 `/model <provider> <模型>` / `/model effort` 完全一致，避免两个入口各自解释。
 * 模型允许手输 provider 未列出的名字（临时模型，仅当前会话生效）。
 */

import {
    getChatApiSettings,
    getChatModelOptions,
    type ChatModelOption,
} from "../services/chat-runtime.js";
import { getConfig, getProvider, getProviders, getRuntimeReasoningEffort } from "../config/index.js";
import { getReasoningEffortChoices, getReasoningProvider } from "../utils/reasoning-effort.js";
import type { ChatApiProtocol, ChatModelSelection } from "../types/chat-model.js";

export interface ModelView {
    current: { provider: string; protocol: string; model: string; reasoningEffort: string };
    options: ChatModelOption[];
    efforts: string[];
    /** 当前模型不在 provider.models 里：临时手输，仅本会话生效。 */
    isTemporary: boolean;
}

/** 面板与命令行共用的 provider 清单。 */
export interface ProviderChoice {
    name: string;
    protocol: ChatApiProtocol;
    models: string[];
}

export function describeProviderChoices(): ProviderChoice[] {
    return getProviders().map(provider => ({
        name: provider.name,
        protocol: provider.protocol,
        models: [...provider.models],
    }));
}

/**
 * 当前生效的思考强度：会话选择 → 进程内覆盖（`/model effort`）→ 配置 defaults → auto。
 * 面板默认高亮、切模型保留档位都用它，否则切模型会把配置里的设置静默变成 auto。
 */
export function effectiveReasoningEffort(selection: ChatModelSelection | undefined): string {
    return selection?.reasoningEffort
        ?? getRuntimeReasoningEffort()
        ?? getConfig().defaults.reasoningEffort
        ?? "auto";
}

/** 会话当前的模型视图：待落盘选择优先（本回合设置、下一回合生效）。 */
export function describeModelView(selection: ChatModelSelection | undefined): ModelView {
    const settings = getChatApiSettings(selection);
    const protocol: ChatApiProtocol = settings.protocol ?? "chat_completions";
    return {
        current: {
            provider: settings.provider,
            protocol,
            model: settings.model,
            reasoningEffort: effectiveReasoningEffort(selection),
        },
        options: getChatModelOptions(),
        efforts: effortChoices(protocol, settings.model, settings.apiBase, settings.reasoningEfforts),
        isTemporary: !(getProvider(settings.provider)?.models.includes(settings.model) ?? false),
    };
}

/**
 * 某 provider/模型可用的思考强度（含 auto）：baseUrl 与 efforts 取自**该 provider 的配置**，
 * 不能拿当前模型的 endpoint 去判断目标模型（跨 provider 切换时厂家判定会错）。
 */
export function effortChoicesFor(provider: string, model: string): string[] {
    const settings = getChatApiSettings({ provider, protocol: providerProtocol(provider), model });
    return effortChoices(settings.protocol ?? "chat_completions", model, settings.apiBase, settings.reasoningEfforts);
}

/** provider 的协议（未知 provider 时按 chat_completions 兜底）。 */
function providerProtocol(provider: string): ChatApiProtocol {
    return getProvider(provider)?.protocol ?? "chat_completions";
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
    provider: string,
    model: string,
): string {
    if (!previous || previous === "auto") return "auto";
    const choices = effortChoicesFor(provider, model);
    return choices.some(value => value.toLowerCase() === previous.toLowerCase()) ? previous : "auto";
}

/**
 * `/model` 设置路径的唯一解析：校验 provider、按**目标模型**的档位校验并归一化强度，
 * 省略强度时按共享规则保留原档位。TUI 与 session send 必须都走这里，
 * 否则"当前模型的档位"与"目标模型的档位"会各校验一套。
 */
export function resolveModelUse(
    options: ChatModelOption[],
    provider: string | undefined,
    model: string | undefined,
    requestedEffort: string | undefined,
    previousEffort: string | undefined,
): { ok: true; selection: ChatModelSelection } | { ok: false; error: string } {
    const providerName = provider?.trim();
    if (!providerName) {
        const available = getProviders().map(item => item.name).join(" | ") || "（无配置）";
        return { ok: false, error: `缺少 provider：用法 /model <provider> <模型> [强度|auto]。可选：${available}` };
    }

    const target = getProvider(providerName);
    if (!target) {
        const available = getProviders().map(item => item.name).join(" | ") || "（无配置）";
        return { ok: false, error: `没有这个 provider：${providerName}。可选：${available}` };
    }

    const modelName = model?.trim();
    if (!modelName) {
        const listed = options.filter(option => option.provider === target.name).map(option => option.model);
        return {
            ok: false,
            error: `缺少模型：${target.name} 下可切换的有 ${listed.join(" | ") || "（无）"}，也可以手输任意模型名（临时生效）`,
        };
    }

    if (requestedEffort === undefined) {
        return {
            ok: true,
            selection: {
                provider: target.name,
                protocol: target.protocol,
                model: modelName,
                reasoningEffort: preserveEffort(previousEffort, target.name, modelName),
            },
        };
    }

    const resolved = resolveEffort(requestedEffort, effortChoicesFor(target.name, modelName));
    if (!resolved.ok) return resolved;
    return {
        ok: true,
        selection: {
            provider: target.name,
            protocol: target.protocol,
            model: modelName,
            reasoningEffort: resolved.effort,
        },
    };
}
