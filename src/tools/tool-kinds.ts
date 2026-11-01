/**
 * 工具语义判定：按工具名识别 patch / 文件变更等类别。
 *
 * 发送前适配（orchestrator）与展示层（tui）共用同一口径，
 * 新增判定只加在这里，避免两处识别逻辑漂移。
 */

/** 判断是否为 apply_patch / codex patch 工具。 */
export function isApplyPatchTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase();
    return (
        normalized === "apply_patch"
        || normalized.endsWith("__apply_patch")
        || normalized.endsWith(":apply_patch")
        || normalized.includes("apply_patch")
    );
}

/** 判断是否为文件变更工具（edit_file / write_file / apply_patch 等）。 */
export function isFileMutationTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase();
    return (
        normalized === "edit_file"
        || normalized === "write_file"
        || normalized === "write_files"
        || normalized.endsWith("__edit_file")
        || normalized.endsWith("__write_file")
        || normalized.endsWith("__write_files")
        || normalized.endsWith(":edit_file")
        || normalized.endsWith(":write_file")
        || isApplyPatchTool(toolName)
    );
}

/** 获取 patch 工具的显示标识标签。 */
export function getPatchToolTag(toolName: string): string | undefined {
    if (!isApplyPatchTool(toolName)) return undefined;
    return toolName.toLowerCase().includes("codex") ? "codex:apply_patch" : "apply_patch";
}

/** 判断是否为会话间发送工具（session_send）：它的结果是要读的对话正文，不是日志。 */
export function isPeerSendTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase();
    return (
        normalized === "session_send"
        || normalized.endsWith("__session_send")
        || normalized.endsWith(":session_send")
    );
}

/** session_send 的调用语义：目标会话、正文、是否在等对方结果。 */
export interface PeerSendCall {
    session: string;
    text: string;
    /** expect_result=true 或 wait_seconds>0：这轮调用会带回对方的产出。 */
    expectResult: boolean;
    /** 就地等待的秒数，0 表示不等（结果稍后自动回传）。 */
    waitSeconds: number;
}

/** 解析 session_send 参数；不是合法对象时返回 undefined，交给调用方退回常规处理。 */
export function parsePeerSendCall(args?: string): PeerSendCall | undefined {
    const rawArgs = args?.trim();
    if (!rawArgs) return undefined;

    let parsed: unknown;
    try {
        parsed = JSON.parse(rawArgs);
    } catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

    const record = parsed as Record<string, unknown>;
    const waitSeconds = typeof record.wait_seconds === "number"
        && Number.isFinite(record.wait_seconds)
        && record.wait_seconds > 0
        ? record.wait_seconds
        : 0;
    return {
        session: typeof record.session === "string" ? record.session.trim() : "",
        text: typeof record.text === "string" ? record.text : "",
        expectResult: record.expect_result === true || waitSeconds > 0,
        waitSeconds,
    };
}
