import { describe, expect, test } from "bun:test";
import { encodeProgramStatus, isProgramStatusEnabled, ProgramStatusReporter } from "./program-status.js";

function decode(frame: string): Record<string, string> {
    expect(frame.startsWith("\x1b]7501;")).toBe(true);
    expect(frame.endsWith("\x1b\\")).toBe(true);
    return Object.fromEntries(frame.slice(7, -2).split(":").map(field => {
        const split = field.indexOf("=");
        return [field.slice(0, split), field.slice(split + 1)];
    }));
}

describe("OSC 7501 Program Status Protocol", () => {
    test("只在带 hc 身份的 TTY 启用，管道和旧 Herdr 不输出", () => {
        expect(isProgramStatusEnabled({}, true)).toBe(false);
        expect(isProgramStatusEnabled({ HERDR_ENV: "1" }, true)).toBe(false);
        expect(isProgramStatusEnabled({ HC_TERMINAL_ID: "t1" }, false)).toBe(false);
        expect(isProgramStatusEnabled({ HC_TERMINAL_ID: "t1" }, true)).toBe(true);
        const frames: string[] = [];
        const reporter = new ProgramStatusReporter(false, frame => { frames.push(frame); });
        reporter.session("session", { state: "working" });
        reporter.sync(true);
        reporter.release();
        expect(frames).toEqual([]);
    });

    test("官方字段与 Base64 编码，控制字符不能注入额外终端指令", () => {
        const fields = decode(encodeProgramStatus({
            state: "blocked", kind: "permission", progress: 40, title: "标题:中文", msg: "运行?\x1b]0;坏标题\x07",
        }, "session/tool"));
        expect(fields).toMatchObject({ state: "blocked", kind: "permission", progress: "40", id: "session/tool", app: "zbot" });
        expect(Buffer.from(fields.title!, "base64").toString()).toBe("标题:中文");
        expect(Buffer.from(fields.msg!, "base64").toString()).not.toContain("\x1b");
        expect(() => encodeProgramStatus({ state: "idle" }, "bad:id")).toThrow();
        expect(() => encodeProgramStatus({ state: "working", progress: NaN })).toThrow();
        expect(decode(encodeProgramStatus({ state: "done", kind: "auth", progress: 20 }))).not.toHaveProperty("kind");
        expect(decode(encodeProgramStatus({ state: "working", progress: 150 })).progress).toBe("100");
    });

    test("pane 聚合阻塞优先，其次运行，最后错误与完成，重复根状态不重发", () => {
        const frames: string[] = [];
        const reporter = new ProgramStatusReporter(true, frame => { frames.push(frame); });
        reporter.setTitle("任务");
        reporter.reassert();
        expect(frames).toHaveLength(0);
        reporter.sync(false);
        reporter.sync(false);
        expect(frames).toHaveLength(1);
        reporter.reassert();
        expect(frames).toHaveLength(2);
        expect(frames[1]).toBe(frames[0]);
        reporter.session("one", { state: "working" });
        reporter.session("two", { state: "done" });
        reporter.sync(true);
        expect(decode(frames.at(-1)!).state).toBe("working");
        reporter.sync(true, { kind: "question", msg: "等待回答" });
        expect(decode(frames.at(-1)!)).toMatchObject({ state: "blocked", kind: "question" });
        reporter.session("one", { state: "error", msg: "上游失败" });
        reporter.sync(false);
        expect(decode(frames.at(-1)!).state).toBe("error");
        reporter.session("one", { state: "done" });
        reporter.sync(false);
        expect(decode(frames.at(-1)!).state).toBe("done");
        reporter.remove("one");
        expect(decode(frames.at(-1)!)).toEqual({ state: "clear", id: "one" });
        reporter.release();
        expect(decode(frames.at(-1)!)).toEqual({ state: "clear" });
        const count = frames.length;
        reporter.sync(true);
        reporter.release();
        expect(frames).toHaveLength(count);
    });

    test("子记录有界，发送失败可重试，退出清除全部记录", () => {
        const frames: string[] = [];
        const errors: unknown[] = [];
        let shouldFail = true;
        const reporter = new ProgramStatusReporter(true, frame => {
            if (shouldFail) throw new Error("暂时写失败");
            frames.push(frame);
        }, error => { errors.push(error); });
        reporter.sync(true);
        expect(errors).toHaveLength(1);
        shouldFail = false;
        reporter.sync(true);
        expect(frames).toHaveLength(1);
        for (let index = 0; index < 130; index++) reporter.session(`session_${index}`, { state: "done" });
        expect(frames.map(decode).filter(frame => frame.state === "clear")).toHaveLength(2);
        reporter.release();
        expect(decode(frames.at(-1)!)).toEqual({ state: "clear" });
    });
});
