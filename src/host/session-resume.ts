/**
 * 恢复旧会话的公共前置：归档判定 + 不协商认领 + 显式取消归档。
 * TUI 与无 UI 的 `zbot resume` 共用，保证两条路径的所有权语义一致：
 * 会话已被其他实例持有时直接失败，绝不抢锁造成双写。
 */

import { describeClaimFailure } from "../control/channel.js";
import { AppError } from "../utils/app-error.js";
import type { SessionLifecycle, SessionQuery } from "./session-host-types.js";

export interface SessionResumeOptions {
    /** 目标会话已归档时先恢复；缺省拒绝。 */
    unarchive?: boolean;
}

/** 恢复前置只需要归档判定与认领/取消归档/释放。 */
type ResumeHost = Pick<SessionQuery, "isSessionArchived">
    & Pick<SessionLifecycle, "claimSession" | "unarchiveSession" | "releaseSession">;

export async function prepareSessionResume(
    host: ResumeHost,
    sessionId: string,
    options: SessionResumeOptions = {},
): Promise<void> {
    const archived = await host.isSessionArchived(sessionId);
    if (archived && options.unarchive !== true) {
        throw new AppError(
            "session_archived",
            `会话已归档：${sessionId}；加 --unarchive 恢复后重试`,
            1,
            { sessionId },
        );
    }

    const claim = await host.claimSession(sessionId, { noNegotiate: true });
    if (!claim.ok) {
        const hint = `如会话仍在运行，请改用 \`zbot session send ${sessionId} <文本> --wait\``;
        // bind/内部错误不是"被占用"，不要套用 session_busy 的文案误导调用方
        if (claim.reason === "error") {
            throw new AppError(
                "session_claim_failed",
                `无法恢复会话：${claim.message}`,
                1,
                { sessionId, reason: claim.reason },
            );
        }
        const pid = claim.reason === "busy" ? claim.pid : claim.reason === "raced" ? claim.winnerPid : undefined;
        // `busy` 在这里表示「已被持有」，不一定是正在跑 turn；用自己的文案避免误导
        const reason = claim.reason === "busy"
            ? (pid ? `会话正被其他实例（PID ${pid}）持有` : "会话正被其他实例持有")
            : describeClaimFailure(claim);
        throw new AppError(
            "session_busy",
            `无法恢复会话：${reason}；${hint}`,
            1,
            { sessionId, reason: claim.reason, ...(pid ? { holderPid: pid } : {}) },
        );
    }

    if (!archived) return;
    try {
        await host.unarchiveSession(sessionId);
    } catch (error) {
        // 认领成功但恢复失败：把会话还回去，避免留下无用的 socket 占用
        host.releaseSession(sessionId, { cause: "user" });
        throw error;
    }
}
