/**
 * Job 持久化：SQLite 单文件，jobs 表存任务单，job_events 表存状态变迁。
 *
 * 不变量：
 * - 幂等键由 UNIQUE(source, idempotency_key) 保证并发下也只建一条；
 * - 状态迁移只经 transition()，非法迁移直接抛错，不做静默纠正；
 * - 终态一律清空租约，避免过期扫描把已完成的 Job 判成 lost。
 */

import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { createUlid } from "../utils/ulid.js";
import {
    canTransition,
    DEFAULT_MAX_ATTEMPTS,
    isTerminalState,
    type CommentAuthor,
    CommentNotFoundError,
    JobInvalidTransitionError,
    JobNotFoundError,
    JobConflictError,
    type CreateJobOutcome,
    type CreateJobRequest,
    type JobComment,
    type JobEvent,
    type JobEventType,
    type JobInput,
    type JobRecord,
    type JobSessionRecord,
    type JobState,
} from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    idempotency_key TEXT,
    workspace TEXT NOT NULL,
    input TEXT NOT NULL,
    state TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    session_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 1,
    lease_owner TEXT,
    lease_until TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    error TEXT,
    retried_from TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency
    ON jobs(source, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS jobs_workspace ON jobs(workspace, state);

CREATE TABLE IF NOT EXISTS job_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    type TEXT NOT NULL,
    ts TEXT NOT NULL,
    payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id, seq);

CREATE TABLE IF NOT EXISTS job_sessions (
    job_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    PRIMARY KEY (job_id, session_id)
);
CREATE INDEX IF NOT EXISTS job_sessions_job ON job_sessions(job_id, created_at);

CREATE TABLE IF NOT EXISTS job_comments (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    session_id TEXT,
    author TEXT NOT NULL,
    author_name TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    edited_at TEXT,
    deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS job_comments_job ON job_comments(job_id, created_at);
`;

/** 一次取队列时最多看多少行：避免高并发下把整张表读进内存。 */
const CLAIM_SCAN_LIMIT = 50;

interface JobRow {
    id: string;
    source: string;
    idempotency_key: string | null;
    workspace: string;
    input: string;
    state: string;
    priority: number;
    session_id: string | null;
    attempts: number;
    max_attempts: number;
    lease_owner: string | null;
    lease_until: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    error: string | null;
    retried_from: string | null;
}

interface EventRow {
    seq: number;
    job_id: string;
    type: string;
    ts: string;
    payload: string;
}

interface SessionRow {
    job_id: string;
    session_id: string;
    purpose: string;
    attempt: number;
    created_at: string;
}

interface CommentRow {
    id: string;
    job_id: string;
    session_id: string | null;
    author: string;
    author_name: string | null;
    body: string;
    created_at: string;
    edited_at: string | null;
    deleted_at: string | null;
}

function toSessionRecord(row: SessionRow): JobSessionRecord {
    return {
        jobId: row.job_id,
        sessionId: row.session_id,
        purpose: row.purpose as JobSessionRecord["purpose"],
        attempt: row.attempt,
        createdAt: row.created_at,
    };
}

function toComment(row: CommentRow): JobComment {
    return {
        id: row.id,
        jobId: row.job_id,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        author: row.author as CommentAuthor,
        ...(row.author_name ? { authorName: row.author_name } : {}),
        body: row.body,
        createdAt: row.created_at,
        ...(row.edited_at ? { editedAt: row.edited_at } : {}),
        ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    };
}

function toRecord(row: JobRow): JobRecord {
    return {
        id: row.id,
        source: row.source,
        ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
        input: JSON.parse(row.input) as JobRecord["input"],
        state: row.state as JobState,
        priority: row.priority,
        ...(row.session_id ? { sessionId: row.session_id } : {}),
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
        ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
        ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
        createdAt: row.created_at,
        ...(row.started_at ? { startedAt: row.started_at } : {}),
        ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
        ...(row.error ? { error: row.error } : {}),
        ...(row.retried_from ? { retriedFrom: row.retried_from } : {}),
    };
}

function toEvent(row: EventRow): JobEvent {
    return {
        jobId: row.job_id,
        seq: row.seq,
        type: row.type as JobEventType,
        ts: row.ts,
        payload: JSON.parse(row.payload) as Record<string, unknown>,
    };
}

export interface JobStoreOptions {
    /** 数据库文件路径；":memory:" 表示内存库（测试用）。 */
    path: string;
    /** 注入时钟，便于测试租约过期。 */
    now?: () => Date;
}

export class JobStore {
    private readonly db: Database;
    private readonly now: () => Date;
    private readonly listeners = new Set<(event: JobEvent) => void>();

    constructor(options: JobStoreOptions) {
        if (options.path !== ":memory:") fs.mkdirSync(path.dirname(options.path), { recursive: true });
        this.db = new Database(options.path, { create: true });
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA busy_timeout = 5000;");
        this.db.exec(SCHEMA);
        this.now = options.now ?? (() => new Date());
    }

    private isoNow(at: Date = this.now()): string {
        return at.toISOString();
    }

    /** 订阅状态变迁（列表流数据源）；返回取消函数。 */
    subscribe(listener: (event: JobEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    close(): void {
        this.listeners.clear();
        this.db.close();
    }

    // ---------- 读写 ----------

    /**
     * 建 Job；同 (source, idempotencyKey) 已存在时返回既有记录且 created=false。
     * 并发同 key 由唯一索引兜底：插入冲突时回读，绝不产生两条。
     */
    create(request: CreateJobRequest): CreateJobOutcome {
        // 空白 key 视同没给：落 NULL 而不是空串，否则唯一索引会把它们当成同一个 key
        const key = request.idempotencyKey?.trim() || undefined;
        if (key) {
            const existing = this.findByIdempotency(request.source, key);
            if (existing) return { job: existing, created: false };
        }

        const id = createUlid();
        const maxAttempts = request.input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        // 新卡片默认落在待办列，且默认不执行：等用户点「开始」授权（autoStart）
        const input: JobInput = {
            ...request.input,
            column: request.input.column ?? "todo",
            autoStart: request.input.autoStart ?? false,
        };
        try {
            this.db.run(
                `INSERT INTO jobs (id, source, idempotency_key, workspace, input, state, priority,
                                   attempts, max_attempts, created_at, retried_from)
                 VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?, ?)`,
                [
                    id,
                    request.source,
                    key ?? null,
                    input.workspace,
                    JSON.stringify(input),
                    input.priority ?? 0,
                    maxAttempts,
                    this.isoNow(),
                    request.retriedFrom ?? null,
                ],
            );
        } catch (error) {
            if (key) {
                const raced = this.findByIdempotency(request.source, key);
                if (raced) return { job: raced, created: false };
            }
            throw error;
        }

        this.appendEvent(id, "job_created", {
            workspace: request.input.workspace,
            prompt: request.input.prompt,
            priority: request.input.priority ?? 0,
        });
        return { job: this.getOrThrow(id), created: true };
    }

    private findByIdempotency(source: string, key: string): JobRecord | undefined {
        const row = this.db
            .query<JobRow>("SELECT * FROM jobs WHERE source = ? AND idempotency_key = ?")
            .get(source, key);
        return row ? toRecord(row) : undefined;
    }

    get(id: string): JobRecord | undefined {
        const row = this.db.query<JobRow>("SELECT * FROM jobs WHERE id = ?").get(id);
        return row ? toRecord(row) : undefined;
    }

    getOrThrow(id: string): JobRecord {
        const job = this.get(id);
        if (!job) throw new JobNotFoundError(id);
        return job;
    }

    list(filter: { states?: JobState[]; limit?: number; includeArchived?: boolean } = {}): JobRecord[] {
        const limit = filter.limit ?? 200;
        const states = filter.states;
        // 归档是正交属性：默认不返回，需要时显式带上
        const archivedClause = filter.includeArchived ? "" : " AND json_extract(input, '$.archivedAt') IS NULL";
        if (states?.length) {
            const placeholders = states.map(() => "?").join(", ");
            const rows = this.db
                .query<JobRow>(
                    `SELECT * FROM jobs WHERE state IN (${placeholders})${archivedClause}
                     ORDER BY created_at DESC LIMIT ?`,
                )
                .all(...states, limit);
            return rows.map(toRecord);
        }
        return this.db
            .query<JobRow>(`SELECT * FROM jobs WHERE 1 = 1${archivedClause} ORDER BY created_at DESC LIMIT ?`)
            .all(limit)
            .map(toRecord);
    }

    // ---------- 调度 ----------

    /**
     * 原子领取队头：优先级高的先跑，同优先级 FIFO；
     * blockedWorkspaces 里的目录一律跳过（同一 workspace 串行，避免 git 互相踩）。
     */
    claimNext(owner: string, leaseMs: number, blockedWorkspaces: ReadonlySet<string>): JobRecord | undefined {
        const claim = this.db.transaction((): string | undefined => {
            const rows = this.db
                .query<JobRow>(
                    `SELECT * FROM jobs WHERE state = 'queued'
                     AND COALESCE(json_extract(input, '$.autoStart'), 1) = 1
                     AND json_extract(input, '$.archivedAt') IS NULL
                     ORDER BY priority DESC, created_at ASC LIMIT ?`,
                )
                .all(CLAIM_SCAN_LIMIT);
            const candidate = rows.find(row => !blockedWorkspaces.has(row.workspace));
            if (!candidate) return undefined;

            const updated = this.db.run(
                `UPDATE jobs SET state = 'leased', lease_owner = ?, lease_until = ?,
                                 attempts = attempts + 1,
                                 started_at = COALESCE(started_at, ?)
                 WHERE id = ? AND state = 'queued'`,
                [owner, this.isoNow(new Date(this.now().getTime() + leaseMs)), this.isoNow(), candidate.id],
            );
            // changes=0：这一瞬间被别的 worker 抢走，本轮放弃
            return updated.changes === 1 ? candidate.id : undefined;
        });

        const id = claim();
        if (!id) return undefined;

        const job = this.getOrThrow(id);
        this.appendEvent(id, "job_attempt", { attempt: job.attempts, leaseOwner: owner });
        return job;
    }

    /** 续租；租约已被别人接手时返回 false，调用方应停止该 turn。 */
    renewLease(id: string, owner: string, leaseMs: number): boolean {
        const updated = this.db.run(
            `UPDATE jobs SET lease_until = ?
             WHERE id = ? AND lease_owner = ? AND state IN ('leased', 'running')`,
            [this.isoNow(new Date(this.now().getTime() + leaseMs)), id, owner],
        );
        return updated.changes === 1;
    }

    /** 扫描过期租约并标 lost；返回被标记的 Job（worker 崩了，副作用未知）。 */
    expireLeases(): JobRecord[] {
        const rows = this.db
            .query<JobRow>(
                `SELECT * FROM jobs
                 WHERE state IN ('leased', 'running') AND lease_until IS NOT NULL AND lease_until < ?`,
            )
            .all(this.isoNow());

        const expired: JobRecord[] = [];
        for (const row of rows) {
            try {
                expired.push(this.transition(row.id, "lost", { error: "worker 失联，租约过期" }));
            } catch (error) {
                // 并发下可能已被 worker 自己改成终态，跳过即可
                if (!(error instanceof JobInvalidTransitionError)) throw error;
            }
        }
        return expired;
    }

    /**
     * 状态迁移：非法迁移抛错（并发写会在这里暴露，而不是被静默覆盖）。
     * 终态一律清空租约。
     */
    transition(
        id: string,
        to: JobState,
        patch: { error?: string; sessionId?: string } = {},
    ): JobRecord {
        const current = this.getOrThrow(id);
        if (!canTransition(current.state, to)) throw new JobInvalidTransitionError(id, current.state, to);

        const terminal = isTerminalState(to);
        this.db.run(
            `UPDATE jobs SET state = ?, error = COALESCE(?, error),
                             session_id = COALESCE(?, session_id), finished_at = ?,
                             lease_owner = NULL, lease_until = NULL
             WHERE id = ?`,
            [
                to,
                patch.error ?? null,
                patch.sessionId ?? null,
                terminal ? this.isoNow() : null,
                id,
            ],
        );

        this.appendEvent(id, "job_state", {
            from: current.state,
            to,
            ...(patch.error ? { error: patch.error } : {}),
        });
        return this.getOrThrow(id);
    }

    /** 绑定会话 id（首次执行时创建会话）。 */
    attachSession(id: string, sessionId: string): JobRecord {
        this.db.run("UPDATE jobs SET session_id = ? WHERE id = ?", [sessionId, id]);
        return this.getOrThrow(id);
    }

    // ---------- 卡片属性与会话 ----------

    /**
     * 合并更新任务输入（标题/描述/标签/截止/meta/超时/MCP 白名单…）。
     * input 是事实源，priority 另存一列用于排队排序，必须一起写。
     */
    updateInput(id: string, patch: Partial<JobInput>): JobRecord {
        const job = this.getOrThrow(id);
        const input = { ...job.input, ...patch };
        // workspace 是独立列：调度器按它做「同目录串行」，改了输入必须同步，否则
        // 会话会建在新目录、串行判断还停在旧目录
        this.db.run("UPDATE jobs SET input = ?, priority = ?, workspace = ? WHERE id = ?", [
            JSON.stringify(input),
            input.priority ?? 0,
            input.workspace,
            id,
        ]);
        this.appendEvent(id, "job_updated", { fields: Object.keys(patch) });
        return this.getOrThrow(id);
    }

    /** 归档：从看板隐藏，状态与历史都保留；运行中不允许（先取消）。 */
    archiveJob(id: string): JobRecord {
        this.assertMutable(id, "归档");
        return this.updateInput(id, { archivedAt: this.isoNow() });
    }

    unarchiveJob(id: string): JobRecord {
        const job = this.getOrThrow(id);
        if (!job.input.archivedAt) return job;
        // 显式置 undefined：JSON.stringify 会丢掉该键，等价于「未归档」
        return this.updateInput(id, { archivedAt: undefined });
    }

    /**
     * 彻底删除任务单：连带清掉它的评论、执行会话记录与状态事件。
     * 只删 job 侧数据——zbot 的会话本身是资产，由调用方先行归档（日志仍可回看）。
     */
    deleteJob(id: string): void {
        this.assertMutable(id, "删除");
        this.db.transaction(() => {
            this.db.run("DELETE FROM job_comments WHERE job_id = ?", [id]);
            this.db.run("DELETE FROM job_sessions WHERE job_id = ?", [id]);
            this.db.run("DELETE FROM job_events WHERE job_id = ?", [id]);
            this.db.run("DELETE FROM jobs WHERE id = ?", [id]);
        })();
    }

    private assertMutable(id: string, action: string): void {
        const job = this.getOrThrow(id);
        if (job.state === "running" || job.state === "leased") {
            throw new JobConflictError(`任务正在执行，先取消再${action}`);
        }
    }

    /** 记录一次执行会话（每次 attempt 一条，人工新建为 branch）。 */
    addSession(jobId: string, sessionId: string, purpose: JobSessionRecord["purpose"], attempt: number): JobSessionRecord {
        const createdAt = this.isoNow();
        this.db.run(
            `INSERT OR REPLACE INTO job_sessions (job_id, session_id, purpose, attempt, created_at)
             VALUES (?, ?, ?, ?, ?)`,
            [jobId, sessionId, purpose, attempt, createdAt],
        );
        this.appendEvent(jobId, "session_added", { sessionId, purpose, attempt });
        return { jobId, sessionId, purpose, attempt, createdAt };
    }

    listSessions(jobId: string): JobSessionRecord[] {
        return this.db
            .query<SessionRow>("SELECT * FROM job_sessions WHERE job_id = ? ORDER BY created_at ASC")
            .all(jobId)
            .map(toSessionRecord);
    }

    // ---------- 评论 ----------

    addComment(input: {
        jobId: string;
        body: string;
        author: CommentAuthor;
        sessionId?: string;
        authorName?: string;
    }): JobComment {
        const id = createUlid();
        const createdAt = this.isoNow();
        this.db.run(
            `INSERT INTO job_comments (id, job_id, session_id, author, author_name, body, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, input.jobId, input.sessionId ?? null, input.author, input.authorName ?? null, input.body, createdAt],
        );
        this.appendEvent(input.jobId, "comment_added", { commentId: id, author: input.author });
        return {
            id,
            jobId: input.jobId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            author: input.author,
            ...(input.authorName ? { authorName: input.authorName } : {}),
            body: input.body,
            createdAt,
        };
    }

    listComments(jobId: string, options: { includeDeleted?: boolean } = {}): JobComment[] {
        const where = options.includeDeleted ? "" : " AND deleted_at IS NULL";
        return this.db
            .query<CommentRow>(`SELECT * FROM job_comments WHERE job_id = ?${where} ORDER BY created_at ASC`)
            .all(jobId)
            .map(toComment);
    }

    /** 改评论正文：软删除的不允许再改。 */
    updateComment(jobId: string, commentId: string, body: string): JobComment {
        const row = this.db
            .query<CommentRow>("SELECT * FROM job_comments WHERE id = ? AND job_id = ?")
            .get(commentId, jobId);
        if (!row) throw new CommentNotFoundError(commentId);
        if (row.deleted_at) throw new Error("评论已删除，不能编辑");

        this.db.run("UPDATE job_comments SET body = ?, edited_at = ? WHERE id = ?", [body, this.isoNow(), commentId]);
        this.appendEvent(jobId, "comment_updated", { commentId });
        return toComment({ ...row, body, edited_at: this.isoNow() });
    }

    /** 软删除：保留历史，列表默认不返回。 */
    deleteComment(jobId: string, commentId: string): JobComment {
        const row = this.db
            .query<CommentRow>("SELECT * FROM job_comments WHERE id = ? AND job_id = ?")
            .get(commentId, jobId);
        if (!row) throw new CommentNotFoundError(commentId);

        const deletedAt = this.isoNow();
        this.db.run("UPDATE job_comments SET deleted_at = ? WHERE id = ?", [deletedAt, commentId]);
        this.appendEvent(jobId, "comment_deleted", { commentId });
        return toComment({ ...row, deleted_at: deletedAt });
    }

    // ---------- 事件流 ----------

    /** 当前最大事件 seq（空表为 0）：列表首屏据此直接订阅后续增量，不必先把历史事件拉一遍。 */
    lastEventSeq(): number {
        const row = this.db.query<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM job_events").get();
        return row?.seq ?? 0;
    }

    appendEvent(jobId: string, type: JobEventType, payload: Record<string, unknown>): JobEvent {
        const ts = this.isoNow();
        const result = this.db.run(
            "INSERT INTO job_events (job_id, type, ts, payload) VALUES (?, ?, ?, ?)",
            [jobId, type, ts, JSON.stringify(payload)],
        );
        const event: JobEvent = {
            jobId,
            seq: Number(result.lastInsertRowid),
            type,
            ts,
            payload,
        };
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                console.error("[jobs] 事件监听器异常:", error);
            }
        }
        return event;
    }

    /** 读 seq > after 的事件（SSE 游标）。 */
    eventsSince(after: number, filter: { jobId?: string; limit?: number } = {}): JobEvent[] {
        const limit = filter.limit ?? 500;
        if (filter.jobId) {
            return this.db
                .query<EventRow>("SELECT * FROM job_events WHERE seq > ? AND job_id = ? ORDER BY seq ASC LIMIT ?")
                .all(after, filter.jobId, limit)
                .map(toEvent);
        }
        return this.db
            .query<EventRow>("SELECT * FROM job_events WHERE seq > ? ORDER BY seq ASC LIMIT ?")
            .all(after, limit)
            .map(toEvent);
    }
}
