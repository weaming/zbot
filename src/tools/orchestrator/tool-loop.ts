/**
 * 工具批处理：执行一批工具调用并把结果落进本回合消息。
 *
 * 结果按调用顺序稳定入列。并行执行只影响耗时，不影响消息顺序，
 * 否则下一轮的请求前缀会随调度时序抖动，破坏前缀缓存。
 *
 * 调度规则由 tool-order.ts 决定：没写 `_order` 整批并发；写了就按该字段串行，
 * 相同值组内并行、组间串行；链上一旦失败，后续组与并发组都不再执行
 * （由调用方据此裁剪历史）。
 */

import type { ToolCall } from "../../types/tool-call.js";
import {
    compactJsonToolOutput,
    type ToolExecutionOutput,
    type ToolExecutionResponse,
} from "../tool-interface.js";
import type { UIEvent } from "../../events/ui-events.js";
import type { ChatMessage } from "../../types/session.js";
import { planToolExecution, stripToolOrder, type PlannedToolCall } from "./tool-order.js";

function normalizeToolExecutionOutput(output: ToolExecutionResponse): ToolExecutionOutput {
    return typeof output === "string" ? { content: output } : output;
}

export interface ToolLoopHost {
    executeTool?: (name: string, args: any) => Promise<ToolExecutionResponse>;
    onToolCall?: (name: string, args: any, mode: "serial" | "parallel") => void;
    onToolResult?: (name: string, result: string) => void;
    emit(event: UIEvent): void;
    /** 分配工具事件的展示 id（单调递增）。 */
    nextToolId(): number;
    /** 中止检查：工具执行前发现已中止则抛出。 */
    assertNotAborted(): void;
}

/** 单条调用的执行结果，带原下标以便调用方按原顺序入列与裁剪历史。 */
interface ProcessedToolCall {
    index: number;
    callId: string;
    message: ChatMessage;
    failed: boolean;
}

export interface ToolBatchOutcome {
    /** 按原下标升序排列，只含实际执行过的调用。 */
    results: ProcessedToolCall[];
    /** 实际执行过的调用下标集合；串行链失败时是它的真子集。 */
    executed: Set<number>;
    /** 串行链在某一环失败时的下标；全部成功或没有串行链时为 null。 */
    failedIndex: number | null;
}

/** 执行单个工具调用，只产出消息，不决定入列。 */
async function processToolCall(
    host: ToolLoopHost,
    planned: PlannedToolCall,
    mode: "serial" | "parallel",
): Promise<ProcessedToolCall> {
    const toolCall = planned.call;
    const args = stripToolOrder(toolCall.args);
    host.assertNotAborted();
    host.onToolCall?.(toolCall.name, args, mode);
    const toolId = host.nextToolId();
    host.emit({ type: "tool_start", toolId, callId: toolCall.id, name: toolCall.name, args, mode });
    const toolStartedAt = Date.now();

    let toolOutput = "";
    let toolFailed = false;
    let toolContextPolicy: ToolExecutionOutput["contextPolicy"];
    let toolImageContent: ToolExecutionOutput["imageContent"];
    let toolAudioContent: ToolExecutionOutput["audioContent"];

    if (host.executeTool) {
        try {
            const executionOutput = normalizeToolExecutionOutput(
                await host.executeTool(toolCall.name, args),
            );
            toolOutput = executionOutput.content;
            // 工具自报的失败（非零退出码等）与抛异常同等对待：
            // `_order` 串行链据此中止，tool_result 事件也据此标错。
            toolFailed = executionOutput.isError === true;
            toolContextPolicy = executionOutput.contextPolicy;
            toolImageContent = executionOutput.imageContent;
            toolAudioContent = executionOutput.audioContent;

            toolOutput = compactJsonToolOutput(toolOutput, toolCall.name);
        } catch (error: any) {
            if (error?.name === "AbortError") throw error;
            toolFailed = true;
            toolOutput = `Error: ${error.message}`;
        }
    } else {
        toolOutput = JSON.stringify({
            mock: true,
            tool: toolCall.name,
            args,
            timestamp: new Date().toISOString(),
        });
        toolOutput = compactJsonToolOutput(toolOutput, toolCall.name);
    }

    // 耗时随工具消息落盘（本地渲染元数据，上行前会被剥离），会话重开后仍能显示
    const durationMs = Date.now() - toolStartedAt;
    const toolMessage: ChatMessage = {
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.name,
        content: toolOutput,
        durationMs,
        ...(toolFailed ? { isError: true } : {}),
        ...(toolContextPolicy ? { contextPolicy: toolContextPolicy } : {}),
        ...(toolImageContent && toolImageContent.length > 0 ? { imageContent: toolImageContent } : {}),
        ...(toolAudioContent && toolAudioContent.length > 0 ? { audioContent: toolAudioContent } : {}),
    };

    host.onToolResult?.(toolCall.name, toolOutput);
    host.emit({
        type: "tool_result",
        toolId,
        callId: toolCall.id,
        name: toolCall.name,
        summary: toolOutput,
        isError: toolFailed,
        durationMs,
    });

    return { index: planned.index, callId: toolCall.id, message: toolMessage, failed: toolFailed };
}

/**
 * 执行一批工具调用并按 `_order` 编排。
 *
 * 并发只发生在「执行」阶段，返回结果按调用顺序排好：
 * 调用方据此保证「执行可以乱序，入列必须按原顺序」，让下一轮请求前缀稳定。
 */
export async function runToolBatch(host: ToolLoopHost, calls: ToolCall[]): Promise<ToolBatchOutcome> {
    const plan = planToolExecution(calls);
    const results: ProcessedToolCall[] = [];
    const executed = new Set<number>();
    let failedIndex: number | null = null;

    /** 跑一组调用：组内并发，结果并入汇总。返回首个失败项（若有）。 */
    const runConcurrently = async (
        stage: PlannedToolCall[],
        mode: "serial" | "parallel",
    ): Promise<ProcessedToolCall | undefined> => {
        // 组内并发意味着无法中途撤回：只要有失败，整组已完成的结果照样落地并上报，
        // 只有「之后的阶段」才会被跳过。
        const settled = await Promise.all(
            stage.map(planned => processToolCall(host, planned, mode)),
        );
        for (const result of settled) {
            results.push(result);
            executed.add(result.index);
        }
        return settled.find(result => result.failed);
    };

    if (plan.stages.length > 0) {
        for (const stage of plan.stages) {
            const failed = await runConcurrently(stage, "serial");
            if (failed) {
                failedIndex = failed.index;
                break;
            }
        }
        // 串行链失败即中止整批：并发组同样不执行
        if (failedIndex === null) await runConcurrently(plan.parallel, "parallel");
    } else {
        await runConcurrently(plan.parallel, "parallel");
    }

    results.sort((left, right) => left.index - right.index);
    return { results, executed, failedIndex };
}
