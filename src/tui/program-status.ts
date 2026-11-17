/** herdr-core Program Status Protocol：OSC 7501，文本字段使用 UTF-8 Base64。 */
import fs from "node:fs";

type ProgramState = "idle" | "working" | "done" | "blocked" | "error";
type BlockKind = "permission" | "question" | "auth";

interface ProgramStatus {
    state: ProgramState;
    title?: string;
    msg?: string;
    kind?: BlockKind;
    progress?: number;
}

/** 只在 hc 的真实终端中发送，避免污染管道、ACP 或旧 Herdr 的输出。 */
export function isProgramStatusEnabled(
    env: NodeJS.ProcessEnv = process.env,
    isTTY = process.stdout.isTTY === true,
): boolean {
    return isTTY && Boolean(env.HC_TERMINAL_ID?.trim());
}

function base64Text(text: string): string {
    return Buffer.from([...text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")].slice(0, 256).join(""))
        .toString("base64");
}

export function encodeProgramStatus(status: ProgramStatus | { state: "clear" }, id?: string): string {
    if (id && !/^[A-Za-z0-9_/-]{1,128}$/.test(id)) throw new Error("OSC 7501 record id 无效");
    const fields = [`state=${status.state}`];
    if (id) fields.push(`id=${id}`);
    if (status.state !== "clear") {
        fields.push("app=zbot");
        if (status.state === "blocked" && status.kind) fields.push(`kind=${status.kind}`);
        if ((status.state === "working" || status.state === "blocked") && status.progress !== undefined) {
            if (!Number.isFinite(status.progress)) throw new Error("OSC 7501 progress 必须是有限数值");
            fields.push(`progress=${Math.max(0, Math.min(100, Math.round(status.progress)))}`);
        }
        if (status.title) fields.push(`title=${base64Text(status.title)}`);
        if (status.msg) fields.push(`msg=${base64Text(status.msg)}`);
    }
    return `\x1b]7501;${fields.join(":")}\x1b\\`;
}

export class ProgramStatusReporter {
    private readonly records = new Map<string, ProgramStatus>();
    private lastRoot?: string;
    private title?: string;
    private isReleased = false;

    constructor(
        private readonly isEnabled: boolean,
        private readonly write: (frame: string) => void = frame => { fs.writeSync(1, frame); },
        private readonly onError: (error: unknown) => void = error => console.error("[OSC 7501] 上报失败:", error),
    ) {}

    get supported(): boolean {
        return this.isEnabled && !this.isReleased;
    }

    private send(frame: string): boolean {
        if (!this.isEnabled || this.isReleased) return false;
        try { this.write(frame); return true; }
        catch (error) { this.onError(error); return false; }
    }

    setTitle(title?: string | null): void {
        this.title = title ?? undefined;
    }

    session(sessionId: string, status: ProgramStatus): void {
        if (!this.isEnabled || this.isReleased) return;
        const previous = this.records.get(sessionId);
        if (JSON.stringify(previous) === JSON.stringify(status)) return;
        if (!previous && this.records.size >= 128) {
            const oldest = this.records.keys().next().value!;
            if (!this.send(encodeProgramStatus({ state: "clear" }, oldest))) return;
            this.records.delete(oldest);
        }
        if (this.send(encodeProgramStatus(status, sessionId))) this.records.set(sessionId, status);
    }

    remove(sessionId: string): void {
        if (!this.records.has(sessionId)) return;
        if (this.send(encodeProgramStatus({ state: "clear" }, sessionId))) this.records.delete(sessionId);
    }

    /** 根状态代表整个 pane；子记录只补充会话信息，不单独推动 hc turn 计数。 */
    sync(isWorking: boolean, block?: { msg: string; kind: BlockKind }): void {
        const records = [...this.records.values()];
        const error = records.find(record => record.state === "error");
        const status: ProgramStatus = block ? { state: "blocked", ...block }
            : isWorking ? { state: "working" }
            : error ? { state: "error", msg: error.msg }
            : { state: records.some(record => record.state === "done") ? "done" : "idle" };
        status.title = this.title;
        const frame = encodeProgramStatus(status);
        if (frame !== this.lastRoot && this.send(frame)) this.lastRoot = frame;
    }

    release(): void {
        if (this.isReleased) return;
        this.send(encodeProgramStatus({ state: "clear" }));
        this.records.clear();
        this.isReleased = true;
    }
}

export const programStatus = new ProgramStatusReporter(isProgramStatusEnabled());
