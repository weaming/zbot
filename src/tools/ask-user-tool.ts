/**
 * `ask_user`：模型向用户提问并等作答（像 Claude 的交互式提问）。
 *
 * 会话级下发（sessionScoped）：只有装配了用户提问通道（TUI）且带会话上下文时才出现，
 * 因此模型不会在无人应答的环境里提问，工具也就不需要超时——出口只有作答与取消。
 * 「其他（自己输入）」由 UI 兜底追加，模型只提供选项。
 */

import {
    CUSTOM_ANSWER_PREFIX,
    type UserAnswer,
    type UserQuestion,
    type UserQuestionOption,
} from "../utils/user-question.js";
import { canAskUser, getUserQuestionChannel, hasSessionCapabilityProvider } from "../control/runtime.js";
import { createUlid } from "../utils/ulid.js";
import { err, ok, type ExecutableTool } from "./tool-interface.js";
import { toolCatalog } from "./tool-catalog.js";

/** 一次最多问几道题（再多该拆成多轮，免得用户面对一屏问题）。 */
const MAX_QUESTIONS = 5;
/** 每题选项数区间：1 个选项没有选择空间，超过 4 个面板一屏放不下。 */
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_HEADER_CHARS = 20;
const MAX_QUESTION_CHARS = 400;
const MAX_LABEL_CHARS = 60;
const MAX_DESCRIPTION_CHARS = 200;

/** 正在等作答的会话：同一会话不允许并发两处提问（面板一次只显示一组问题）。 */
const inflightSessions = new Set<string>();

interface AskUserArgs {
    questions?: unknown;
    __sessionId?: string;
}

const askUserTool: ExecutableTool = {
    name: "ask_user",
    description: [
        "向用户提问并等作答：用户从选项里挑，或选「其他（自己输入）」自己写。",
        `一次最多 ${MAX_QUESTIONS} 道题（每题 ${MIN_OPTIONS}-${MAX_OPTIONS} 个选项），每题可多选（multiSelect）。`,
        "只在真的需要用户拍板时用：能在当前上下文里自己判断的就别问（选项要具体、可执行，别写「其他」）。",
        "调用后会一直等到用户作答或取消（用户取消时按你判断的默认方案继续，并在回复里说明假设）。",
        "不要用普通文本向用户提问后结束回合——那样用户没法作答。",
    ].join(""),
    tags: ["core"],
    sessionScoped: true,
    inputSchema: {
        type: "object",
        properties: {
            questions: {
                type: "array",
                description: `要问的题目（1-${MAX_QUESTIONS} 道，按顺序展示）。`,
                items: {
                    type: "object",
                    properties: {
                        header: { type: "string", description: `简短标签，如「部署方式」（不超过 ${MAX_HEADER_CHARS} 字）` },
                        question: { type: "string", description: "完整问题（一句话说清要用户决定什么）" },
                        multiSelect: { type: "boolean", description: "是否多选（默认单选）" },
                        options: {
                            type: "array",
                            description: `选项（${MIN_OPTIONS}-${MAX_OPTIONS} 个；不要写「其他」，UI 自带自填入口）`,
                            items: {
                                type: "object",
                                properties: {
                                    label: { type: "string", description: "选项文本（回给你的就是它）" },
                                    description: { type: "string", description: "选项补充说明（可选，用于展示）" },
                                },
                                required: ["label"],
                            },
                        },
                    },
                    required: ["question", "options"],
                },
            },
        },
        required: ["questions"],
    },
    execute: async (args: AskUserArgs, signal?: AbortSignal) => {
        const sessionId = args.__sessionId;
        const channel = getUserQuestionChannel(sessionId);
        if (!channel || !sessionId) {
            if (sessionId && hasSessionCapabilityProvider("askUser")) {
                return err(`会话 ${sessionId.slice(-8)} 不在本实例的运行时上下文里，没有可交互的用户；请直接按默认方案继续。`);
            }
            return err("当前环境没有可交互的用户（提问通道未装配 / 缺少会话上下文），请直接按默认方案继续。");
        }

        const parsed = parseQuestions(args.questions);
        if (!parsed.ok) return err(`ask_user 参数不合法：${parsed.error}`);
        if (inflightSessions.has(sessionId)) {
            return err("本回合已有一个 ask_user 在等用户作答：等它返回，或把多道题合并成一次提问。");
        }

        inflightSessions.add(sessionId);
        try {
            const answer = await channel.ask(
                { requestId: createUlid(), sessionId, questions: parsed.questions },
                signal,
            );
            return ok(formatAnswer(parsed.questions, answer));
        } finally {
            inflightSessions.delete(sessionId);
        }
    },
};

/** 校验并归一化题目：结构性错误直接回报（让模型重试），超长字段截断。 */
function parseQuestions(raw: unknown): { ok: true; questions: UserQuestion[] } | { ok: false; error: string } {
    if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "questions 必须是非空数组" };
    if (raw.length > MAX_QUESTIONS) return { ok: false, error: `最多 ${MAX_QUESTIONS} 道题，本次给了 ${raw.length} 道` };

    const questions: UserQuestion[] = [];
    for (const [index, item] of raw.entries()) {
        const position = `第 ${index + 1} 题`;
        if (!item || typeof item !== "object") return { ok: false, error: `${position}不是对象` };

        const draft = item as { header?: unknown; question?: unknown; options?: unknown; multiSelect?: unknown };
        const question = typeof draft.question === "string" ? draft.question.trim() : "";
        if (!question) return { ok: false, error: `${position}缺少 question` };

        const rawOptions = draft.options;
        if (!Array.isArray(rawOptions) || rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
            return {
                ok: false,
                error: `${position}的 options 需要 ${MIN_OPTIONS}-${MAX_OPTIONS} 个（本次 ${Array.isArray(rawOptions) ? rawOptions.length : 0} 个）`,
            };
        }

        const options: UserQuestionOption[] = [];
        for (const [optionIndex, rawOption] of rawOptions.entries()) {
            const option = rawOption as { label?: unknown; description?: unknown } | null;
            const label = option && typeof option.label === "string" ? option.label.trim() : "";
            if (!label) return { ok: false, error: `${position}的第 ${optionIndex + 1} 个选项缺少 label` };
            const description = typeof option?.description === "string" ? option.description.trim() : "";
            options.push({
                label: truncate(label, MAX_LABEL_CHARS),
                ...(description ? { description: truncate(description, MAX_DESCRIPTION_CHARS) } : {}),
            });
        }

        const header = typeof draft.header === "string" ? draft.header.trim() : "";
        questions.push({
            // 缺省留空：面板直接用 question 展示，避免「短标签」被截断成与题干重复的内容
            header: truncate(header, MAX_HEADER_CHARS),
            question: truncate(question, MAX_QUESTION_CHARS),
            options,
            ...(draft.multiSelect === true ? { multiSelect: true } : {}),
        });
    }

    return { ok: true, questions };
}

/** 工具结果文本：逐题回显「问题 → 选择」，取消时给模型明确的继续口径。 */
function formatAnswer(questions: UserQuestion[], answer: UserAnswer): string {
    if (answer.cancelled) {
        return "用户取消了这次提问，没有作答。请按你认为最合理的默认方案继续，并在回复里说明你假设了什么。";
    }

    const lines = ["用户已回答："];
    for (const [index, question] of questions.entries()) {
        const picked = answer.answers[index];
        const choices = [
            ...(picked?.selected ?? []),
            ...(picked?.custom ? [`${CUSTOM_ANSWER_PREFIX}${picked.custom}`] : []),
        ];
        lines.push(`${index + 1}. ${question.question}${question.multiSelect ? "（多选）" : ""} → ${choices.length > 0 ? choices.join("、") : "（未作答）"}`);
    }
    return lines.join("\n");
}

function truncate(text: string, maxChars: number): string {
    return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

toolCatalog.registerLocalTools([askUserTool]);

/**
 * 会话当前可用的提问工具名：有会话上下文且进程装配了提问通道才注入。
 * 没人在场的进程里不下发，模型也就不会提无效的问题。
 */
export function getAskUserToolNames(sessionId?: string): string[] {
    if (!sessionId || !canAskUser(sessionId)) return [];
    return [askUserTool.name];
}
