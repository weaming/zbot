/**
 * 工作子会话的归属：创建关系不可变、只能由直接父会话管理、zbot 只允许一层。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SessionControl, type SessionControlHost } from "../../src/control/channel.js";
import type { PeerMessage, PeerResult } from "../../src/control/protocol.js";
import { forgetBound, locallyBoundSessionIds } from "../../src/control/registry.js";
import { createEmptySession, sessionCreatedPayload } from "../../src/events/session-replay.js";
import type { SessionDelegation } from "../../src/types/session.js";
import { sessionToolNamesFor } from "../../src/tools/session-tools.js";
import { useTmpStateDir, type TmpStateDir } from "./test-env.js";

let stateDir: TmpStateDir;
const controls: SessionControl[] = [];

beforeEach(() => {
    stateDir = useTmpStateDir("zbot-session-ownership-");
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
});

afterEach(() => {
    for (const control of controls.splice(0)) control.close();
    for (const sessionId of locallyBoundSessionIds()) forgetBound(sessionId);
    stateDir.cleanup();
});

interface Instance {
    control: SessionControl;
    host: SessionControlHost;
    held: Set<string>;
    accepted: PeerMessage[];
    archived: string[];
}

/** 一个实例：自己的持有集合 + 共享的创建关系事实（磁盘上的 session_created）。 */
function makeInstance(
    name: string,
    delegations: Map<string, SessionDelegation>,
    options: { held?: string[] } = {},
): Instance {
    const held = new Set(options.held ?? []);
    let created = 0;
    const accepted: PeerMessage[] = [];
    const archived: string[] = [];
    const host: SessionControlHost = {
        instanceId: `instance-${name}`,
        getSessionDelegation: async (sessionId) => delegations.get(sessionId),
        holdsSession: (sessionId) => held.has(sessionId),
        title: (sessionId) => sessionId,
        isBusy: () => false,
        createSession: async (_cwd, init) => {
            created += 1;
            const sessionId = `${name}-child-${created}`;
            if (init?.delegation) delegations.set(sessionId, init.delegation);
            held.add(sessionId);
            return { sessionId };
        },
        sessionCwd: async () => "/work",
        onSessionSpawned: () => {},
        archiveSpawnedSession: async (sessionId) => {
            archived.push(sessionId);
        },
        cancelSpawnedSession: async () => true,
        accept: (message) => {
            accepted.push(message);
            return { status: "accepted" as const };
        },
        rename: (_sessionId, title) => title,
        onOutbound: () => {},
        onResult: (_requester, _message, _result: PeerResult) => {},
        onLost: () => {},
        onReleased: () => {},
    };
    const control = new SessionControl(host);
    controls.push(control);
    return { control, host, held, accepted, archived };
}

describe("工作子会话归属", () => {
    test("派生时写入不可变创建关系，并由父会话所在实例认领", async () => {
        const delegations = new Map<string, SessionDelegation>();
        const root = makeInstance("root", delegations, { held: ["parent"] });

        const spawned = await root.control.spawnSession("parent", "工作子会话");
        expect(spawned.ok).toBe(true);
        if (!spawned.ok) return;

        expect(delegations.get(spawned.sessionId)).toEqual({
            parentSessionId: "parent",
            creatorInstanceId: "instance-root",
        });
        expect(root.control.isClaimed(spawned.sessionId)).toBe(true);
    });

    test("工作子会话不能再派生：zbot 只允许一层", async () => {
        const delegations = new Map<string, SessionDelegation>();
        const root = makeInstance("root", delegations, { held: ["parent"] });
        const spawned = await root.control.spawnSession("parent");
        expect(spawned.ok).toBe(true);
        if (!spawned.ok) return;

        const nested = await root.control.spawnSession(spawned.sessionId, "孙会话");
        expect(nested.ok).toBe(false);
        if (!nested.ok) expect(nested.error).toContain("只允许一层");
    });

    test("其他实例即使知道父 ID 也不能认领子会话", async () => {
        const delegations = new Map<string, SessionDelegation>();
        const root = makeInstance("root", delegations, { held: ["parent"] });
        const spawned = await root.control.spawnSession("parent");
        if (!spawned.ok) throw new Error(spawned.error);

        // B 不持有父会话：带父 ID 也不行。
        const other = makeInstance("other", delegations);
        const denied = await other.control.claim(spawned.sessionId, { parentSessionId: "parent" });
        expect(denied.ok).toBe(false);
        if (!denied.ok) {
            expect(denied.reason).toBe("ownership_denied");
            expect("message" in denied && denied.message).toContain("父会话");
        }

        // 不带父 ID 更不行。
        const anonymous = await other.control.claim(spawned.sessionId);
        expect(anonymous.ok).toBe(false);
        if (!anonymous.ok) expect(anonymous.reason).toBe("ownership_denied");
    });

    test("父会话换实例后，只有该实例能恢复子会话；兄弟不能接管", async () => {
        const delegations = new Map<string, SessionDelegation>();
        const root = makeInstance("root", delegations, { held: ["parent"] });
        const spawned = await root.control.spawnSession("parent");
        if (!spawned.ok) throw new Error(spawned.error);
        root.control.release(spawned.sessionId);

        // 父会话在 B 上（例如用户把父会话恢复到 B）：B 可以恢复子会话。
        const other = makeInstance("other", delegations, { held: ["parent"] });
        const allowed = await other.control.claim(spawned.sessionId, { parentSessionId: "parent" });
        expect(allowed.ok).toBe(true);

        // 同实例的兄弟会话不能冒充父会话。
        const sibling = makeInstance("sibling", delegations, { held: ["parent", "sibling"] });
        const denied = await sibling.control.claim(spawned.sessionId, { parentSessionId: "sibling" });
        expect(denied.ok).toBe(false);
    });

    test("只有父会话能与子会话通信", async () => {
        const delegations = new Map<string, SessionDelegation>();
        const root = makeInstance("root", delegations, { held: ["parent", "sibling"] });
        const parentClaim = await root.control.claim("parent");
        expect(parentClaim.ok).toBe(true);
        const first = await root.control.spawnSession("parent", "一");
        const second = await root.control.spawnSession("parent", "二");
        if (!first.ok || !second.ok) throw new Error("spawn failed");

        await expect(root.control.send("sibling", first.sessionId, "外部派活")).rejects.toThrow(/只接受父会话/);
        await expect(root.control.send(first.sessionId, second.sessionId, "兄弟通信")).rejects.toThrow(
            /只接受父会话|只能与父会话/,
        );
        await expect(root.control.send(first.sessionId, "sibling", "向上越级")).rejects.toThrow(/只能与父会话/);

        await expect(root.control.send("parent", first.sessionId, "父会话派活")).resolves.toBeDefined();
        await expect(root.control.send(first.sessionId, "parent", "回信父会话")).resolves.toBeDefined();
    });

    test("关闭与取消必须由父会话发起", async () => {
        const delegations = new Map<string, SessionDelegation>();
        const root = makeInstance("root", delegations, { held: ["parent", "sibling"] });
        const spawned = await root.control.spawnSession("parent");
        if (!spawned.ok) throw new Error(spawned.error);

        const denied = await root.control.closeSpawnedSession(spawned.sessionId, {
            callerSessionId: "sibling",
        });
        expect(denied.ok).toBe(false);

        const canceled = await root.control.cancelSpawnedSession(spawned.sessionId, {
            callerSessionId: "sibling",
        });
        expect(canceled.ok).toBe(false);

        const closed = await root.control.closeSpawnedSession(spawned.sessionId, {
            callerSessionId: "parent",
        });
        expect(closed.ok).toBe(true);
    });
});

describe("创建关系持久化载荷", () => {
    test("空会话与首事件补写都带上 delegation，且不会被普通会话猜测", () => {
        const delegation = { parentSessionId: "parent", creatorInstanceId: "instance" };
        const child = createEmptySession("child", "/work", "tool", delegation);
        expect(child.delegation).toEqual(delegation);
        expect(sessionCreatedPayload(child.cwd, child.origin, child.delegation)).toEqual({
            cwd: "/work",
            origin: "tool",
            delegation,
        });

        const ordinary = createEmptySession("ordinary", "/work");
        expect(ordinary.delegation).toBeUndefined();
        expect(sessionCreatedPayload(ordinary.cwd)).toEqual({ cwd: "/work" });
    });
});

describe("子会话的工具可见性", () => {
    test("工作子会话不下发派生与管理工具，但保留与父会话通信和状态查询", () => {
        const names = sessionToolNamesFor(true, true);
        expect(names).toContain("session_send");
        expect(names).toContain("session_status");
        expect(names).not.toContain("session_spawn");
        expect(names).not.toContain("session_wake");
        expect(names).not.toContain("session_close");
        expect(names).not.toContain("session_cancel");
    });

    test("根会话拿到全部会话间工具；没有控制通道时一个都不发", () => {
        expect(sessionToolNamesFor(true, false)).toEqual([
            "session_spawn",
            "session_send",
            "session_status",
            "session_close",
            "session_cancel",
            "session_wake",
        ]);
        expect(sessionToolNamesFor(false, false)).toEqual([]);
        expect(sessionToolNamesFor(false, true)).toEqual([]);
    });
});
