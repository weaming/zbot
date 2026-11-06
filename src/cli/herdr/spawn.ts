/**
 * `zbot herdr spawn`：一条命令完成「新建 herdr 标签页 + 新建 zbot 会话 + 让 TUI 认领
 * + 投递首条输入」，并回传会话元数据与等结果的提示。
 *
 * 失败面按步切开，保证错在哪一步一目了然：
 * 1) herdr 环境或 cwd 不合法 → 直接退出，什么都不留；
 * 2) 会话已建、标签页创建失败 → 报错里带 `zbot resume <id>`，会话可手动接手；
 * 3) 标签页已建、pane 里起不了 TUI → 报错里带 pane id 与手动命令；
 * 4) TUI 迟迟不认领 → `not_ready`，带重投命令（会话与标签页都保留）。
 *
 * 投递必须等 TUI 认领：控制 socket 由 TUI 侧 bind，没认领前 `send` 只会得到 no_holder。
 */

import { probeOwnership } from "../../control/registry.js";
import { abbreviatePath } from "../../format/path.js";
import { resolveCwdInput } from "../../utils/runtime-paths.js";
import { shortSessionId } from "../../utils/session-id.js";
import { DEFAULT_QUEUE_EXPIRES_SECONDS, cleanTitle, isDirectory } from "../session/args.js";
import { createSession } from "../session/mutate.js";
import { deliverPeerText } from "../session/send.js";
import { CWD_COLUMNS } from "../session/view.js";
import { HerdrCliError, usageError, type SpawnCommand } from "./args.js";
import {
    createHerdrCli,
    readHerdrCaller,
    readHerdrSpawnContext,
    type CreateTabInput,
    type CreatedTab,
    type HerdrCaller,
    type HerdrCli,
    type HerdrPaneMeta,
    type HerdrTabMeta,
} from "./client.js";

/** 认领轮询间隔：够快（TUI 冷启动 1-3s），又不至于把 connect 打满。 */
const CLAIM_POLL_INTERVAL_MS = 200;
/** 等 pane 的 agent_status 从 unknown 变成真实状态的上限：只为元数据好看，不能拖住返回。 */
const META_READY_TIMEOUT_MS = 2_000;
/** herdr 侧标签/标题的展示长度上限。 */
const MAX_LABEL_LENGTH = 80;

export interface FirstInputDelivery {
    msgId: string;
    status: "delivered" | "queued";
    position?: number;
}

export interface SpawnDeps {
    env?: NodeJS.ProcessEnv;
    /** 解析相对 cwd 的基准，测试注入。 */
    cwd?: string;
    herdr?: HerdrCli;
    createSession?: (input: { cwd: string; title?: string }) => Promise<string>;
    waitForClaim?: (sessionId: string, timeoutMs: number) => Promise<boolean>;
    deliver?: (input: { sessionId: string; text: string }) => Promise<FirstInputDelivery>;
    write?: (text: string) => void;
}

interface SpawnResult {
    sessionId: string;
    sessionShortId: string;
    title: string | null;
    cwd: string;
    herdr: {
        workspaceId: string;
        tabId: string;
        paneId: string;
        /** herdr 侧的标签页元数据；读取失败为 null（不影响本次结果）。 */
        tab: HerdrTabMeta | null;
        /** herdr 侧的 pane 元数据（agent_status / tokens 由 pane 内的 zbot 上报）。 */
        pane: HerdrPaneMeta | null;
        /** 发起本次 spawn 的 pane；不在 herdr 里时为 null。 */
        caller: HerdrCaller | null;
    };
    /** 是否投递了首条输入。 */
    delivered: boolean;
    msgId: string | null;
    status: "delivered" | "queued" | null;
    position?: number;
    /** 后续动作的命令：会话生命周期全在这一组里，调用方不用自己拼。 */
    commands: {
        /** 等结果（只在投递过时给出：没投递时 wait 会以 no_turn 失败）。 */
        wait?: string;
        /** 继续发消息。 */
        send: string;
        /** 看进度/复盘。 */
        show: string;
        /** 归档并释放持有（等价 /archive；之后不用再 close）。 */
        archive: string;
/** 只释放持有、不归档（等价 /close；数据保留，从未用过的空会话会被删）。 */
        close: string;
        /** 关掉这个 herdr 标签页。 */
        closeTab: string;
        /** 收尾一把梭：归档 + 关标签页（投递成功即返回）。 */
        teardown: string;
        /** 继续发并就地等这一轮结果（后续命令的“一条即得”写法）。 */
        sendAndWait: string;
    };
    hints: {
        /** 等首条输入这一轮（只有投递过才有）。 */
        current?: string;
        /** 后续自己发的消息怎么等结果。 */
        later: string;
        /** 观察进度的方式：在 herdr 里看终端，不在 herdr 里看事件视图（两种都给出，按所处环境选）。 */
        observe: string;
    };
}

export async function runSpawn(command: SpawnCommand, deps: SpawnDeps = {}): Promise<void> {
    const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
    const env = deps.env ?? process.env;
    const context = readHerdrSpawnContext(env, command.workspace);

    const baseCwd = deps.cwd ?? process.cwd();
    const cwd = resolveCwdInput(command.cwd, baseCwd);
    if (!isDirectory(cwd)) throw usageError(`cwd 不是已存在的目录：${cwd}`);
    const title = cleanTitle(command.title);

    const sessionId = await (deps.createSession ?? createSession)({ cwd, title });
    const herdr = deps.herdr ?? createHerdrCli(context.binPath);
    const paneEnv = forwardPaneEnv(env);
    const created = await createTabFor(herdr, sessionId, {
        workspaceId: context.workspaceId,
        cwd,
        label: normalizeLabel(command.label ?? title),
        focus: command.focus,
        ...(paneEnv ? { env: paneEnv } : {}),
    });
    await runResumeIn(herdr, created, sessionId);

    if (command.readyTimeoutSeconds > 0) {
        const ready = await (deps.waitForClaim ?? waitForSessionClaim)(
            sessionId,
            command.readyTimeoutSeconds * 1000,
        );
        if (!ready) throw notReadyError(sessionId, created, command.readyTimeoutSeconds);
    }

    const delivery = command.text
        ? await deliverOrExplain(deps.deliver ?? deliverFirstInput, { sessionId, text: command.text }, created)
        : undefined;
    // 元数据放在投递之后读：此时 pane 里的 zbot 已经上报过 agent_status，拿到的是真实状态
    const meta = await readHerdrMeta(herdr, created);

    const commands: SpawnResult["commands"] = {
        ...(delivery ? { wait: `zbot session wait ${sessionId} --msg=${delivery.msgId}` } : {}),
        send: `zbot session send ${sessionId} "<文本>"`,
        show: `zbot session show ${sessionId}`,
        // 会话被 TUI 持有时 session archive 会被 held 拒绝，归档要走持有者的 /archive
        archive: `zbot session send ${sessionId} "/archive"`,
        close: `zbot session send ${sessionId} "/close"`,
        closeTab: `herdr tab close ${created.tabId}`,
        teardown: `zbot herdr teardown ${sessionId} --tab ${created.tabId}`,
        sendAndWait: `zbot session send ${sessionId} "<文本>" --wait`,
    };
    const result: SpawnResult = {
        sessionId,
        sessionShortId: shortSessionId(sessionId),
        title: title ?? null,
        cwd,
        herdr: {
            workspaceId: context.workspaceId,
            tabId: created.tabId,
            paneId: created.paneId,
            tab: meta.tab,
            pane: meta.pane,
            caller: readHerdrCaller(env) ?? null,
        },
        delivered: Boolean(delivery),
        msgId: delivery?.msgId ?? null,
        status: delivery?.status ?? null,
        ...(delivery?.position !== undefined ? { position: delivery.position } : {}),
        commands,
        hints: {
            ...(delivery ? { current: `等首条输入这一轮：${commands.wait}` } : {}),
            later: `后续发的消息用 ${commands.sendAndWait} 一条拿到结果；`
                + `要能在中断/断线后按轮续等，就先 \`zbot session send ${sessionId} "<文本>" --json\` 拿 msgId，`
                + `再 \`zbot session wait ${sessionId} --msg=<msgId>\` 续等`,
            observe: `通用：\`zbot session show ${sessionId} --json --lite\`；`
                + `在 herdr 里还可以看终端与 pane 状态：\`herdr pane read ${created.paneId} --lines 40\`、`
                + `\`herdr pane get ${created.paneId}\``,
        },
    };

    if (command.json) {
        write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    write(renderHuman(result, env));
}

/** 等控制 socket 出现监听者：TUI 认领会话后才会 bind。 */
async function waitForSessionClaim(sessionId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ownership = await probeOwnership(sessionId);
        if (ownership.state !== "free") return true;
        if (Date.now() >= deadline) return false;
        await new Promise<void>(resolve => { setTimeout(resolve, CLAIM_POLL_INTERVAL_MS); });
    }
}

/**
 * 读 herdr 侧元数据：纯展示信息，读不到不该让整条命令失败。
 * pane 刚建好时 agent_status 还是 unknown（pane 里的 zbot 尚未上报），
 * 短暂轮询到有真实状态就停，超时就用最后读到的值。
 */
async function readHerdrMeta(
    herdr: HerdrCli,
    created: CreatedTab,
): Promise<{ tab: HerdrTabMeta | null; pane: HerdrPaneMeta | null }> {
    const deadline = Date.now() + META_READY_TIMEOUT_MS;
    let tab: HerdrTabMeta | undefined;
    let pane: HerdrPaneMeta | undefined;
    for (;;) {
        [tab, pane] = await Promise.all([
            herdr.getTab(created.tabId).catch(() => undefined),
            herdr.getPane(created.paneId).catch(() => undefined),
        ]);
        // 两个都读不到说明 herdr 侧此刻不可查，再轮询也没用
        if (!tab && !pane) break;
        const reported = pane?.agentStatus && pane.agentStatus !== "unknown";
        if (reported || Date.now() >= deadline) break;
        await new Promise<void>(resolve => { setTimeout(resolve, CLAIM_POLL_INTERVAL_MS); });
    }
    return { tab: tab ?? null, pane: pane ?? null };
}

async function deliverFirstInput(input: { sessionId: string; text: string }): Promise<FirstInputDelivery> {
    const delivered = await deliverPeerText({
        sessionId: input.sessionId,
        text: input.text,
        queue: true,
        expiresSeconds: DEFAULT_QUEUE_EXPIRES_SECONDS,
    });
    delivered.connection.close();
    return {
        msgId: delivered.msgId,
        status: delivered.queued ? "queued" : "delivered",
        ...(delivered.position !== undefined ? { position: delivered.position } : {}),
    };
}

async function createTabFor(herdr: HerdrCli, sessionId: string, input: CreateTabInput): Promise<CreatedTab> {
    try {
        return await herdr.createTab(input);
    } catch (error) {
        // 标签页没建起来，但会话已落盘：把接手命令写进错误里，别让调用方自己拼
        throw new HerdrCliError(
            "herdr_failed",
            `新建 herdr 标签页失败：${describe(error)}；会话 ${sessionId} 已创建，可手动 \`zbot resume ${sessionId}\``,
            1,
            {
                sessionId,
                resumeCommand: `zbot resume ${sessionId}`,
                deleteCommand: `zbot session delete ${sessionId}`,
                ...errorDetails(error),
            },
        );
    }
}

async function runResumeIn(herdr: HerdrCli, created: CreatedTab, sessionId: string): Promise<void> {
    try {
        await herdr.runInPane(created.paneId, `zbot resume ${sessionId}`);
    } catch (error) {
        throw new HerdrCliError(
            "herdr_failed",
            `标签页 ${created.tabId} 已建，但在 pane ${created.paneId} 里启动 zbot 失败：${describe(error)}；`
            + `可在该 pane 里手动执行 \`zbot resume ${sessionId}\``,
            1,
            {
                sessionId,
                ...handoffCommands(sessionId, created),
                ...errorDetails(error),
            },
        );
    }
}

function notReadyError(sessionId: string, created: CreatedTab, timeoutSeconds: number): HerdrCliError {
    return new HerdrCliError(
        "not_ready",
        `等了 ${timeoutSeconds}s 仍没有实例认领会话 ${sessionId}（标签页 ${created.tabId} / pane ${created.paneId}）：`
        + `先看 \`herdr pane read ${created.paneId} --lines 30\`；认领后可 \`zbot session send ${sessionId} <文本>\``,
        1,
        {
            sessionId,
            delivered: false,
            ...handoffCommands(sessionId, created),
        },
    );
}

/** 标签只做展示：去掉控制字符、压掉换行并截断，避免破坏 herdr 侧边栏排版。 */
function normalizeLabel(value: string): string {
    const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return normalized.slice(0, MAX_LABEL_LENGTH).trim() || "zbot";
}

function renderHuman(result: SpawnResult, env: NodeJS.ProcessEnv): string {
    const where = abbreviatePath(result.cwd, env.HOME, CWD_COLUMNS);
    const label = result.herdr.tab?.label;
    const state = result.herdr.pane?.agentStatus;
    const lines = [
        `herdr 标签页 ${result.herdr.tabId}${label ? `「${label}」` : ""}`
        + `（pane ${result.herdr.paneId}${state ? `，agent ${state}` : ""}）｜会话 ${result.sessionId}`
        + `${result.title ? `「${result.title}」` : ""}`,
        `cwd ${where}`,
    ];
    if (result.msgId) {
        const queued = result.status === "queued";
        lines.push(`首条输入已${queued ? `排队（第 ${result.position ?? "?"} 位）` : "投递"}（${result.msgId}）`);
    }
    if (result.hints.current) lines.push(`等结果（首条输入）：${result.commands.wait}`);
    lines.push(
        `看进度：${result.commands.show}`,
        `继续发：${result.commands.send}`,
        `后续等结果：${result.commands.sendAndWait}`,
        `收尾：${result.commands.teardown}`,
        `只归档 / 只释放 / 只关标签页：${result.commands.archive} ｜ ${result.commands.close} ｜ ${result.commands.closeTab}`,
        `观察：${result.hints.observe}`,
    );
    return `${lines.join("\n")}\n`;
}

/** 半成品状态（tab/pane 已建但没跑起来）的接手与收尾命令。 */
function handoffCommands(sessionId: string, created: CreatedTab): Record<string, unknown> {
    return {
        tabId: created.tabId,
        paneId: created.paneId,
        retryCommand: `zbot session send ${sessionId} "<文本>"`,
        teardownCommand: `zbot herdr teardown ${sessionId} --tab=${created.tabId}`,
        closeTabCommand: `herdr tab close ${created.tabId}`,
    };
}

/**
 * 把调用方 shell 里的状态目录转发给新 pane：`herdr tab create` 拉起的进程继承的是
 * herdr server 的环境，不转发的话新 TUI 会读另一个 ZBOT_STATE_DIR（症状极难查）。
 */
function forwardPaneEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
    const forwarded: Record<string, string> = {};
    for (const key of ["ZBOT_STATE_DIR", "ZBOT_ENV_FILE"]) {
        const value = env[key];
        if (value) forwarded[key] = value;
    }
    return Object.keys(forwarded).length > 0 ? forwarded : undefined;
}

/**
 * 投递失败统一补上 tab/pane 与接手、收尾命令：无论 no_holder（认领窗口里 TUI 又退出）
 * 还是 busy / queue_full / bad_reply，调用方都要能自己收拾现场。
 */
async function deliverOrExplain(
    deliver: (input: { sessionId: string; text: string }) => Promise<FirstInputDelivery>,
    input: { sessionId: string; text: string },
    created: CreatedTab,
): Promise<FirstInputDelivery> {
    try {
        return await deliver(input);
    } catch (error) {
        const cause = (error as { code?: unknown } | null)?.code;
        const code = typeof cause === "string" ? cause : "send_failed";
        const message = error instanceof Error ? error.message : String(error);
        const hint = code === "no_holder"
            ? `先看 \`herdr pane read ${created.paneId} --lines 30\` 确认 pane 里的 zbot 是否起来了，再重投；`
            : "";
        throw new HerdrCliError(
            code === "no_holder" ? "not_ready" : code,
            `会话 ${input.sessionId} 已建（标签页 ${created.tabId} / pane ${created.paneId}），但首条输入没投递成功：${hint}${message}`,
            1,
            {
                sessionId: input.sessionId,
                delivered: false,
                cause: code,
                ...handoffCommands(input.sessionId, created),
            },
        );
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function errorDetails(error: unknown): Record<string, unknown> {
    const shaped = error as { code?: unknown; details?: unknown } | null;
    const details = shaped?.details;
    return {
        cause: typeof shaped?.code === "string" ? shaped.code : null,
        ...(details && typeof details === "object" ? details as Record<string, unknown> : {}),
    };
}
