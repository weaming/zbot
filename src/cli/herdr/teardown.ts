/**
 * `zbot herdr teardown`：收尾一把梭 —— 归档会话 + 关掉它的 herdr 标签页。
 *
 * 与 `spawn` 对称，也保持同一节奏：**投递成功就返回**，不等回合、不等进程退出。
 * - 会话有持有者（TUI 在跑、且不在执行中）：投 `/archive`，由持有者归档并自行释放；
 *   再用 ≤0.5s 的确认窗口读一次归档态，然后关标签页（确认过就不会把归档打断）。
 * - 会话没有持有者：CLI 自己写 `session_archived`，再关标签页。
 * - 正在执行回合：拒绝（先等这一轮结束），避免把跑着的工作连根拔掉。
 *
 * 标签页定位顺序：`--tab` → `--pane` → 按 pane 的 metadata token（会话 id 后 8 位）或
 * 会话标题在**同一个 workspace** 内匹配；匹配不到就只归档，并在 `herdr.note` 里说明怎么补。
 */

import { probeOwnership, type PeerOwnership } from "../../control/registry.js";
import { shortSessionId } from "../../utils/session-id.js";
import { HerdrCliError, type TeardownCommand } from "./args.js";
import { readSessionMeta, resolveSendTarget } from "../session/store.js";
import { deliverPeerText } from "../session/send.js";
import { setSessionArchived } from "../session/mutate.js";
import { createHerdrCli, readHerdrSpawnContext, type HerdrCli, type HerdrPaneMeta } from "./client.js";

/** 确认归档落盘的窗口：通常 50ms 内就好，超出就当「持有者异步处理」如实回报。 */
const ARCHIVE_CONFIRM_TIMEOUT_MS = 500;
const ARCHIVE_CONFIRM_INTERVAL_MS = 100;

interface SessionMeta {
    title?: string;
    archived: boolean;
}

export interface TeardownDeps {
    env?: NodeJS.ProcessEnv;
    herdr?: HerdrCli;
    ownership?: (sessionId: string) => Promise<PeerOwnership>;
    resolveId?: (input: string) => Promise<string>;
    /** 无人持有时自己落盘归档。 */
    archiveLocally?: (sessionId: string) => Promise<void>;
    /** 有持有时把 `/archive` 交给持有者。 */
    archiveViaHolder?: (sessionId: string) => Promise<void>;
    /** 会话元数据（标题/归档态）；默认读事件日志。 */
    readMeta?: (sessionId: string) => Promise<SessionMeta | null>;
    write?: (text: string) => void;
}

interface TabTarget {
    tabId?: string;
    paneId?: string;
    note?: string;
}

interface TeardownResult {
    sessionId: string;
    /** 是否把 `/archive` 投递给了持有者。 */
    delivered: boolean;
    /** true = 确认已归档；null = 已投递给持有者但没在确认窗口内看到落盘。 */
    archived: boolean | null;
    herdr: {
        tabId: string | null;
        paneId: string | null;
        tabClosed: boolean;
        /** 标签页没关掉时的原因（没找到 / 关闭失败）。 */
        note?: string;
    };
    commands: { show: string };
    hint: string;
}

export async function runTeardown(command: TeardownCommand, deps: TeardownDeps = {}): Promise<void> {
    const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
    const env = deps.env ?? process.env;
    const context = readHerdrSpawnContext(env, command.workspace);
    const sessionId = await (deps.resolveId ?? resolveSendTarget)(command.id);
    const readMeta = deps.readMeta ?? readSessionMetaOf;
    const meta = await readMeta(sessionId);
    const herdr = deps.herdr ?? createHerdrCli(context.binPath);

    const target = await resolveTarget(herdr, sessionId, command, meta?.title, context.workspaceId);
    const ownership = await (deps.ownership ?? probeOwnership)(sessionId);
    if (ownership.state === "other" && ownership.info?.busy === true) {
        throw new HerdrCliError(
            "busy",
            `会话 ${shortSessionId(sessionId)} 正在执行回合：先等这一轮结束（commands.wait），再 teardown`,
            1,
            { sessionId, tabId: target.tabId ?? null, paneId: target.paneId ?? null },
        );
    }

    const held = ownership.state !== "free";
    const wasArchived = meta?.archived === true;
    let archived: boolean | null = null;
    let delivered = false;
    if (held) {
        try {
            await (deps.archiveViaHolder ?? archiveViaHolder)(sessionId);
            delivered = true;
        } catch (error) {
            // probe 之后持有者刚好退出：别让整条命令白跑，退回自己落盘（已归档过就不重复写）
            if ((error as { code?: unknown } | null)?.code !== "no_holder") throw error;
            if (!wasArchived) await (deps.archiveLocally ?? archiveLocally)(sessionId);
        }
        // 只认「基线为未归档 → 变已归档」的跃迁；本来就没归档的会话才需要确认窗口
        archived = wasArchived || (await confirmArchived(readMeta, sessionId)) ? true : null;
    } else if (wasArchived) {
        archived = true;
    } else {
        await (deps.archiveLocally ?? archiveLocally)(sessionId);
        archived = true;
    }

    // 归档已确认（或持有者已受理）后才关标签页：不会打断正在收尾的实例
    const closed = await closeTabIfKnown(herdr, target);
    const result: TeardownResult = {
        sessionId,
        delivered,
        archived,
        herdr: {
            tabId: target.tabId ?? null,
            paneId: target.paneId ?? null,
            tabClosed: closed.ok,
            ...(closed.note ? { note: closed.note } : {}),
        },
        commands: { show: `zbot session show ${sessionId}` },
        hint: archived === true
            ? "会话已归档并释放；要再开一个就重新 zbot herdr spawn"
            : `归档已交给持有者：用 ${`zbot session show ${sessionId}`} 确认（--all 里能看到已归档）`,
    };

    if (command.json) {
        write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    write(renderHuman(result));
}

async function archiveViaHolder(sessionId: string): Promise<void> {
    const delivered = await deliverPeerText({
        sessionId,
        text: "/archive",
        // 不排队：目标忙时宁可立刻失败，也不要在别处排一条"收尾"
        queue: false,
        expiresSeconds: 60,
    });
    delivered.connection.close();
}

async function archiveLocally(sessionId: string): Promise<void> {
    await setSessionArchived(sessionId, true);
}

async function readSessionMetaOf(sessionId: string): Promise<SessionMeta | null> {
    const meta = await readSessionMeta(sessionId).catch(() => null);
    if (!meta) return null;
    return {
        ...(meta.summary.title ? { title: meta.summary.title } : {}),
        archived: meta.summary.archived === true,
    };
}

/** 短窗口确认归档落盘：只读元数据，读不到就当作未确认。 */
async function confirmArchived(
    readMeta: (sessionId: string) => Promise<SessionMeta | null>,
    sessionId: string,
): Promise<boolean> {
    const deadline = Date.now() + ARCHIVE_CONFIRM_TIMEOUT_MS;
    for (;;) {
        if ((await readMeta(sessionId).catch(() => null))?.archived === true) return true;
        if (Date.now() >= deadline) return false;
        await new Promise<void>(resolve => { setTimeout(resolve, ARCHIVE_CONFIRM_INTERVAL_MS); });
    }
}

async function resolveTarget(
    herdr: HerdrCli,
    sessionId: string,
    command: TeardownCommand,
    title: string | undefined,
    workspaceId: string,
): Promise<TabTarget> {
    if (command.tab) {
        return { tabId: command.tab, ...(command.pane ? { paneId: command.pane } : {}) };
    }
    if (command.pane) {
        const pane = await herdr.getPane(command.pane).catch(() => undefined);
        return { paneId: command.pane, ...(pane?.tabId ? { tabId: pane.tabId } : {}) };
    }
    return await findPane(herdr, sessionId, title, workspaceId) ?? {
        note: "没找到这个会话的标签页（pane 元数据可能还没上报）：用 --tab=<tabId> 指定",
    };
}

/** 用 pane 的 metadata token（会话 id 后 8 位）或会话标题定位；不唯一就不猜。 */
async function findPane(
    herdr: HerdrCli,
    sessionId: string,
    title: string | undefined,
    workspaceId: string,
): Promise<TabTarget | undefined> {
    // workspace 必须严格相等：跨 workspace 的同名 tab 不该被误关
    const panes = (await herdr.listPanes().catch(() => [] as HerdrPaneMeta[]))
        .filter(pane => pane.workspaceId === workspaceId);
    const short = shortSessionId(sessionId).toUpperCase();
    const byToken = panes.filter(pane => pane.tokens?.session?.toUpperCase() === short);
    const candidates = byToken.length > 0
        ? byToken
        : title
            ? panes.filter(pane => pane.title === title)
            : [];
    if (candidates.length !== 1) return undefined;
    const [pane] = candidates;
    return { paneId: pane.paneId, ...(pane.tabId ? { tabId: pane.tabId } : {}) };
}

/** 关标签页失败（已被手动关掉、herdr 偶发报错）不该让归档成果一起丢掉。 */
async function closeTabIfKnown(herdr: HerdrCli, target: TabTarget): Promise<{ ok: boolean; note?: string }> {
    const note = target.note;
    if (!target.tabId) return { ok: false, ...(note ? { note } : {}) };
    try {
        await herdr.closeTab(target.tabId);
        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            note: `标签页 ${target.tabId} 关不掉（可能已手动关闭）：${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

function renderHuman(result: TeardownResult): string {
    const lines = [`已收尾 ${shortSessionId(result.sessionId)}`];
    lines.push(result.archived === true
        ? "· 会话已归档并释放"
        : "· 已投递 /archive（持有者异步落盘，未在本轮确认）");
    if (result.herdr.tabClosed) lines.push(`· 已关闭标签页 ${result.herdr.tabId}`);
    else lines.push(`· ${result.herdr.note ?? "没找到对应标签页"}`);
    lines.push(`· ${result.hint}`);
    return `${lines.join("\n")}\n`;
}
