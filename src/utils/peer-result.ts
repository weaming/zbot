/**
 * 会话间结果的展示切分：`formatResultText`（control/channel）产出的是给模型看的文本，
 * 带会话头与 stopReason 尾注；界面上原样铺一遍既啰嗦又泄露内部字段，也会丢掉状态色。
 *
 * 只拆这一种既定形状，其他文本原样返回（`isResult: false`）。
 */

const RESULT_HEADER = /^\[会话 .+ 的结果(（已取消）|（未正常完成）)?(（迟到）)?\]$/;
const RESULT_FOOTER = /^（stopReason: .+）$/;

/** 结果状态：正常产出、被取消、未正常完成、迟到。 */
export type PeerResultStatus = "ok" | "cancelled" | "failed" | "late";

export interface PeerResultText {
    /** 可直接展示的正文（已剥掉模型侧包装） */
    body: string;
    /** 是否识别为会话间结果：只有它是真产出，回执/超时提示都不算 */
    isResult: boolean;
    /** 结果状态；`isResult` 为 false 时不带 */
    status?: PeerResultStatus;
}

/** 拆出正文与状态；不是该形状时原样返回。 */
export function parsePeerResultText(text: string): PeerResultText {
    const lines = text.split("\n");
    if (lines.length < 3) return { body: text, isResult: false };

    const header = lines[0] ?? "";
    const footer = lines[lines.length - 1] ?? "";
    const matched = RESULT_HEADER.exec(header);
    if (!matched || !RESULT_FOOTER.test(footer)) return { body: text, isResult: false };

    const status: PeerResultStatus = matched[1] === "（已取消）"
        ? "cancelled"
        : matched[1] === "（未正常完成）"
            ? "failed"
            : matched[2] === "（迟到）"
                ? "late"
                : "ok";
    return { body: lines.slice(1, -1).join("\n").trim(), isResult: true, status };
}
