/**
 * 会话运行时注册表：把「按 sessionId 解析到具体宿主/前端」收成唯一一处。
 *
 * 背景：这些能力（控制通道、会话目录、cwd 落盘、提问通道、MCP 通知）此前是进程级可变单槽，
 * 由最后装配的 `LocalSessionHost` / `ChatApp` 覆盖；同进程多实例（多宿主、多 UI、测试）时，
 * 一个实例关闭还会留下指向已退出实例的旧引用。
 *
 * 现在改为注册表：
 * - 实例注册自己的能力集合与 `ownsSession`，注销函数按身份生效（不会摘掉别人的）；
 * - 引擎只按「当前会话」解析，优先负责该会话的注册项；无人认领时只在唯一注册项时回退；
 * - 会话无关的通知（MCP 授权链接）广播给所有提供者；
 * - 关闭即注销，注册表不持有退出实例的能力。
 *
 * 只放窄能力：不搬运宿主对象、不把 SessionHost 暴露给工具层。
 */

import type { SessionControl } from "./channel.js";
import type { McpNotice } from "../types/mcp.js";
import type { UserAnswer, UserQuestionRequest } from "../utils/user-question.js";

/** 会话目录条目：只暴露工具与 UI 需要的字段。 */
interface SessionDirectoryEntry {
    sessionId: string;
    title?: string;
    archived?: boolean;
}

/** 会话目录：由宿主注入，避免控制层反向依赖 TUI 的会话管理。 */
export interface SessionDirectory {
    list(options?: { includeArchived?: boolean }): Promise<SessionDirectoryEntry[]>;
    /** 重新认领并取消归档一个已关闭会话。 */
    wake?(sessionId: string): Promise<void>;
}

/** 一条会话间结果记录：对方回合的产出回传（读自事件日志，供工具回查）。 */
export interface PeerResultRecord {
    /** 产出这条结果的对端会话。 */
    peerId: string;
    peerTitle?: string;
    ok: boolean;
    lost?: boolean;
    late?: boolean;
    text: string;
    stopReason?: string;
    createdAt: string;
}

/** 会话间结果历史：由宿主注入（读事件日志实现），避免工具层直接依赖 TUI 的会话存储。 */
export interface PeerResultHistory {
    /** 按时间正序返回该会话最近收到的结果（最多 limit 条）。 */
    recentResults(sessionId: string, limit: number): Promise<PeerResultRecord[]>;
}

/** 交互提问通道：由前端注入，`ask` 结算即返回答案或取消。 */
export interface UserQuestionChannel {
    ask(request: UserQuestionRequest, signal?: AbortSignal): Promise<UserAnswer>;
}

/**
 * 一份注册项：一个宿主/前端能提供的全部会话运行时能力。
 * 全部可选——宿主提供通道与目录，TUI 提供提问与通知，各取所需。
 */
export interface SessionRuntimeCapabilities {
    /** 本注册项负责哪些会话：宿主看认领/活跃，前端看已载入的会话视图。 */
    ownsSession(sessionId: string): boolean;
    /** 控制通道（会话间投递）。 */
    control?: SessionControl;
    /** 会话目录（列出/唤醒）。 */
    directory?: SessionDirectory;
    /** 最近会话间结果回查。 */
    recentPeerResults?(sessionId: string, limit: number): Promise<PeerResultRecord[]>;
    /** 会话 cwd 落盘（cwd 工具 / 命令共用）。 */
    setSessionCwd?(sessionId: string, cwd: string): Promise<void>;
    /** 交互提问（只有终端前端有）。 */
    askUser?(request: UserQuestionRequest, signal?: AbortSignal): Promise<UserAnswer>;
    /** 会话无关的 MCP 授权/状态通知（广播给所有提供者）。 */
    notifyMcpNotice?(notice: McpNotice): void;
}

const registrations: SessionRuntimeCapabilities[] = [];
const registrationListeners = new Set<(caps: SessionRuntimeCapabilities) => void>();

/** 注册一套能力；返回按身份生效的注销函数（重复调用无副作用）。 */
export function registerSessionRuntime(caps: SessionRuntimeCapabilities): () => void {
    registrations.push(caps);
    for (const listener of registrationListeners) {
        try {
            listener(caps);
        } catch (error) {
            console.error("⚠️ [runtime] 注册监听器异常:", error);
        }
    }
    return () => {
        const index = registrations.indexOf(caps);
        if (index >= 0) registrations.splice(index, 1);
    };
}

/** 新注册项到位时通知（MCP 通知这类需要补发积压的场景用）。 */
export function onSessionRuntimeRegistered(
    listener: (caps: SessionRuntimeCapabilities) => void,
): () => void {
    registrationListeners.add(listener);
    return () => {
        registrationListeners.delete(listener);
    };
}

/** 当前注册项数量（诊断/测试用）。 */
export function sessionRuntimeCount(): number {
    return registrations.length;
}

/**
 * 按能力 + 会话解析：
 * 1. 带 sessionId 时**严格**：必须由某个注册项 `ownsSession` 认领，否则返回 undefined。
 *    不拿"唯一实例"兜底——否则未知/他人的会话会被就地误路由到本进程里剩下的宿主；
 * 2. 不带 sessionId（显式进程级/会话无关查询）时，只在唯一候选时返回。
 */
function pick<K extends keyof SessionRuntimeCapabilities>(
    capability: K,
    sessionId?: string,
): SessionRuntimeCapabilities[K] | undefined {
    const candidates = registrations.filter(caps => caps[capability] !== undefined);
    if (candidates.length === 0) return undefined;

    if (sessionId !== undefined) {
        const owned = candidates.filter(caps => caps.ownsSession(sessionId));
        // 多个注册项都认领同一会话时取最近注册的：同一会话的持有权本就互斥
        return owned.length > 0 ? owned[owned.length - 1]![capability] : undefined;
    }
    return candidates.length === 1 ? candidates[0]![capability] : undefined;
}

/** 进程里是否有人提供该能力（只用于区分错误文案：是"没装配"还是"这个会话不归我"）。 */
export function hasSessionCapabilityProvider(
    capability: Exclude<keyof SessionRuntimeCapabilities, "ownsSession">,
): boolean {
    return registrations.some(caps => caps[capability] !== undefined);
}

export function getSessionControl(sessionId?: string): SessionControl | undefined {
    return pick("control", sessionId);
}

export function getSessionDirectory(sessionId?: string): SessionDirectory | undefined {
    return pick("directory", sessionId);
}

export function getPeerResultHistory(sessionId?: string): PeerResultHistory | undefined {
    const recent = pick("recentPeerResults", sessionId);
    if (!recent) return undefined;
    return { recentResults: (id, limit) => recent(id, limit) };
}

/** 该会话的 cwd 落盘入口；未注册（如纯 MCP 宿主）时为 undefined。 */
export function getSessionCwdSetter(sessionId?: string): ((cwd: string) => Promise<void>) | undefined {
    if (!sessionId) return undefined;
    const setter = pick("setSessionCwd", sessionId);
    if (!setter) return undefined;
    return cwd => setter(sessionId, cwd);
}

export function getUserQuestionChannel(sessionId?: string): UserQuestionChannel | undefined {
    const ask = pick("askUser", sessionId);
    return ask ? { ask: (request, signal) => ask(request, signal) } : undefined;
}

/**
 * 当前进程是否有人在回答问题（决定 `ask_user` 是否下发）。
 * 带 sessionId 时与解析同口径：解析不到就不下发，避免把问题投给不认识该会话的实例。
 */
export function canAskUser(sessionId?: string): boolean {
    if (sessionId !== undefined) return pick("askUser", sessionId) !== undefined;
    return registrations.some(caps => caps.askUser !== undefined);
}

/**
 * 广播一条会话无关的 MCP 通知，返回送达的提供者数量（0 表示当前没有界面可展示）。
 * 通知不是状态写操作，多实例各自展示是正确语义，不做「最后者赢」。
 */
export function notifyMcpNotice(notice: McpNotice): number {
    let delivered = 0;
    for (const caps of registrations) {
        if (!caps.notifyMcpNotice) continue;
        try {
            caps.notifyMcpNotice(notice);
            delivered += 1;
        } catch (error) {
            console.error("⚠️ [runtime] MCP 通知投递失败:", error);
        }
    }
    return delivered;
}
