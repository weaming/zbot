import { describe, expect, test } from "bun:test";
import { AppError } from "../utils/app-error.js";
import { prepareSessionResume } from "./session-resume.js";

interface FakeHostSetup {
    archived?: boolean;
    claim?: { ok: true } | { ok: false; reason: "busy"; pid?: number } | { ok: false; reason: "error"; message: string };
    unarchiveError?: Error;
}

function fakeHost(setup: FakeHostSetup = {}) {
    const calls: string[] = [];
    const host = {
        isSessionArchived: async () => {
            calls.push("isSessionArchived");
            return setup.archived === true;
        },
        claimSession: async (_id: string, options: { noNegotiate?: boolean }) => {
            calls.push(`claim:${options.noNegotiate === true}`);
            return setup.claim ?? { ok: true as const };
        },
        unarchiveSession: async () => {
            calls.push("unarchive");
            if (setup.unarchiveError) throw setup.unarchiveError;
        },
        releaseSession: () => {
            calls.push("release");
        },
    };
    return { host, calls };
}

describe("prepareSessionResume", () => {
    test("普通会话：不协商认领，不动归档", async () => {
        const { host, calls } = fakeHost();
        await prepareSessionResume(host, "s1");
        expect(calls).toEqual(["isSessionArchived", "claim:true"]);
    });

    test("归档且未给 --unarchive：拒绝且不认领", async () => {
        const { host, calls } = fakeHost({ archived: true });
        const error = await prepareSessionResume(host, "s1").catch(item => item);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("session_archived");
        expect(calls).toEqual(["isSessionArchived"]);
    });

    test("归档且给 --unarchive：先认领再恢复", async () => {
        const { host, calls } = fakeHost({ archived: true });
        await prepareSessionResume(host, "s1", { unarchive: true });
        expect(calls).toEqual(["isSessionArchived", "claim:true", "unarchive"]);
    });

    test("被其他实例持有：报 session_busy 并带持有者 pid", async () => {
        const { host } = fakeHost({ claim: { ok: false, reason: "busy", pid: 4321 } });
        const error = await prepareSessionResume(host, "s1").catch(item => item);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("session_busy");
        expect((error as AppError).details).toEqual({ sessionId: "s1", reason: "busy", holderPid: 4321 });
        expect((error as AppError).message).toContain("session send");
    });

    test("认领内部错误：报 session_claim_failed，不套用 session_busy 文案", async () => {
        const { host } = fakeHost({ claim: { ok: false, reason: "error", message: "socket bind 失败" } });
        const error = await prepareSessionResume(host, "s1").catch(item => item);
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe("session_claim_failed");
        expect((error as AppError).details).toEqual({ sessionId: "s1", reason: "error" });
        expect((error as AppError).message).toContain("socket bind 失败");
        expect((error as AppError).message).not.toContain("session send");
    });

    test("恢复归档失败时把认领还回去", async () => {
        const { host, calls } = fakeHost({ archived: true, unarchiveError: new Error("写盘失败") });
        const error = await prepareSessionResume(host, "s1", { unarchive: true }).catch(item => item);
        expect((error as Error).message).toBe("写盘失败");
        expect(calls).toEqual(["isSessionArchived", "claim:true", "unarchive", "release"]);
    });
});
