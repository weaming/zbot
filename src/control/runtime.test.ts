import { afterEach, describe, expect, test } from "bun:test";
import type { McpNotice } from "../types/mcp.js";
import {
    canAskUser,
    getPeerResultHistory,
    hasSessionCapabilityProvider,
    getSessionControl,
    getSessionCwdSetter,
    getSessionDirectory,
    getUserQuestionChannel,
    notifyMcpNotice,
    onSessionRuntimeRegistered,
    registerSessionRuntime,
    sessionRuntimeCount,
    type SessionRuntimeCapabilities,
} from "./runtime.js";

/**
 * 运行时注册表的语义单测：按会话解析、无人认领时的回退、注销按身份、关闭顺序、
 * 会话无关通知的广播。真实宿主的端到端行为在 tests/unit/cwd-tool-host.test.ts。
 */

const unregisterAll: Array<() => void> = [];

function register(caps: SessionRuntimeCapabilities): () => void {
    const unregister = registerSessionRuntime(caps);
    unregisterAll.push(unregister);
    return unregister;
}

afterEach(() => {
    while (unregisterAll.length > 0) unregisterAll.pop()!();
});

/** 只有身份的假控制通道：身份比较用。 */
const controlOf = (name: string) => ({ name } as never);

describe("按会话解析", () => {
    test("多实例各认领自己的会话：解析落到负责它的那一个", () => {
        const controlA = controlOf("A");
        const controlB = controlOf("B");
        register({ ownsSession: id => id === "s-a", control: controlA });
        register({ ownsSession: id => id === "s-b", control: controlB });

        expect(getSessionControl("s-a")).toBe(controlA);
        expect(getSessionControl("s-b")).toBe(controlB);
    });

    test("后注册的实例不覆盖先注册的（不再「最后装配者赢」）", () => {
        const controlA = controlOf("A");
        const controlB = controlOf("B");
        register({ ownsSession: id => id === "s-a", control: controlA });
        register({ ownsSession: id => id === "s-b", control: controlB });

        // A 是较早注册的，但 s-a 仍然解析到 A
        expect(getSessionControl("s-a")).toBe(controlA);
    });

    test("带 sessionId 时严格：无人认领就返回 undefined，不拿唯一实例兜底", () => {
        register({ ownsSession: () => false, control: controlOf("only") });
        expect(getSessionControl("s-unknown")).toBeUndefined();

        register({ ownsSession: () => false, control: controlOf("A") });
        register({ ownsSession: () => false, control: controlOf("B") });
        expect(getSessionControl("s-unknown")).toBeUndefined();
    });

    test("不带 sessionId：唯一注册项可用，多注册项返回 undefined", () => {
        const first = register({ ownsSession: () => true, directory: { list: async () => [] } });
        expect(getSessionDirectory()).toBeDefined();
        first();

        register({ ownsSession: () => true, directory: { list: async () => [] } });
        register({ ownsSession: () => true, directory: { list: async () => [] } });
        expect(getSessionDirectory()).toBeUndefined();
    });

    test("能力各自解析：只有提供该能力的注册项参与候选", () => {
        const controlA = controlOf("A");
        const controlB = controlOf("B");
        const directoryB = { list: async () => [] };
        register({ ownsSession: id => id === "s-a", control: controlA });
        register({ ownsSession: id => id === "s-b", control: controlB, directory: directoryB });

        // 控制通道按会话落到各自的注册项
        expect(getSessionControl("s-a")).toBe(controlA);
        expect(getSessionControl("s-b")).toBe(controlB);
        // B 提供的目录只服务于 B 负责的会话；A 的会话没人提供目录 → 严格返回 undefined
        expect(getSessionDirectory("s-b")).toBe(directoryB);
        expect(getSessionDirectory("s-a")).toBeUndefined();
        // 无人负责的会话 → 不猜
        expect(getSessionControl("s-c")).toBeUndefined();
    });
});

describe("按会话注入的写入入口", () => {
    test("cwd 落盘入口绑定到负责该会话的宿主", async () => {
        const calls: Array<[string, string]> = [];
        register({
            ownsSession: id => id === "s-a",
            setSessionCwd: async (sessionId, cwd) => { calls.push([`A:${sessionId}`, cwd]); },
        });
        register({
            ownsSession: id => id === "s-b",
            setSessionCwd: async (sessionId, cwd) => { calls.push([`B:${sessionId}`, cwd]); },
        });

        const setter = getSessionCwdSetter("s-b");
        expect(setter).toBeDefined();
        await setter!("/tmp/x");

        expect(calls).toEqual([["B:s-b", "/tmp/x"]]);
        // 没有会话上下文时不给入口：cwd 工具据此回退到进程级目录
        expect(getSessionCwdSetter(undefined)).toBeUndefined();
    });

    test("进程里有人提供能力但该会话不归他：严格返回 undefined（用于区分错误文案）", () => {
        register({ ownsSession: () => false, setSessionCwd: async () => {} });
        expect(getSessionCwdSetter("s-unknown")).toBeUndefined();
        expect(hasSessionCapabilityProvider("setSessionCwd")).toBe(true);
        expect(hasSessionCapabilityProvider("askUser")).toBe(false);
    });

    test("结果历史按会话解析到对应宿主", async () => {
        register({
            ownsSession: id => id === "s-a",
            recentPeerResults: async sessionId => [{
                peerId: "peer-a",
                ok: true,
                text: `A:${sessionId}`,
                createdAt: "2026-01-01T00:00:00.000Z",
            }],
        });
        register({
            ownsSession: id => id === "s-b",
            recentPeerResults: async sessionId => [{
                peerId: "peer-b",
                ok: true,
                text: `B:${sessionId}`,
                createdAt: "2026-01-01T00:00:00.000Z",
            }],
        });

        const history = getPeerResultHistory("s-b");
        expect((await history!.recentResults("s-b", 1))[0]?.text).toBe("B:s-b");
    });

    test("提问通道按会话解析；解析不到该会话时不下发 ask_user", () => {
        register({
            ownsSession: id => id === "s-a",
            askUser: async () => ({ cancelled: true }),
        });

        expect(getUserQuestionChannel("s-a")).toBeDefined();
        expect(canAskUser("s-a")).toBe(true);

        // 只有唯一前端但它不负责 s-x：严格语义下同样解析不到，也就不会误投
        expect(getUserQuestionChannel("s-x")).toBeUndefined();
        expect(canAskUser("s-x")).toBe(false);

        register({ ownsSession: id => id === "s-y", askUser: async () => ({ cancelled: true }) });
        expect(canAskUser("s-y")).toBe(true);
        expect(getUserQuestionChannel("s-y")).toBeDefined();
    });
});

describe("生命周期与关闭顺序", () => {
    test("注销按身份生效：关掉一个不影响另一个，重复注销无副作用", () => {
        const controlA = controlOf("A");
        const controlB = controlOf("B");
        const unregisterA = register({ ownsSession: id => id === "s-a", control: controlA });
        register({ ownsSession: id => id === "s-b", control: controlB });

        unregisterA();
        unregisterA();

        // A 已下线：它的会话解析为 undefined（不会兜底给 B）
        expect(getSessionControl("s-a")).toBeUndefined();
        expect(getSessionControl("s-b")).toBe(controlB);
        expect(sessionRuntimeCount()).toBe(1);
    });

    test("关闭顺序不影响仍未退出的实例", () => {
        const controlA = controlOf("A");
        const controlB = controlOf("B");
        const unregisterA = register({ ownsSession: id => id === "s-a", control: controlA });
        const unregisterB = register({ ownsSession: id => id === "s-b", control: controlB });

        // 先关后注册的（旧实现下会把先注册的那份槽位一起摘掉）
        unregisterB();
        expect(getSessionControl("s-a")).toBe(controlA);
        expect(getSessionControl("s-b")).toBeUndefined();

        unregisterA();
        expect(sessionRuntimeCount()).toBe(0);
    });
});

describe("会话无关通知与注册监听", () => {
    test("MCP 通知广播给所有提供者，返回送达数量", () => {
        const first: McpNotice[] = [];
        const second: McpNotice[] = [];
        register({ ownsSession: () => true, notifyMcpNotice: notice => first.push(notice) });
        register({ ownsSession: () => true, notifyMcpNotice: notice => second.push(notice) });

        const notice: McpNotice = { server: "hub", level: "warn", text: "需要授权", url: "https://x" };
        expect(notifyMcpNotice(notice)).toBe(2);
        expect(first).toEqual([notice]);
        expect(second).toEqual([notice]);
    });

    test("没有界面时送达数量为 0（调用方据此决定是否积压）", () => {
        expect(notifyMcpNotice({ server: "hub", level: "info", text: "x" })).toBe(0);
    });

    test("单个提供者抛错不影响其它订阅者", () => {
        const delivered: McpNotice[] = [];
        register({
            ownsSession: () => true,
            notifyMcpNotice: () => { throw new Error("界面已销毁"); },
        });
        register({ ownsSession: () => true, notifyMcpNotice: notice => delivered.push(notice) });

        expect(notifyMcpNotice({ server: "hub", level: "info", text: "x" })).toBe(1);
        expect(delivered).toHaveLength(1);
    });

    test("注册监听：新注册项到达时通知，取消订阅后不再通知", () => {
        const seen: SessionRuntimeCapabilities[] = [];
        const unsubscribe = onSessionRuntimeRegistered(caps => seen.push(caps));
        const caps = { ownsSession: () => true };
        register(caps);
        expect(seen).toEqual([caps]);

        unsubscribe();
        register({ ownsSession: () => true });
        expect(seen).toEqual([caps]);
    });
});
