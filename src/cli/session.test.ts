import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getSocketPath } from "../control/paths.js";
import { encodeFrame, splitFrames, type PeerFrame } from "../control/protocol.js";
import { listSavedSessionIds } from "../events/session-files.js";
import { getResponsesBaselineFile } from "../utils/state-paths.js";
import {
    formatTable,
    parseSessionArgs,
    resolveSessionIdFrom,
    runSessionCli,
    SessionCliError,
    type SessionListRow,
} from "./session.js";

let tmpDir: string;
let previousStateDir: string | undefined;
const servers: net.Server[] = [];

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zbot-session-cli-"));
    previousStateDir = process.env.ZBOT_STATE_DIR;
    process.env.ZBOT_STATE_DIR = tmpDir;
});

afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    if (previousStateDir === undefined) delete process.env.ZBOT_STATE_DIR;
    else process.env.ZBOT_STATE_DIR = previousStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function run(argv: string[], stdinText = ""): Promise<string> {
    const chunks: string[] = [];
    await runSessionCli(argv, {
        write: (text) => chunks.push(text),
        readStdin: async () => stdinText,
    });
    return chunks.join("");
}

/** 造一个只认 who / deliver 的假会话服务端；用于验证 send 的投递与结果等待。 */
function startFakePeer(
    sessionId: string,
    options: {
        busy?: boolean;
        resultText?: string;
        replyWithResult?: boolean;
        resultOk?: boolean;
        /** busy 时返回排队 ack（位次）。 */
        queuePosition?: number;
        queueEntries?: Array<Record<string, unknown>>;
        cancelResult?: { ok: boolean; reason?: "not_found" | "running" };
        /** 持有者对改名帧的应答；缺省按收到的标题回 ok。 */
        renameResult?: { ok: boolean; title?: string; error?: string };
    } = {},
): Promise<void> {
    const socketPath = getSocketPath(sessionId);
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    const server = net.createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const { frames, rest } = splitFrames(buffer);
            buffer = rest;
            for (const frame of frames) {
                if (frame.type === "who") {
                    socket.write(encodeFrame({
                        type: "who",
                        id: frame.id,
                        info: { pid: process.pid, instanceId: "fake", sessionId, busy: false, pending: 0 },
                    }));
                    continue;
                }
                if (frame.type === "queue_state") {
                    socket.write(encodeFrame({ type: "queue_state", id: frame.id, entries: options.queueEntries ?? [] }));
                    continue;
                }
                if (frame.type === "cancel_queued") {
                    const result = options.cancelResult ?? { ok: true };
                    socket.write(encodeFrame({
                        type: "cancel_queued_result",
                        id: frame.id,
                        ok: result.ok,
                        ...(result.reason ? { reason: result.reason } : {}),
                    }));
                    continue;
                }
                if (frame.type === "rename") {
                    const result = options.renameResult ?? { ok: true };
                    socket.write(encodeFrame({
                        type: "rename_result",
                        id: frame.id,
                        ok: result.ok,
                        ...(result.title !== undefined ? { title: result.title } : { title: frame.title }),
                        ...(result.error ? { error: result.error } : {}),
                    }));
                    continue;
                }
                if (frame.type !== "deliver") continue;
                if (options.busy) {
                    if (options.queuePosition !== undefined) {
                        socket.write(encodeFrame({
                            type: "ack",
                            id: frame.id,
                            ok: true,
                            queued: true,
                            position: options.queuePosition,
                        }));
                        continue;
                    }
                    socket.write(encodeFrame({ type: "ack", id: frame.id, ok: false, error: "busy" }));
                    continue;
                }
                socket.write(encodeFrame({ type: "ack", id: frame.id, ok: true }));
                if (options.replyWithResult === false) continue;
                socket.write(encodeFrame({
                    type: "result",
                    result: {
                        msgId: frame.message.id,
                        ok: options.resultOk ?? true,
                        text: options.resultText ?? "已完成",
                        stopReason: "stop",
                        ...(options.resultOk === false ? { error: "上游 500" } : {}),
                    },
                }));
            }
        });
    });
    servers.push(server);
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
    });
}

describe("parseSessionArgs", () => {
    test("无子命令时输出用法", () => {
        expect(parseSessionArgs([])).toEqual({ kind: "help" });
        expect(parseSessionArgs(["help"])).toEqual({ kind: "help" });
    });

    test("list 支持 --all / --held / --limit / --json", () => {
        expect(parseSessionArgs(["list", "--all", "--json"]))
            .toEqual({ kind: "list", all: true, json: true, held: false });
        expect(parseSessionArgs(["list", "--held", "-n", "5"])).toMatchObject({ held: true, limit: 5 });
        expect(parseSessionArgs(["list", "--limit=3"])).toMatchObject({ limit: 3 });
        expect(() => parseSessionArgs(["list", "--bogus"])).toThrow("list 不支持参数");
    });

    test("show 解析轮数与预览开关", () => {
        expect(parseSessionArgs(["show", "abc", "--turns", "5", "--full", "--json"])).toEqual({
            kind: "show",
            id: "abc",
            last: false,
            turns: 5,
            all: false,
            full: true,
            json: true,
            lite: false,
            turnsSpecified: true,
        });
        expect(parseSessionArgs(["show", "abc", "--turns=2"])).toMatchObject({ turns: 2 });
        expect(parseSessionArgs(["show", "abc", "--since=1200"])).toMatchObject({ sinceSeq: 1200 });
        expect(parseSessionArgs(["show", "abc", "--since=0"])).toMatchObject({ sinceSeq: 0 });
        expect(parseSessionArgs(["show", "abc", "--after-turn=3", "--lite"]))
            .toMatchObject({ afterTurn: 3, lite: true });
        expect(() => parseSessionArgs(["show", "abc", "--since=1", "--after-turn=3"])).toThrow("不能同时使用");
        expect(() => parseSessionArgs(["show", "abc", "--since=1", "--lite"])).toThrow("不能与 --lite 同用");
        expect(() => parseSessionArgs(["show", "abc", "--since=1", "--turns=2"])).toThrow("不能与 --turns 同用");
        expect(() => parseSessionArgs(["show", "abc", "--since", "12"])).toThrow("--since=N");
        // 不带 id 走当前会话指针；--last 取最近更新；--since 必须显式给 id
        expect(parseSessionArgs(["show"])).toMatchObject({ kind: "show", id: "", last: false });
        expect(parseSessionArgs(["show", "--last"])).toMatchObject({ id: "", last: true });
        expect(() => parseSessionArgs(["show", "abc", "--last"])).toThrow("--last");
        expect(() => parseSessionArgs(["show", "--since=1"])).toThrow("--since 需要显式会话 id");
    });

    test("new / rename / archive / delete 的参数形态", () => {
        expect(parseSessionArgs(["new", "--title", "标题", "--cwd", "/tmp"])).toEqual({
            kind: "new",
            title: "标题",
            cwd: "/tmp",
            json: false,
        });
        expect(parseSessionArgs(["rename", "abc", "新", "标题"])).toEqual({ kind: "rename", id: "abc", title: "新 标题", json: false });
        expect(parseSessionArgs(["rename", "abc", "--", "修复 --json 输出"])).toMatchObject({ title: "修复 --json 输出" });
        expect(parseSessionArgs(["archive", "abc"])).toEqual({ kind: "archive", id: "abc", json: false });
        expect(parseSessionArgs(["archive", "abc", "--json"])).toEqual({ kind: "archive", id: "abc", json: true });
        expect(parseSessionArgs(["rm", "abc"])).toEqual({ kind: "delete", id: "abc", json: false });
        expect(() => parseSessionArgs(["rename", "abc"])).toThrow("rename 需要新标题");
        expect(() => parseSessionArgs(["archive"])).toThrow("zbot session archive");
    });

    test("send 解析等待窗口", () => {
        expect(parseSessionArgs(["send", "abc", "帮我", "看看"])).toEqual({
            kind: "send",
            id: "abc",
            text: "帮我 看看",
            wait: false,
            waitSeconds: undefined,
            json: false,
            queue: true,
            expiresSeconds: 270,
        });
        // 不带秒数 = 一直等到终态；带秒数才是显式超时
        const openEnded = parseSessionArgs(["send", "abc", "hi", "--wait"]);
        expect(openEnded).toMatchObject({ wait: true });
        // 不写上限时该键直接缺省，而不是显式 undefined
        expect("waitSeconds" in openEnded).toBe(false);
        expect(parseSessionArgs(["send", "abc", "hi", "--wait=12"])).toMatchObject({ wait: true, waitSeconds: 12 });
    });

    test("send 支持排队开关、有效期与撤销", () => {
        expect(parseSessionArgs(["send", "abc", "hi", "--no-queue", "--expires=60"]))
            .toMatchObject({ queue: false, expiresSeconds: 60 });
        expect(parseSessionArgs(["send", "abc", "--cancel=01MSG"]))
            .toMatchObject({ cancelMsgId: "01MSG", text: "" });
        expect(parseSessionArgs(["send", "abc", "--cancel=01MSG", "--json"])).toMatchObject({ json: true });
        expect(() => parseSessionArgs(["send", "abc", "--cancel=01MSG", "多余正文"])).toThrow("--cancel 不需要正文");
        expect(() => parseSessionArgs(["send", "abc", "hi", "--expires=0"])).toThrow("--expires");
    });

    test("queue 子命令解析", () => {
        expect(parseSessionArgs(["queue", "abc"])).toEqual({ kind: "queue", id: "abc", json: false });
        expect(parseSessionArgs(["queue", "abc", "--json"])).toMatchObject({ json: true });
        expect(() => parseSessionArgs(["queue"])).toThrow("zbot session queue");
        expect(() => parseSessionArgs(["queue", "abc", "--nope"])).toThrow("queue 不支持参数");
    });

    test("run 解析正文与标题/目录", () => {
        expect(parseSessionArgs(["run", "跑测试"])).toEqual({ kind: "run", text: "跑测试", json: false });
        expect(parseSessionArgs(["run", "跑测试", "--title", "修 CI", "--cwd=/tmp", "--json"]))
            .toMatchObject({ text: "跑测试", title: "修 CI", cwd: "/tmp", json: true });
        expect(parseSessionArgs(["run", "--", "-开头的正文"])).toMatchObject({ text: "-开头的正文" });
        expect(() => parseSessionArgs(["run"])).toThrow("zbot session run");
        expect(() => parseSessionArgs(["run", "hi", "--nope"])).toThrow("run 不支持参数");
    });

    test("未知子命令给出用法", () => {
        expect(() => parseSessionArgs(["nope"])).toThrow("未知子命令");
    });
});

describe("resolveSessionIdFrom", () => {
    const ids = ["01ABCDEF1111", "01ABCDEF2222", "01ZZZZZZ3333"];

    test("精确 / 唯一前缀 / 唯一后缀都能命中", () => {
        expect(resolveSessionIdFrom("01ABCDEF1111", ids)).toBe("01ABCDEF1111");
        expect(resolveSessionIdFrom("01ZZZ", ids)).toBe("01ZZZZZZ3333");
        expect(resolveSessionIdFrom("F2222", ids)).toBe("01ABCDEF2222");
    });

    test("歧义与缺失都报错", () => {
        expect(() => resolveSessionIdFrom("01ABCDEF", ids)).toThrow("匹配到多个候选");
        expect(() => resolveSessionIdFrom("deadbeef", ids)).toThrow("会话不存在");
    });

    test("前缀与后缀各命中不同会话时也算歧义", () => {
        expect(() => resolveSessionIdFrom("AB", ["AB111111", "222222AB"])).toThrow("匹配到多个候选");
    });
});

describe("formatTable", () => {
    test("按显示列对齐，中文标题不挤歪副列", () => {
        const rows: SessionListRow[] = [
            {
                sessionId: "01ABCDEF1111",
                summary: { sessionId: "01ABCDEF1111", title: "中文标题", messageCount: 3, cwd: "/tmp/a", updatedAt: "2026-10-27T10:00:00.000Z" },
                ownership: { state: "free" },
            },
            {
                sessionId: "01ABCDEF2222",
                summary: { sessionId: "01ABCDEF2222", title: "abc", messageCount: 12, archived: true },
            },
        ];
        const [header, first, second] = formatTable(rows);
        expect(header).toContain("状态");
        // 归属文案复用 registry.describeOwnership，避免 CLI 与 TUI 两套措辞
        expect(first).toContain("未认领");
        expect(first).toContain("中文标题");
        expect(second).toContain("已归档");
        // ID 列的显示起点一致，说明列宽按显示宽度而非码元数对齐
        expect(visibleWidth(first!.slice(0, first!.indexOf("CDEF"))))
            .toBe(visibleWidth(second!.slice(0, second!.indexOf("CDEF"))));
    });
});

describe("会话命令行端到端", () => {
    test("new / list / rename / archive / unarchive / delete 全流程落到磁盘", async () => {
        const created = await run(["new", "--title", "首个会话", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        expect(listSavedSessionIds()).toEqual([sessionId]);

        const listed = JSON.parse(await run(["list", "--json"])) as Array<Record<string, unknown>>;
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ sessionId, title: "首个会话", turns: 0, archived: false, status: "idle" });

        await run(["rename", sessionId.slice(-8), "改名后"]);
        const shown = JSON.parse(await run(["show", sessionId.slice(-8), "--json"])) as Record<string, unknown>;
        expect(shown).toMatchObject({ sessionId, title: "改名后", totalTurns: 0 });

        await run(["archive", sessionId]);
        expect(await run(["list", "--json"])).toBe("[]\n");
        expect(JSON.parse(await run(["list", "--all", "--json"])) as unknown[]).toHaveLength(1);

        await run(["unarchive", sessionId]);
        expect(JSON.parse(await run(["list", "--json"])) as unknown[]).toHaveLength(1);

        await run(["delete", sessionId]);
        expect(listSavedSessionIds()).toEqual([]);
        expect(fs.existsSync(path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`))).toBe(false);
    });

    test("new 拒绝不存在的 cwd", async () => {
        await expect(run(["new", "--cwd", path.join(tmpDir, "missing")])).rejects.toThrow("cwd 不是已存在的目录");
    });

    test("会话无人持有时 send 拒绝执行，不会本地启动模型", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await expect(run(["send", sessionId, "/help"])).rejects.toMatchObject({
            code: "no_holder",
            details: { sessionId, delivered: false },
        });
    });

    test("send --wait 拿到运行中会话的回合结果", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, { resultText: "做完了" });

        expect(await run(["send", sessionId.slice(-8), "跑一下", "--wait=5"])).toBe("做完了\n");
        const payload = JSON.parse(await run(["send", sessionId, "再跑", "--wait=5", "--json"])) as Record<string, unknown>;
        expect(payload).toMatchObject({ sessionId, ok: true, text: "做完了" });
    });

    test("对方忙时 --no-queue 报可读错误", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, { busy: true });
        await expect(run(["send", sessionId, "hi", "--wait=5", "--no-queue"])).rejects.toThrow("正在执行中");
    });

    test("对方忙时默认排队：返回 queued 与位次，可查队列与撤销", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, {
            busy: true,
            queuePosition: 2,
            queueEntries: [{
                msgId: "01QUEUED",
                from: "cli-1",
                queuedAt: "2026-01-01T00:00:00.000Z",
                position: 2,
            }],
        });

        const queued = JSON.parse(await run(["send", sessionId, "追加指令", "--json"])) as Record<string, unknown>;
        expect(queued).toMatchObject({ sessionId, delivered: true, queued: true, position: 2 });
        expect(await run(["send", sessionId, "追加指令"])).toContain("已排队到");

        const snapshot = JSON.parse(await run(["queue", sessionId, "--json"])) as Record<string, unknown>;
        expect(snapshot).toMatchObject({ holding: true });
        expect((snapshot.entries as unknown[])).toHaveLength(1);
        expect(await run(["queue", sessionId])).toContain("#2 01QUEUED");

        expect(JSON.parse(await run(["send", sessionId, "--cancel=01QUEUED", "--json"])))
            .toMatchObject({ sessionId, msgId: "01QUEUED", cancelled: true });
    });

    test("撤销已在执行的消息返回 send_running", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, { cancelResult: { ok: false, reason: "running" } });
        const error = await run(["send", sessionId, "--cancel=01RUNNING"]).catch(item => item);
        expect(error).toBeInstanceOf(SessionCliError);
        expect((error as SessionCliError).code).toBe("send_running");
    });

    test("被持有时 rename 交给持有者，其余写操作仍拒绝且不落任何事件", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId);
        const eventFile = path.join(tmpDir, "sessions", "events", `${sessionId}.jsonl`);
        const before = fs.readFileSync(eventFile, "utf8");

        // 标题是元数据：运行中也能改，由持有者落盘，CLI 不写本地日志
        const renamed = await run(["rename", sessionId, "新标题"]);
        expect(renamed).toContain("已重命名");
        expect(renamed).toContain("新标题");
        expect(fs.readFileSync(eventFile, "utf8")).toBe(before);

        for (const argv of [["archive", sessionId], ["delete", sessionId]]) {
            await expect(run(argv)).rejects.toThrow("正被其他实例持有");
        }
        expect(fs.readFileSync(eventFile, "utf8")).toBe(before);
    });

    test("持有者拒绝改名时把原因带出来，不写成成功", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, { renameResult: { ok: false, error: "标题不能为空" } });

        const error = await run(["rename", sessionId, "随便什么"]).catch(error => error);
        expect(error).toBeInstanceOf(SessionCliError);
        expect(error.code).toBe("rename_failed");
        expect(error.message).toContain("标题不能为空");
    });

    test("send --wait 超时：标记已投递并给出独立退出码", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, { replyWithResult: false });

        const error = await run(["send", sessionId, "跑一下", "--wait=1"]).catch(error => error);
        expect(error).toBeInstanceOf(SessionCliError);
        expect(error.code).toBe("wait_timeout");
        expect(error.exitCode).toBe(2);
        expect(error.details).toMatchObject({ delivered: true });
        expect(error.message).toContain("不要重复发送");
    });

    test("对方回合失败：结果文本随错误带出", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        await startFakePeer(sessionId, { resultOk: false, resultText: "半截输出" });

        const error = await run(["send", sessionId, "跑一下", "--wait=5"]).catch(error => error);
        expect(error.code).toBe("peer_failed");
        expect(error.details).toMatchObject({ delivered: true, partialText: "半截输出" });
        // 人类模式（非 --json）也要把部分输出带到 stderr
        expect(error.message).toContain("半截输出");
    });

    test("delete 连带清掉快照、流式旁路、socket 与锁文件", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        const eventsDir = path.join(tmpDir, "sessions", "events");
        const lockFile = path.join(tmpDir, "sessions", "locks", `${sessionId}.lock`);
        const extras = [
            path.join(eventsDir, `${sessionId}.snapshot.json`),
            path.join(eventsDir, `${sessionId}.stream.jsonl`),
            getSocketPath(sessionId),
            lockFile,
        ];
        fs.mkdirSync(path.dirname(extras[2]!), { recursive: true });
        fs.mkdirSync(path.dirname(lockFile), { recursive: true });
        for (const extra of extras.slice(0, 3)) fs.writeFileSync(extra, "");
        const baselineFile = getResponsesBaselineFile(sessionId);
        fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
        fs.writeFileSync(baselineFile, "{}");
        extras.push(baselineFile);
        // 残留锁（进程已退出）：删除流程应接管并在收尾时清掉
        fs.writeFileSync(lockFile, JSON.stringify({
            pid: 999_999,
            sessionId,
            lockedAt: "2026-10-28T00:00:00+08:00",
            updatedAt: "2026-10-28T00:00:00+08:00",
            ownerId: "stale",
        }));

        await run(["delete", sessionId]);
        expect(extras.filter(extra => fs.existsSync(extra))).toEqual([]);
    });

    test("show --json 键集合稳定：缺省值为 null 而非整键消失", async () => {
        const created = await run(["new", "--json"]);
        const { sessionId } = JSON.parse(created) as { sessionId: string };
        const shown = JSON.parse(await run(["show", sessionId, "--json"])) as Record<string, unknown>;

        for (const key of ["title", "cwd", "createdAt", "updatedAt", "modelSelection", "holderPid", "busy"]) {
            expect(Object.prototype.hasOwnProperty.call(shown, key)).toBe(true);
        }
        expect(shown).toMatchObject({ status: "idle", holderPid: null, modelSelection: null });
    });

    test("show 增量读取：--since 事件视图、--lite 精简回合、lastSeq 游标", async () => {
        const sessionId = "01M5ZJSHOWINCR0000000000001";
        const eventsDir = path.join(tmpDir, "sessions", "events");
        fs.mkdirSync(eventsDir, { recursive: true });
        const line = (seq: number, event: Record<string, unknown>) =>
            JSON.stringify({ seq, ts: "2026-10-28T00:00:00.000Z", sessionId, ...event });
        fs.writeFileSync(path.join(eventsDir, `${sessionId}.jsonl`), [
            line(1, { type: "session_created", payload: { cwd: tmpDir } }),
            line(2, { type: "user_message", payload: { text: "第一问", turnId: "t1", trigger: "user" } }),
            line(3, { type: "turn_message", payload: { turnId: "t1", message: { role: "assistant", content: "第一答" } } }),
            line(4, { type: "turn_commit", payload: { turnId: "t1" } }),
            line(5, { type: "user_message", payload: { text: "第二问", turnId: "t2", trigger: "user" } }),
            line(6, { type: "turn_message", payload: { turnId: "t2", message: { role: "assistant", content: "第二答" } } }),
            line(7, { type: "turn_commit", payload: { turnId: "t2" } }),
        ].join("\n") + "\n");

        const incremental = JSON.parse(await run(["show", sessionId, "--json", "--since=4"])) as Record<string, any>;
        expect(incremental.lastSeq).toBe(7);
        expect(incremental.events.map((event: any) => event.seq)).toEqual([5, 6, 7]);
        expect(incremental.events[0].summary.text).toBe("第二问");

        // 没有新事件时不报错，lastSeq 仍可续读
        const empty = JSON.parse(await run(["show", sessionId, "--json", "--since=7"])) as Record<string, any>;
        expect(empty.events).toEqual([]);
        expect(empty.lastSeq).toBe(7);

        const full = JSON.parse(await run(["show", sessionId, "--json"])) as Record<string, any>;
        expect(full.lastSeq).toBe(7);
        expect(full.totalTurns).toBe(2);

        const lite = JSON.parse(await run(["show", sessionId, "--json", "--lite", "--all"])) as Record<string, any>;
        expect(lite.turnDetails[0]).toMatchObject({ messageCount: 2, lastAssistant: "第一答" });
        expect(lite.turnDetails[0].messages).toBeUndefined();

        // 回合游标：只返回第 1 轮之后的回合
        const afterTurn = JSON.parse(await run(["show", sessionId, "--json", "--after-turn=1"])) as Record<string, any>;
        expect(afterTurn.turnDetails.map((turn: any) => turn.index)).toEqual([2]);

        const human = await run(["show", sessionId, "--since=5"]);
        expect(human).toContain("#6");
        expect(human).not.toContain("#5 ");
        expect(await run(["show", sessionId, "--lite"])).toContain("assistant: 第二答");
    });

    test("--full 也剥掉控制序列，未知 role 不抛裸 JS 错误", async () => {
        const sessionId = "01M5ZJTESTROLE000000000001";
        const eventsDir = path.join(tmpDir, "sessions", "events");
        fs.mkdirSync(eventsDir, { recursive: true });
        const line = (seq: number, event: Record<string, unknown>) =>
            JSON.stringify({ seq, ts: "2026-10-28T00:00:00.000Z", sessionId, ...event });
        fs.writeFileSync(path.join(eventsDir, `${sessionId}.jsonl`), [
            line(1, { type: "session_created", payload: { cwd: tmpDir } }),
            line(2, {
                type: "standalone_turn",
                payload: {
                    messages: [
                        { id: "m1", createdAt: "2026-10-28T00:00:01.000Z", role: "assistant", content: "a\u001b[2Jb" },
                        { id: "m2", createdAt: "2026-10-28T00:00:02.000Z", role: "developer", content: "自定义角色" },
                    ],
                },
            }),
        ].join("\n") + "\n");

        const output = await run(["show", "01M5ZJTESTROLE000000000001", "--all", "--full"]);
        expect(output).not.toContain("\u001b");
        expect(output).toContain("ab");
        expect(output).toContain("developer: 自定义角色");
    });

    test("send 参数：--wait 空格取值与未知开关都报错", () => {
        expect(() => parseSessionArgs(["send", "abc", "hi", "--wait", "300"])).toThrow("--wait=300");
        expect(() => parseSessionArgs(["send", "abc", "hi", "--no-wait"])).toThrow("send 不支持参数");
        expect(parseSessionArgs(["send", "abc", "--", "-开头的正文"])).toMatchObject({ text: "-开头的正文" });
        // --json 现在是 rename 的合法开关；只有未知开关才报错
        expect(parseSessionArgs(["rename", "abc", "新名", "--json"])).toMatchObject({ json: true, title: "新名" });
        expect(() => parseSessionArgs(["rename", "abc", "--bogus"])).toThrow("rename 不支持参数");
    });
});

describe("日志异常与列表完整性", () => {
    test("事件日志读不出有效事件时仍留一行并标注损坏", async () => {
        const sessionId = "01GARBAGE0000000000000001";
        const eventsDir = path.join(tmpDir, "sessions", "events");
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.writeFileSync(path.join(eventsDir, `${sessionId}.jsonl`), "not-json\n");

        const listed = JSON.parse(await run(["list", "--all", "--json"])) as Array<Record<string, unknown>>;
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ sessionId, corrupted: true, turns: 0 });
        expect(await run(["list", "--all"])).toContain("日志损坏");
    });

    test("new --json 无标题时 title 为 null 而非缺键", async () => {
        const created = JSON.parse(await run(["new", "--json"])) as Record<string, unknown>;
        expect(Object.prototype.hasOwnProperty.call(created, "title")).toBe(true);
        expect(created.title).toBeNull();
    });

    test("show 对损坏日志给出 corrupted 与提示行", async () => {
        const sessionId = "01GARBAGE0000000000000002";
        const eventsDir = path.join(tmpDir, "sessions", "events");
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.writeFileSync(path.join(eventsDir, `${sessionId}.jsonl`), "not-json\n");

        const shown = JSON.parse(await run(["show", sessionId, "--json"])) as Record<string, unknown>;
        expect(shown).toMatchObject({ sessionId, corrupted: true, totalTurns: 0 });
        expect(typeof shown.updatedAt).toBe("string");
        expect(await run(["show", sessionId])).toContain("日志   损坏");
    });
});

describe("写操作的 --json 契约", () => {
    test("rename / archive / delete 都支持 --json", async () => {
        const { sessionId } = JSON.parse(await run(["new", "--json"])) as { sessionId: string };

        expect(JSON.parse(await run(["rename", sessionId, "新标题", "--json"]))).toMatchObject({
            sessionId,
            action: "rename",
            title: "新标题",
        });
        expect(JSON.parse(await run(["archive", sessionId, "--json"]))).toMatchObject({
            sessionId,
            action: "archive",
            archived: true,
        });
        expect(JSON.parse(await run(["unarchive", sessionId, "--json"]))).toMatchObject({ archived: false });
        expect(JSON.parse(await run(["delete", sessionId, "--json"]))).toMatchObject({
            sessionId,
            action: "delete",
            deleted: true,
        });
    });
});

describe("协议帧解析", () => {
    test("splitFrames 与 encodeFrame 往返一致", () => {
        const frame: PeerFrame = { type: "ping", id: "p1" };
        expect(splitFrames(encodeFrame(frame)).frames).toEqual([frame]);
    });
});
