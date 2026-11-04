/**
 * 用户提问通道：模型经 `ask_user` 工具向用户提问，用户作答或取消。
 *
 * 工具层不依赖 TUI：通道由宿主（TUI）在进程内装配，工具只问「有没有人在场」。
 * 没装配提问通道的进程里 `ask_user` 根本不下发，工具就永远遇不到
 * 「没人回答」，因此不需要超时——出口只有两个：用户作答、用户取消。
 */

export interface UserQuestionOption {
    /** 选项文本（回给模型的就是它）。 */
    label: string;
    /** 选项补充说明，仅用于展示。 */
    description?: string;
}

/** 「自己输入」入口的展示文本：UI 兜底追加，模型不需要（也不该）在选项里重复它。 */
export const CUSTOM_OPTION_LABEL = "其他（自己输入）";

/** 自填答案在回显文本里的前缀：面板、工具结果与事件流三处共用同一口径。 */
export const CUSTOM_ANSWER_PREFIX = "其他：";

/** 题干的单行标签：`短标签 · 完整问题`（短标签缺省或与问题重复时只用问题）。 */
export function questionLabel(question: { header: string; question: string }): string {
    return question.header && question.header !== question.question
        ? `${question.header} · ${question.question}`
        : question.question;
}

export interface UserQuestion {
    /** 简短标签（题干列表里显示）。 */
    header: string;
    /** 完整问题。 */
    question: string;
    options: UserQuestionOption[];
    /** 多选：允许同时勾选多个选项。 */
    multiSelect?: boolean;
}

/** 一道题的作答：selected 为选中的选项 label，custom 为「其他（自己输入）」的内容。 */
export interface UserQuestionAnswer {
    header: string;
    question: string;
    selected: string[];
    custom?: string;
}

/** 整次提问的结果：要么逐题作答，要么被用户取消（取消即不作答）。 */
export type UserAnswer =
    | { cancelled: true }
    | { cancelled: false; answers: UserQuestionAnswer[] };

export interface UserQuestionRequest {
    /** 本次提问的 id（面板与取消路径用它定位）。 */
    requestId: string;
    sessionId: string;
    questions: UserQuestion[];
}
