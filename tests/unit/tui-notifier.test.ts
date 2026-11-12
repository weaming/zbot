import { describe, expect, it, spyOn } from "bun:test";
import {
    sanitizeNotificationText,
    sendTerminalNotification,
    notifyTurnResult,
} from "../../src/tui/notifier.js";
import { defaultTestConfig, useConfig } from "./test-config.js";

describe("TUI 终端通知 (Ghostty / OSC 777 & OSC 9)", () => {
    it("sanitizeNotificationText 清洗控制字符、分号与反斜杠，合并换行与空格", () => {
        const raw = "第一行\n第二行;含有分号\\还有反斜杠 \x1b[31m红字\x1b[0m\x07\x00";
        const cleaned = sanitizeNotificationText(raw);
        expect(cleaned).not.toContain("\n");
        expect(cleaned).not.toContain(";");
        expect(cleaned).not.toContain("\\");
        expect(cleaned).not.toContain("\x07");
        expect(cleaned).toBe("第一行 第二行 含有分号 还有反斜杠 红字");
    });

    it("sendTerminalNotification 输出符合 OSC 777 与 OSC 9 标准的转义序列", () => {
        let output = "";
        const writeSpy = spyOn(process.stdout, "write").mockImplementation((str: any) => {
            output += str;
            return true;
        });

        try {
            sendTerminalNotification({
                title: "zbot 会话",
                body: "任务处理完成！",
                force: true,
            });

            // OSC 777 校验
            expect(output).toContain("\x1b]777;notify;zbot 会话;任务处理完成！\x07");
            // OSC 9 校验
            expect(output).toContain("\x1b]9;zbot 会话: 任务处理完成！\x07");
        } finally {
            writeSpy.mockRestore();
        }
    });

    it("notifyTurnResult 在前台快速完成（<3s）时不发通知，避免打扰", () => {
        let called = false;
        const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => {
            called = true;
            return true;
        });

        try {
            notifyTurnResult({
                sessionId: "s1",
                sessionName: "快速问答",
                text: "你好呀",
                durationMs: 1200,
                isBackground: false,
                isError: false,
            });

            expect(called).toBe(false);
        } finally {
            writeSpy.mockRestore();
        }
    });

    it("notifyTurnResult 在前台耗时较长（>=3s）时触发通知", () => {
        let output = "";
        const writeSpy = spyOn(process.stdout, "write").mockImplementation((str: any) => {
            output += str;
            return true;
        });

        try {
            notifyTurnResult({
                sessionId: "s1",
                sessionName: "长任务",
                text: "已完成多文件代码重构与单测编写",
                durationMs: 4500,
                isBackground: false,
                isError: false,
                force: true,
            });

            expect(output).toContain("zbot · 长任务");
            expect(output).toContain("已完成多文件代码重构与单测编写");
        } finally {
            writeSpy.mockRestore();
        }
    });

    it("notifyTurnResult 在后台会话或报错时无视耗时立即触发通知", () => {
        let output = "";
        const writeSpy = spyOn(process.stdout, "write").mockImplementation((str: any) => {
            output += str;
            return true;
        });

        try {
            // 后台会话完成（哪怕耗时只有 500ms）
            notifyTurnResult({
                sessionId: "s2",
                sessionName: "后台数据拉取",
                text: "数据已拉取完毕",
                durationMs: 500,
                isBackground: true,
                isError: false,
                force: true,
            });

            expect(output).toContain("zbot · 后台数据拉取");
            expect(output).toContain("数据已拉取完毕");

            output = "";

            // 执行报错
            notifyTurnResult({
                sessionId: "s1",
                sessionName: "编译代码",
                text: "⚠️ 编译失败：语法错误",
                durationMs: 300,
                isBackground: false,
                isError: true,
                force: true,
            });

            expect(output).toContain("zbot · 编译代码");
            expect(output).toContain("⚠️ 编译失败：语法错误");
        } finally {
            writeSpy.mockRestore();
        }
    });

    it("配置里关掉通知时静默", () => {
        const restoreConfig = useConfig(defaultTestConfig({
            tui: { disableNotifications: true, debugWheel: false },
        })).restore;

        let called = false;
        const writeSpy = spyOn(process.stdout, "write").mockImplementation(() => {
            called = true;
            return true;
        });

        try {
            sendTerminalNotification({
                title: "测试",
                body: "测试内容",
                force: true,
            });
            expect(called).toBe(false);
        } finally {
            restoreConfig();
            writeSpy.mockRestore();
        }
    });
});
