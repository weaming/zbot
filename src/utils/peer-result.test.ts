import { describe, expect, test } from "bun:test";
import { parsePeerResultText } from "./peer-result.js";

describe("会话间结果的展示切分", () => {
    test("剥掉会话头与 stopReason 尾注，并把状态单独带出来", () => {
        const text = "[会话 01J8ZZZ 的结果（未正常完成）]\n改了一半\n第二行\n（stopReason: max_tokens）";

        expect(parsePeerResultText(text)).toEqual({
            body: "改了一半\n第二行",
            isResult: true,
            status: "failed",
        });
    });

    test("取消与迟到各有独立状态", () => {
        expect(parsePeerResultText("[会话 x 的结果（已取消）]\n（本轮被取消，没有文本输出）\n（stopReason: aborted）").status)
            .toBe("cancelled");
        expect(parsePeerResultText("[会话 x 的结果（迟到）]\n迟到的产出\n（stopReason: stop）").status).toBe("late");
        expect(parsePeerResultText("[会话 x 的结果]\n正常产出\n（stopReason: stop）").status).toBe("ok");
    });

    test("不是该形状时原样返回，且不冒充结果", () => {
        const ack = "已发送到会话 a1b2c3d4（msgId=7），结果稍后自动回传";
        expect(parsePeerResultText(ack)).toEqual({ body: ack, isResult: false });
        expect(parsePeerResultText("[会话 x 的结果]\n只有两行")).toEqual({
            body: "[会话 x 的结果]\n只有两行",
            isResult: false,
        });
    });
});
