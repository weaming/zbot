/**
 * `ask_user` 工具：参数校验、下发条件（是否有人在回答）、作答与取消两种出口。
 */

import { afterEach, describe, expect, test } from "bun:test";
import { executeMcpTool } from "../../src/tools/tool-registry.js";
import { getAskUserToolNames } from "../../src/tools/ask-user-tool.js";
import { type UserAnswer, type UserQuestionRequest } from "../../src/utils/user-question.js";
import { registerSessionRuntime } from "../../src/control/runtime.js";

const SESSION = "01JASKU0000000000000000TEST";

/** 本文件注册的"终端前端"能力：按会话解析，不再依赖进程级单槽。 */
let unregisterRuntime: (() => void) | undefined;

afterEach(() => {
    unregisterRuntime?.();
    unregisterRuntime = undefined;
});

/** 注册/替换提问通道；`channel` 为 undefined 表示本进程没人可回答。 */
function installAskUserChannel(channel?: { ask(request: UserQuestionRequest, signal?: AbortSignal): Promise<UserAnswer> }): void {
    unregisterRuntime?.();
    unregisterRuntime = undefined;
    if (!channel) return;
    unregisterRuntime = registerSessionRuntime({
        ownsSession: sessionId => sessionId === SESSION,
        askUser: (request, signal) => channel.ask(request, signal),
    });
}

function question(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        header: "部署方式",
        question: "这次部署走哪条路？",
        options: [{ label: "方案 A" }, { label: "方案 B", description: "线上灰度" }],
        ...overrides,
    };
}

/** 桩通道：按题目顺序回第一个选项，第一题附带自填内容。 */
function stubChannel(custom = ""): void {
    installAskUserChannel({
        ask: async (request: UserQuestionRequest): Promise<UserAnswer> => ({
            cancelled: false,
            answers: request.questions.map((item, index) => ({
                header: item.header,
                question: item.question,
                selected: [item.options[0]!.label],
                ...(index === 0 && custom ? { custom } : {}),
            })),
        }),
    });
}

async function run(args: Record<string, unknown>, withSession = true) {
    const result = await executeMcpTool("ask_user", withSession ? { ...args, __sessionId: SESSION } : args);
    return { ...result, text: result.content.map(block => block.text ?? "").join("\n") };
}

describe("ask_user 下发条件", () => {
    test("没有提问通道时不下发，直接调用也会被拒绝", async () => {
        // 别的测试文件可能还注册着前端：这里显式清掉
        installAskUserChannel(undefined);
        expect(getAskUserToolNames(SESSION)).toEqual([]);

        const result = await run({ questions: [question()] });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("没有可交互的用户");
    });

    test("未知会话 id：按会话严格解析，不下发也不误投", async () => {
        installAskUserChannel({ ask: async () => ({ cancelled: true }) });

        // 通道只负责 SESSION：别的会话 id 解析不到，既不下发也不投递
        expect(getAskUserToolNames("01JASKU0000000000000000UNKW")).toEqual([]);
        const asked: string[] = [];
        installAskUserChannel({ ask: async () => { asked.push("hit"); return { cancelled: true }; } });
        const result = await executeMcpTool("ask_user", {
            questions: [question()],
            __sessionId: "01JASKU0000000000000000UNKW",
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("不在本实例的运行时上下文里");
        expect(asked).toEqual([]);
    });

    test("装配通道且有会话上下文才下发", () => {
        stubChannel();
        expect(getAskUserToolNames(SESSION)).toEqual(["ask_user"]);
        // 没有会话上下文（无 __sessionId）时不下发
        expect(getAskUserToolNames()).toEqual([]);
    });
});

describe("ask_user 参数校验", () => {
    test("题目数量与选项数量越界被拒（并告知上限）", async () => {
        stubChannel();

        const empty = await run({ questions: [] });
        expect(empty.isError).toBe(true);
        expect(empty.text).toContain("非空数组");

        const tooMany = await run({ questions: Array.from({ length: 6 }, () => question()) });
        expect(tooMany.isError).toBe(true);
        expect(tooMany.text).toContain("最多 5 道题");

        const tooFewOptions = await run({ questions: [question({ options: [{ label: "唯一" }] })] });
        expect(tooFewOptions.isError).toBe(true);
        expect(tooFewOptions.text).toContain("options 需要 2-4 个");

        const tooManyOptions = await run({
            questions: [question({ options: [1, 2, 3, 4, 5].map(index => ({ label: `选项 ${index}` })) })],
        });
        expect(tooManyOptions.isError).toBe(true);
        expect(tooManyOptions.text).toContain("5 个");
    });

    test("缺 question / 缺选项 label 被拒", async () => {
        stubChannel();

        const noQuestion = await run({ questions: [{ options: [{ label: "A" }, { label: "B" }] }] });
        expect(noQuestion.isError).toBe(true);
        expect(noQuestion.text).toContain("缺少 question");

        const noLabel = await run({ questions: [question({ options: [{ label: "A" }, {}] })] });
        expect(noLabel.isError).toBe(true);
        expect(noLabel.text).toContain("缺少 label");
    });
});

describe("ask_user 作答", () => {
    test("把问题交给通道，并把作答逐题回给模型", async () => {
        const requests: UserQuestionRequest[] = [];
        installAskUserChannel({
            ask: async (request) => {
                requests.push(request);
                return {
                    cancelled: false,
                    answers: [
                        { header: "部署方式", question: "这次部署走哪条路？", selected: ["方案 A"] },
                        { header: "通知", question: "要不要通知团队？", selected: ["邮件", "Slack"], custom: "顺便发群里" },
                    ],
                };
            },
        });

        const result = await run({
            questions: [
                question(),
                question({
                    header: "通知",
                    question: "要不要通知团队？",
                    multiSelect: true,
                    options: [{ label: "邮件" }, { label: "Slack" }],
                }),
            ],
        });

        expect(result.isError).toBeUndefined();
        expect(requests).toHaveLength(1);
        expect(requests[0]!.sessionId).toBe(SESSION);
        expect(requests[0]!.requestId).toBeTruthy();
        expect(requests[0]!.questions[1]!.multiSelect).toBe(true);
        expect(result.text).toContain("用户已回答：");
        expect(result.text).toContain("1. 这次部署走哪条路？ → 方案 A");
        expect(result.text).toContain("2. 要不要通知团队？（多选） → 邮件、Slack、其他：顺便发群里");
    });

    test("缺省 header 留空（面板回退用题干），超长字段截断", async () => {
        const requests: UserQuestionRequest[] = [];
        installAskUserChannel({
            ask: async (request) => {
                requests.push(request);
                return { cancelled: true };
            },
        });

        await run({ questions: [question({ header: undefined, question: "x".repeat(500) })] });
        expect(requests[0]!.questions[0]!.header).toBe("");
        expect(requests[0]!.questions[0]!.question.length).toBeLessThan(500);
    });

    test("用户取消：回正常结果（非错误），并给出继续口径", async () => {
        installAskUserChannel({ ask: async () => ({ cancelled: true }) });

        const result = await run({ questions: [question()] });
        expect(result.isError).toBeUndefined();
        expect(result.text).toContain("取消了这次提问");
        expect(result.text).toContain("默认方案");
    });

    test("同一会话并发提问被拒（面板一次只显示一组问题）", async () => {
        const releases: (() => void)[] = [];
        installAskUserChannel({
            ask: () => new Promise<UserAnswer>(resolve => {
                releases.push(() => resolve({ cancelled: true }));
            }),
        });

        const first = run({ questions: [question()] });
        const second = await run({ questions: [question()] });
        expect(second.isError).toBe(true);
        expect(second.text).toContain("已有一个 ask_user");

        releases.shift()?.();
        await first;

        // 结算后可以再次提问
        const third = run({ questions: [question()] });
        releases.shift()?.();
        expect((await third).isError).toBeUndefined();
    });
});
