/**
 * todo 工具：会话绑定的任务清单（整表覆盖语义）
 *
 * - 存储：sessions/todos/<sessionId>.json（sessionId 全局唯一）
 * - write 一次提交完整清单，服务端按顺序分配 id 并整表覆盖：幂等、无 update 轮次
 * - 每次调用都回显完整清单与进度，模型无需再 list 一轮
 * - 同会话操作通过 promise 链串行化，防止并发写入竞态
 */

import * as fs from "fs";
import path from "path";
import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
import { ok, err } from "./tool-interface.js";
import { getSessionTodosFile } from "../utils/runtime-paths.js";

type TodoStatus = "pending" | "in_progress" | "done";

export type TodoItem = {
    id: number;
    content: string;
    status: TodoStatus;
    /** 进行中时的展示文案（可选，用于 UI/进度条） */
    activeForm?: string;
    updatedAt: string;
};

/** 单个会话最多保留的任务数，防止模型灌爆文件 */
const MAX_TODO_ITEMS = 50;
/** 同时只允许一条进行中任务，强制线性推进 */
const MAX_IN_PROGRESS = 1;
/** 提醒注入的节流间隔：清单未变化时每 N 轮提示一次 */
const REMINDER_INTERVAL_ROUNDS = 2;
/** 提醒中最多列出的未完成任务数 */
const MAX_REMINDER_ITEMS = 5;
const VALID_STATUSES: TodoStatus[] = ["pending", "in_progress", "done"];

// 每个会话一条 promise 链，保证同会话操作串行执行
const sessionLocks = new Map<string, Promise<unknown>>();

// 读缓存：按 mtime+size 命中，避免 TUI 高频渲染时反复读盘
const readCache = new Map<string, { mtimeMs: number; size: number; todos: TodoItem[] }>();
/** 读缓存条目上限，超出时淘汰最早写入的会话 */
const READ_CACHE_LIMIT = 50;

function cacheTodos(filePath: string, mtimeMs: number, size: number, todos: TodoItem[]): void {
    readCache.delete(filePath);
    readCache.set(filePath, { mtimeMs, size, todos });
    if (readCache.size > READ_CACHE_LIMIT) {
        const oldest = readCache.keys().next().value;
        if (oldest !== undefined) readCache.delete(oldest);
    }
}

function getTodoFilePath(sessionId: string): string {
    return getSessionTodosFile(sessionId);
}

function isTodoItem(value: any): value is TodoItem {
    return typeof value?.id === "number"
        && typeof value.content === "string"
        && VALID_STATUSES.includes(value.status);
}

/** 同一会话的操作排队执行：前一个完成（或失败）后再启动下一个 */
async function withSessionLock<T>(sessionKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = sessionLocks.get(sessionKey) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const tracked = next.catch(() => {});
    sessionLocks.set(sessionKey, tracked);
    try {
        return await next;
    } finally {
        if (sessionLocks.get(sessionKey) === tracked) {
            sessionLocks.delete(sessionKey);
        }
    }
}

function loadTodos(filePath: string): TodoItem[] {
    try {
        const stat = fs.statSync(filePath);
        const cached = readCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
            return cached.todos;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const todos = Array.isArray(parsed) ? parsed.filter(isTodoItem) : [];
        cacheTodos(filePath, stat.mtimeMs, stat.size, todos);
        return todos;
    } catch {
        readCache.delete(filePath);
        return [];
    }
}

function atomicSave(filePath: string, todos: TodoItem[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(todos, null, 2), "utf-8");
    fs.renameSync(tempPath, filePath);
    try {
        const stat = fs.statSync(filePath);
        cacheTodos(filePath, stat.mtimeMs, stat.size, todos);
    } catch {
        readCache.delete(filePath);
    }
}

/** 清单回显：进度头 + 逐条 `[id] [status] content`，一次调用即可看到全貌。 */
function formatTodoList(todos: TodoItem[]): string {
    if (todos.length === 0) return "任务清单为空";
    const doneCount = todos.filter((item) => item.status === "done").length;
    const running = todos.find((item) => item.status === "in_progress");
    const header = [
        `${doneCount}/${todos.length} 完成`,
        running ? `进行中 #${running.id} ${running.content}` : "",
    ].filter(Boolean).join(" · ");
    const lines = todos.map((item) => `[${item.id}] [${item.status}] ${item.content}`);
    return [header, ...lines].join("\n");
}

/** 读取会话清单进度，供 TUI 状态栏与提醒注入使用；无任务时返回 undefined。 */
export function readTodoProgress(sessionId: string | undefined): { total: number; done: number } | undefined {
    if (!sessionId) return undefined;
    const todos = loadTodos(getTodoFilePath(sessionId));
    if (todos.length === 0) return undefined;
    return { total: todos.length, done: todos.filter((item) => item.status === "done").length };
}

/** 读取会话完整清单，供 TUI 面板等只读消费。 */
export function readSessionTodos(sessionId: string | undefined): TodoItem[] {
    if (!sessionId) return [];
    return loadTodos(getTodoFilePath(sessionId));
}

function truncateText(text: string, limit: number): string {
    return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** 未完成任务的一句话提醒（仅请求注入，不落盘）。 */
function formatTodoReminder(unfinished: TodoItem[]): string {
    const shown = unfinished.slice(0, MAX_REMINDER_ITEMS);
    const items = shown.map((item) => `#${item.id} [${item.status}] ${truncateText(item.content, 60)}`).join("；");
    const more = unfinished.length > shown.length ? `；等共 ${unfinished.length} 项` : "";
    return `<todo_reminder>未完成 ${unfinished.length} 项：${items}${more}。任务状态变化时及时用 todo write 更新清单。</todo_reminder>`;
}

/**
 * 每轮请求前调用：有未完成任务时返回一条提醒。
 * 清单变化立即提示，否则每 REMINDER_INTERVAL_ROUNDS 轮提示一次，避免刷屏与浪费 token。
 */
export function createTodoReminderProvider(sessionId: string): () => string[] | undefined {
    let lastSignature = "";
    let roundsSinceInject = Number.POSITIVE_INFINITY;

    return () => {
        const unfinished = loadTodos(getTodoFilePath(sessionId)).filter((item) => item.status !== "done");
        if (unfinished.length === 0) return undefined;

        roundsSinceInject += 1;
        const signature = JSON.stringify(unfinished.map((item) => [item.id, item.status, item.content]));
        if (signature === lastSignature && roundsSinceInject < REMINDER_INTERVAL_ROUNDS) {
            return undefined;
        }

        lastSignature = signature;
        roundsSinceInject = 0;
        return [formatTodoReminder(unfinished)];
    };
}

async function executeTodo(
    args: {
        action?: string;
        todos?: Array<{ content?: string; status?: string; activeForm?: string }>;
        __sessionId?: string;
    },
): Promise<ToolExecutionResult> {
    const action = args.action;
    if (!action) return err("Missing required argument: action");

    const sessionId = args.__sessionId;
    if (!sessionId) return err("todo 需要会话上下文（缺少 __sessionId），请在会话内调用");
    const filePath = getTodoFilePath(sessionId);

    return withSessionLock(sessionId, async () => {
        const todos = loadTodos(filePath);

        switch (action) {
            case "write": {
                const incoming = args.todos;
                if (!Array.isArray(incoming)) {
                    return err("write 需要 todos 数组：todos: [{content, status}]（按顺序整表覆盖）");
                }
                if (incoming.length > MAX_TODO_ITEMS) {
                    return err(`任务数上限 ${MAX_TODO_ITEMS}，当前 ${incoming.length} 条`);
                }

                const next: TodoItem[] = [];
                for (const [index, raw] of incoming.entries()) {
                    const content = typeof raw?.content === "string" ? raw.content.trim() : "";
                    if (!content) return err(`第 ${index + 1} 项缺少 content`);
                    const status = raw?.status ?? "pending";
                    if (!VALID_STATUSES.includes(status as TodoStatus)) {
                        return err(`第 ${index + 1} 项 status 无效：${raw?.status}（可选 ${VALID_STATUSES.join(" / ")}）`);
                    }
                    const activeForm = typeof raw?.activeForm === "string" && raw.activeForm.trim()
                        ? raw.activeForm.trim()
                        : undefined;
                    const previous = todos[index];
                    const isUnchanged = previous
                        && previous.content === content
                        && previous.status === status
                        && previous.activeForm === activeForm;
                    next.push({
                        id: index + 1,
                        content,
                        status: status as TodoStatus,
                        ...(activeForm ? { activeForm } : {}),
                        updatedAt: isUnchanged ? previous.updatedAt : new Date().toISOString(),
                    });
                }

                const running = next.filter((item) => item.status === "in_progress");
                if (running.length > MAX_IN_PROGRESS) {
                    const detail = running.map((item) => `#${item.id} ${item.content}`).join("；");
                    return err(`最多只能有 ${MAX_IN_PROGRESS} 条 in_progress，当前 ${running.length} 条：${detail}。请先完成或降级其他任务。`);
                }

                atomicSave(filePath, next);
                return ok(formatTodoList(next));
            }

            case "list": {
                return ok(formatTodoList(todos));
            }

            case "clear": {
                atomicSave(filePath, []);
                return ok("任务清单已清空");
            }

            default: {
                return err(`Invalid action: ${action}. Valid: write, list, clear`);
            }
        }
    });
}

const todoSchema = {
    type: "object",
    properties: {
        action: {
            type: "string",
            enum: ["write", "list", "clear"],
            description: "write: 整表覆盖（推荐，一次同步全部任务与状态）| list: 查看当前清单 | clear: 清空清单",
        },
        todos: {
            type: "array",
            description: "write 用：完整任务清单，按顺序覆盖旧内容（未列出的任务视为删除）",
            items: {
                type: "object",
                properties: {
                    content: { type: "string", description: "任务内容（简短、可验证）" },
                    status: { type: "string", enum: VALID_STATUSES, description: "任务状态：pending 待办 / in_progress 进行中 / done 完成" },
                    activeForm: { type: "string", description: "进行中时的展示文案（可选）" },
                },
                required: ["content", "status"],
            },
        },
    },
    required: ["action"],
};

export const todoTool: ExecutableTool = {
    name: "todo",
    description: "仅供复杂、长周期或需跨多轮推进的任务使用；简单任务、步骤少且几次工具调用/对话往返即可完成时不要调用。复杂任务先 write 建立完整清单，执行中保持同时只有 1 条 in_progress，并随任务状态变化及时更新。write 整表覆盖 | list | clear",
    tags: ["core"],
    inputSchema: todoSchema,
    execute: executeTodo,
};
