/**
 * Job 执行上下文：让工具知道「当前正在为哪张任务卡干活」。
 *
 * 用 AsyncLocalStorage 而不是全局变量：同一进程会并行跑多个任务，
 * 全局变量会把 A 任务的评论写到 B 卡片上。
 *
 * 评论写入器由装配层（web）注册，tools 层不反向依赖 jobs 层。
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface JobContext {
    jobId: string;
    sessionId?: string;
}

export type JobCommentWriter = (input: { jobId: string; sessionId?: string; body: string }) => void;

const storage = new AsyncLocalStorage<JobContext>();
let commentWriter: JobCommentWriter | undefined;

/** 由装配层注册；重复调用以后者为准。 */
export function setJobCommentWriter(writer: JobCommentWriter | undefined): void {
    commentWriter = writer;
}

export function withJobContext<T>(context: JobContext, run: () => Promise<T>): Promise<T> {
    return storage.run(context, run);
}

export function getJobContext(): JobContext | undefined {
    return storage.getStore();
}

/** 写一条 agent 评论到当前任务卡；不在任务上下文里直接抛错。 */
export function writeJobComment(body: string): void {
    const context = getJobContext();
    if (!context) throw new Error("当前不在任务执行上下文中，无法写任务评论");
    if (!commentWriter) throw new Error("任务评论写入器未注册");
    commentWriter({ jobId: context.jobId, sessionId: context.sessionId, body });
}
