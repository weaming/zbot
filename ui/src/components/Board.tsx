/**
 * 看板：列 = 状态分组，跨列拖拽 = 改状态（语义由后端 move 接口决定）。
 *
 * 只用 dnd-kit 的 core（draggable + droppable）：列内排序没有持久化字段，
 * 与其做一个刷新就丢的假排序，不如先不做。
 */

import {
    DndContext,
    DragOverlay,
    PointerSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent,
} from "@dnd-kit/core";
import { useState } from "react";
import type { BoardColumnKey, Job } from "../lib/types";
import { cn } from "../lib/utils";

interface ColumnDef {
    key: BoardColumnKey;
    title: string;
    /** 组内判定：多数列与 state 一比一，只有 doing 合并了 leased/running */
    match: (job: Job) => boolean;
    droppable: boolean;
}

/**
 * 卡片所在列：以用户拖拽结果（input.column）为准，老卡片没有该字段时按状态兜底。
 * 兜底只影响首次显示——列一旦被拖动过，任务跑完也不会自己跳列。
 */
function columnOf(job: Job): BoardColumnKey {
    if (job.input.column) return job.input.column;
    switch (job.state) {
        case "queued":
            return "todo";
        case "leased":
        case "running":
            return "doing";
        case "succeeded":
            return "done";
        case "cancelled":
            return "cancelled";
        default:
            // failed / lost：没有对应列，落到待办等人工处理
            return "todo";
    }
}

export const COLUMNS: ColumnDef[] = [
    { key: "todo", title: "待办", match: job => columnOf(job) === "todo", droppable: true },
    { key: "doing", title: "进行中", match: job => columnOf(job) === "doing", droppable: true },
    { key: "done", title: "已完成", match: job => columnOf(job) === "done", droppable: true },
    { key: "cancelled", title: "已取消", match: job => columnOf(job) === "cancelled", droppable: true },
];

function jobTitle(job: Job): string {
    return job.input.title || job.input.prompt;
}

function CardBody({ job }: { job: Job }) {
    const labels = job.input.labels ?? [];
    return (
        <>
            <div className="text-sm leading-snug break-words">{jobTitle(job)}</div>
            {labels.length > 0 && (
                <div className="flex flex-wrap gap-1">
                    {labels.map(label => (
                        <span key={label} className="rounded-full bg-col px-2 py-0.5 text-xs text-muted">
                            {label}
                        </span>
                    ))}
                </div>
            )}
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                {job.input.archivedAt && <span>已归档</span>}
                {job.attempts > 0 && <span>×{job.attempts}</span>}
                <span className="font-mono">{job.id.slice(-6)}</span>
            </div>
        </>
    );
}

function DraggableCard({
    job,
    selected,
    focused,
    onSelect,
}: {
    job: Job;
    selected: boolean;
    /** 键盘焦点（Enter 打开）；与「详情已打开」是两件事 */
    focused: boolean;
    onSelect: () => void;
}) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: job.id, data: { job } });

    return (
        <article
            ref={setNodeRef}
            {...attributes}
            {...listeners}
            onClick={onSelect}
            className={cn(
                // touch-none：移动端拖动卡片时不要连带滚动看板
                "flex touch-none cursor-grab flex-col gap-1.5 rounded-lg border border-border bg-panel p-2.5 active:cursor-grabbing",
                // 选中用内缩 outline 而不是 1px 边框变色：1px 在圆角处会被抗锯齿磨断，
                // 看起来像"边框缺了一截"；outline 不占布局，也压不住列间距
                selected && "bg-accent/5 outline-2 outline-accent -outline-offset-2",
                focused && !selected && "outline-2 outline-accent/60 -outline-offset-2",
                isDragging && "dragging",
                job.input.archivedAt && "opacity-60",
            )}
        >
            <CardBody job={job} />
        </article>
    );
}

function Column({
    column,
    jobs,
    selectedId,
    focusId,
    onSelect,
}: {
    column: ColumnDef;
    jobs: Job[];
    selectedId: string | null;
    focusId: string | null;
    onSelect: (id: string) => void;
}) {
    const { setNodeRef, isOver } = useDroppable({ id: column.key, disabled: !column.droppable });

    return (
        <section
            ref={setNodeRef}
            className={cn(
                // 移动端一列占大半屏并支持横滑吸附，md 以上恢复固定列宽
                "flex h-full w-[85vw] max-w-[320px] shrink-0 snap-start flex-col gap-2 rounded-xl bg-col p-2 md:w-[280px]",
                isOver && "outline-2 outline-dashed outline-accent -outline-offset-2",
            )}
        >
            <header className="flex items-center gap-2 px-1 pt-1">
                <h3 className="text-sm font-semibold">{column.title}</h3>
                <span className="text-xs text-muted">{jobs.length}</span>
            </header>
            <div className="stable-scroll flex min-h-[40px] flex-1 flex-col gap-2 overflow-y-auto">
                {jobs.map(job => (
                    <DraggableCard
                        key={job.id}
                        job={job}
                        selected={job.id === selectedId}
                        focused={job.id === focusId}
                        onSelect={() => onSelect(job.id)}
                    />
                ))}
            </div>
        </section>
    );
}

export function Board({
    jobs,
    selectedId,
    focusId,
    onSelect,
    onMove,
}: {
    jobs: Job[];
    selectedId: string | null;
    focusId: string | null;
    onSelect: (id: string) => void;
    onMove: (id: string, column: BoardColumnKey) => void;
}) {
    const [activeJob, setActiveJob] = useState<Job | null>(null);
    // 指针移动 4px 才起拖，避免点击卡片被误判成拖拽
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

    const handleDragStart = (event: DragStartEvent) => {
        const job = jobs.find(item => item.id === event.active.id);
        setActiveJob(job ?? null);
    };

    const handleDragEnd = (event: DragEndEvent) => {
        setActiveJob(null);
        const target = event.over?.id;
        if (typeof target !== "string") return;
        const job = jobs.find(item => item.id === event.active.id);
        if (!job) return;
        // 拖回原列不发请求：避免无意义的状态迁移
        const current = COLUMNS.find(column => column.match(job));
        if (current?.key === target) return;
        onMove(job.id, target as BoardColumnKey);
    };

    return (
        <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
            <div className="flex h-full snap-x snap-mandatory items-stretch gap-3 overflow-x-auto p-3 md:snap-none">
                {COLUMNS.map(column => (
                    <Column
                        key={column.key}
                        column={column}
                        jobs={jobs.filter(column.match)}
                        selectedId={selectedId}
                        focusId={focusId}
                        onSelect={onSelect}
                    />
                ))}
            </div>
            <DragOverlay>
                {activeJob ? (
                    <article className="flex w-[80vw] max-w-[300px] flex-col gap-1.5 rounded-lg border border-accent bg-panel p-2.5 shadow-lg md:w-[264px]">
                        <CardBody job={activeJob} />
                    </article>
                ) : null}
            </DragOverlay>
        </DndContext>
    );
}
