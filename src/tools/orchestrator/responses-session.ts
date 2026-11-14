import { getNetworkConfig } from "../../config/index.js";
import type OpenAI from "openai";
import { ResponsesWS } from "openai/resources/responses/ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { createHash } from "node:crypto";
import { recordLLMExchange } from "../../utils/logger.js";
import { isInternalHostname } from "../../utils/proxy.js";
import { buildResponsesContinuation, ResponsesBaselineStore, responsesIdentity, type ResponseBaseline } from "./responses-baseline.js";
import type { SteerUpdate } from "../../types/chat.js";
import {
  MAX_RETRY_ATTEMPTS,
  isRetryableNetworkError,
  networkBackoffDelay,
  reportNetworkFailure,
  reportNetworkSuccess,
  requireRetryPermit,
  retrySleep,
  withNetworkRetry,
  type RetryInfo,
} from "../../services/network-retry.js";

class WebSocketConnectError extends Error {}
class WebSocketReconnectError extends Error {}

function isPreviousResponseNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = error as { code?: string; error?: { code?: string } };
  return (details.code ?? details.error?.code) === "previous_response_not_found";
}

function isWebSocketConnectionLimit(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const details = error as { code?: string; error?: { code?: string } };
  return (details.code ?? details.error?.code) === "websocket_connection_limit_reached";
}

const MAX_CACHED_SESSIONS = 16;
/** 服务端单条 WS 连接硬上限 60 分钟：提前轮换，别把请求赌在临界点上。 */
const MAX_AGE_MS = 50 * 60 * 1000;
const MAX_BASELINE_BYTES = 2_000_000;
const STEER_TIMEOUT_MS = 120_000;

interface CachedSession {
  identity: string;
  session: ResponsesSession;
  isLeased: boolean;
}

interface PendingSteer {
  input: string;
  onAccepted?: () => void;
  responseId?: string;
  steerId?: string;
  isAccepted?: boolean;
  resolve(accepted: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, CachedSession>();

/** 会话关闭或转交时释放其连接。 */
export function closeResponsesSession(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  sessions.delete(sessionId);
  entry.session.close();
}

/** 将活跃会话中的新文本作为 Responses steering 输入提交。 */
export function steerResponsesSession(
  sessionId: string,
  input: string,
  onAccepted?: () => void,
): Promise<boolean> {
  return sessions.get(sessionId)?.session.steer(input, onAccepted) ?? Promise.resolve(false);
}

/** 按会话和连接配置复用空闲连接；连接常驻，超过存活上限或身份变化才重建。 */
export function acquireResponsesSession(
  client: OpenAI,
  hasApiKey: boolean,
  sessionId?: string,
): { session: ResponsesSession; release(): void } {
  const identity = createHash("sha256")
    .update(JSON.stringify([client.baseURL, client.apiKey, client.organization, client.project, getNetworkConfig().openaiProxy ?? ""]))
    .digest("hex");
  let entry = sessionId ? sessions.get(sessionId) : undefined;
  if (entry?.isLeased) entry = undefined;
  else if (entry && (entry.identity !== identity || entry.session.isExpired())) {
    entry.session.close();
    sessions.delete(sessionId!);
    entry = undefined;
  }
  if (entry) {
    entry.isLeased = true;
    entry.session.setIdle(false);
  } else {
    const baselineSessionId = sessionId && !sessions.has(sessionId) ? sessionId : undefined;
    entry = { identity, session: new ResponsesSession(client, hasApiKey, baselineSessionId), isLeased: true };
    if (sessionId && !sessions.has(sessionId)) {
      if (sessions.size >= MAX_CACHED_SESSIONS) {
        const oldest = [...sessions].find(([, cached]) => !cached.isLeased);
        if (oldest) {
          oldest[1].session.close();
          sessions.delete(oldest[0]);
        }
      }
      if (sessions.size < MAX_CACHED_SESSIONS) sessions.set(sessionId, entry);
    }
  }
  const leased = entry;
  let isReleased = false;
  return {
    session: leased.session,
    release() {
      if (isReleased) return;
      isReleased = true;
      if (!sessionId || sessions.get(sessionId) !== leased) {
        leased.session.close();
        return;
      }
      // 不按空闲时长回收：连接留到存活上限、身份变化或进程结束
      leased.isLeased = false;
      leased.session.setIdle(true);
    },
  };
}

/** 管理 Responses 会话的 HTTP、WebSocket 与增量续接。 */
export class ResponsesSession {
  private socket?: ResponsesWS;
  private baseline?: ResponseBaseline;
  private isBusy = false;
  private useHttp = false;
  private activeResponseId?: string;
  private pendingSteers: PendingSteer[] = [];
  private readonly baselineStore: ResponsesBaselineStore;

  private readonly createdAt = Date.now();

  constructor(private readonly client: OpenAI, private readonly hasApiKey: boolean, private readonly sessionId?: string) {
    this.baselineStore = new ResponsesBaselineStore(sessionId, responsesIdentity(client.baseURL, client.apiKey ?? "", client.organization, client.project));
  }

  /** 连接是否已超过存活上限（服务端 60 分钟硬限之前先轮换）。 */
  isExpired(now = Date.now()): boolean {
    return now - this.createdAt > MAX_AGE_MS;
  }

  /** 网络重试与熔断的维度：同一 provider 的 baseURL。 */
  private get retryKey(): string {
    return this.client.baseURL || "unknown";
  }

  private sendWs(socket: ResponsesWS, message: Record<string, any>): void {
    socket.send(message as any);
    // 请求创建与 HTTP 一样记为请求（走请求链增量），避免同一次请求既记 REQUEST 又记 WS_SEND；
    // 其余控制消息（steer/interrupt）保持原样。
    if (message.type === "response.create") {
      recordLLMExchange("REQUEST", message, { sessionId: this.sessionId });
    } else {
      recordLLMExchange("WS_SEND", message, { sessionId: this.sessionId });
    }
  }

  private logWsEvent(event: any): void {
    if (event.type === "message") {
      recordLLMExchange("WS_RECV", event.message, { sessionId: this.sessionId });
    } else if (event.type === "error") {
      recordLLMExchange("WS_ERROR", this.errorDetails(event.error), { sessionId: this.sessionId });
    }
  }

  private errorDetails(error: any): Record<string, unknown> {
    return { message: error?.message ?? String(error), ...(error?.status ? { status: error.status } : {}),
      ...(error?.code ? { code: error.code } : {}), ...(error?.error ? { error: error.error } : {}) };
  }

  private async loadBaseline(request: Record<string, any>): Promise<void> {
    if (request.store !== true) {
      if (this.baseline?.request.store === true) this.baseline = undefined;
      try {
        await this.baselineStore.clear();
      } catch (error) {
        console.warn("清理 Responses 续接基准失败:", error);
      }
      return;
    }
    if (!this.baseline && request.store === true) this.baseline = await this.baselineStore.load();
  }

  private makeBaseline(request: Record<string, any>, responseId: unknown, output: any[]): ResponseBaseline | undefined {
    if (request.previous_response_id !== undefined || typeof responseId !== "string" || !Array.isArray(request.input)) return undefined;
    if (Buffer.byteLength(JSON.stringify([request, output])) > MAX_BASELINE_BYTES) return undefined;
    return { request: structuredClone(request), responseId, output: structuredClone(output) };
  }

  private async saveBaseline(baseline: ResponseBaseline | undefined, request: Record<string, any>): Promise<void> {
    this.baseline = baseline;
    if (request.store !== true) return;
    try {
      if (baseline) await this.baselineStore.save(baseline);
      else await this.baselineStore.clear();
    } catch (error) {
      console.warn("保存 Responses 续接基准失败:", error);
    }
  }

  preconnect(): void {
    if (!this.useHttp) this.connect();
  }

  /** 在底层支持时释放空闲连接的进程引用。 */
  setIdle(isIdle: boolean): void {
    const platformSocket = this.socket?.socket.platformSocket as unknown as {
      _socket?: { ref(): void; unref(): void } | null;
    } | undefined;
    const stream = platformSocket?._socket;
    if (!stream) return;
    if (isIdle) stream.unref();
    else stream.ref();
  }

  close(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.baseline = undefined;
    this.activeResponseId = undefined;
    this.resolvePendingSteers(false);
    socket?.close();
  }

  steer(input: string, onAccepted?: () => void): Promise<boolean> {
    const text = input.trim();
    if (!text || !this.isBusy || this.useHttp || !this.socket) return Promise.resolve(false);

    return new Promise(resolve => {
      const steer: PendingSteer = {
        input: text,
        onAccepted,
        resolve,
        timer: setTimeout(() => this.finishSteer(steer, false), STEER_TIMEOUT_MS),
      };
      steer.timer.unref?.();
      this.pendingSteers.push(steer);
      if (this.activeResponseId) this.sendSteer(steer, this.activeResponseId);
    });
  }

  private sendSteer(steer: PendingSteer, responseId: string): void {
    if (steer.responseId || !this.socket) return;
    // 失败回执可能没有 steer ID；同一 parent 的请求串行发送才能可靠关联。
    if (this.pendingSteers.some(item => item !== steer && item.responseId === responseId)) return;
    steer.responseId = responseId;
    this.sendWs(this.socket, {
      type: "response.steer",
      previous_response_id: responseId,
      input: steer.input,
    });
  }

  private finishSteer(steer: PendingSteer, accepted: boolean): void {
    const index = this.pendingSteers.indexOf(steer);
    if (index < 0) return;
    this.pendingSteers.splice(index, 1);
    clearTimeout(steer.timer);
    if (accepted) steer.onAccepted?.();
    steer.resolve(accepted);
  }

  private resolvePendingSteers(accepted: boolean): void {
    for (const steer of [...this.pendingSteers]) this.finishSteer(steer, accepted);
  }

  private connect(): ResponsesWS {
    if (this.socket) return this.socket;
    const proxyUrl = getNetworkConfig().openaiProxy;
    const hostname = new URL(this.client.baseURL).hostname;
    const agent = proxyUrl && !isInternalHostname(hostname) ? new HttpsProxyAgent(proxyUrl) : undefined;
    const socket = new ResponsesWS(this.client, {
      headers: this.hasApiKey ? { "x-llm-caller": "zbot" } : { Authorization: "", "x-llm-caller": "zbot" },
      agent,
    });
    socket.on("error", error => {
      if (this.socket === socket && !this.isBusy) {
        console.warn(`Responses WebSocket 预连接失败: ${error.message}`);
        this.close();
      }
    });
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        if (this.baseline?.request.store !== true) this.baseline = undefined;
      }
    });
    this.socket = socket;
    return socket;
  }

  private async warmup(socket: ResponsesWS, request: Record<string, any>, signal?: AbortSignal): Promise<string | undefined> {
    if (this.baseline || request.previous_response_id !== undefined || !Array.isArray(request.input)) return;

    const events = socket.stream();
    this.sendWs(socket, { ...request, type: "response.create", generate: false });
    let isOpen = socket.socket.readyState === 1;
    const abort = () => socket.close();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
      for await (const event of events) {
        this.logWsEvent(event);
        if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        if (event.type === "open") {
          isOpen = true;
          continue;
        }
        if (event.type === "error") {
          if (!isOpen && !event.error.error) {
            throw new WebSocketConnectError("Responses WebSocket 握手失败", { cause: event.error });
          }
          if (isWebSocketConnectionLimit(event.error.error)) {
            throw new WebSocketReconnectError("Responses WebSocket 已达到连接时限", { cause: event.error });
          }
          throw event.error;
        }
        if (event.type === "close") {
          if (!isOpen) throw new WebSocketConnectError(`Responses WebSocket 握手失败: ${event.code} ${event.reason}`);
          throw new WebSocketReconnectError(`Responses WebSocket 预热时连接提前关闭: ${event.code} ${event.reason}`);
        }
        if (event.type !== "message") continue;

        const message: any = event.message;
        if (message.type === "response.completed") {
          const responseId = message.response?.id;
          if (typeof responseId !== "string") throw new Error("Responses WebSocket 预热未返回 response ID");
          return responseId;
        }
        if (message.type === "response.failed" || message.type === "response.incomplete" || message.type === "error") {
          throw new Error(`Responses WebSocket 预热失败: ${JSON.stringify(message)}`);
        }
      }

      if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
      throw new Error("Responses WebSocket 预热未收到完整响应");
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  private buildRequest(params: Record<string, any>): Record<string, any> {
    const request = { ...params };
    delete request.stream;
    delete request.background;
    return buildResponsesContinuation(request, this.baseline);
  }

  async *stream(
    params: Record<string, any>,
    signal?: AbortSignal,
    onSteerAccepted?: (input: string) => Promise<void>,
    onSteerUpdate?: (update: SteerUpdate) => Promise<void>,
  ): AsyncGenerator<any> {
    if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (this.isBusy) throw new Error("Responses WebSocket 正在处理另一请求");
    const fullRequest = { ...params };
    delete fullRequest.stream;
    delete fullRequest.background;
    const socket = this.connect();
    this.isBusy = true;
    this.activeResponseId = undefined;
    let responseId: string | undefined;
    let terminalResponseId: string | undefined;
    let expectedContinuation = false;
    let hasSteered = false;
    const steeredParentIds = new Set<string>();
    let interruptSent = false;
    let interruptAccepted = false;
    let isTerminal = false;
    let keepSocket = false;
    const sendInterrupt = () => {
      if (!responseId || interruptSent || isTerminal) return;
      interruptSent = true;
      this.sendWs(socket, {
        type: "response.interrupt",
        response_id: responseId,
        mode: "discard_partial_items",
      });
    };
    const abort = () => sendInterrupt();
    signal?.addEventListener("abort", abort, { once: true });
    let isCompleted = false;
    let isOpen = socket.socket.readyState === 1;
    let isStarted = false;
    let canRetryFull = false;
    const outputItems: any[] = [];
    const parentSnapshots = new Map<string, SteerUpdate>();
    let currentOutputText = "";
    const emitParentSegment = async (parentId: string | undefined, isAwaitingToolInput = false) => {
      if (!parentId) return;
      const snapshot = parentSnapshots.get(parentId);
      if (!snapshot) return;
      parentSnapshots.delete(parentId);
      await onSteerUpdate?.(isAwaitingToolInput ? { ...snapshot, isAwaitingToolInput } : snapshot);
    };

    try {
      await this.loadBaseline(fullRequest);
      const warmupId = await this.warmup(socket, fullRequest, signal);
      if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
      let request = this.buildRequest(params);
      if (warmupId) request = { ...request, previous_response_id: warmupId, input: [] };
      canRetryFull = request.previous_response_id !== undefined && params.previous_response_id === undefined;
      const events = socket.stream();
      this.sendWs(socket, { ...request, type: "response.create" });
      for await (const event of events) {
        this.logWsEvent(event);
        if (event.type === "open") { isOpen = true; continue; }
        if (event.type === "error") {
          const details = event.error.error as any;
          const code = details?.code ?? details?.error?.code;
          if (canRetryFull && !isStarted && code === "previous_response_not_found") {
            canRetryFull = false;
            await this.saveBaseline(undefined, fullRequest);
            this.sendWs(socket, { ...fullRequest, type: "response.create" });
            continue;
          }
          if (!isOpen && !details) throw new WebSocketConnectError("Responses WebSocket 握手失败", { cause: event.error });
          if (!isStarted && (isWebSocketConnectionLimit(details) || (isOpen && !details))) {
            throw new WebSocketReconnectError("Responses WebSocket 连接中断", { cause: event.error });
          }
          throw event.error;
        }
        if (event.type === "close") {
          if (!isOpen) throw new WebSocketConnectError(`Responses WebSocket 握手失败: ${event.code} ${event.reason}`);
          if (!isStarted && !signal?.aborted) throw new WebSocketReconnectError(`Responses WebSocket 连接提前关闭: ${event.code} ${event.reason}`);
          throw new Error(`Responses WebSocket 提前关闭: ${event.code} ${event.reason}`);
        }
        if (event.type !== "message") continue;
        const message: any = event.message;
        if (message.type === "response.created" && typeof message.response?.id === "string") {
          const previousResponseId = responseId;
          if (expectedContinuation && message.response.id !== previousResponseId) {
            expectedContinuation = false;
            isTerminal = false;
            await emitParentSegment(previousResponseId);
            const committed = this.pendingSteers.filter(item => item.responseId === previousResponseId && item.isAccepted);
            for (const steer of committed) {
              this.finishSteer(steer, true);
              await onSteerAccepted?.(steer.input);
            }
          }
          responseId = message.response.id;
          this.activeResponseId = message.response.id;
          currentOutputText = "";
          for (const steer of this.pendingSteers) this.sendSteer(steer, message.response.id);
          if (signal?.aborted) sendInterrupt();
        }
        if (message.type === "response.steer.accepted") {
          const targetId = message.steer?.previous_response_id;
          const steer = this.pendingSteers.find(item => item.responseId === targetId);
          if (steer && !steer.isAccepted) {
            hasSteered = true;
            expectedContinuation = true;
            steeredParentIds.add(targetId);
            steer.isAccepted = true;
            steer.steerId = message.steer?.id;
            await onSteerUpdate?.({ responseId: targetId, phase: "accepted" });
            if (terminalResponseId === targetId) {
              isTerminal = false;
              isCompleted = false;
            }
          }
        }
        if (message.type === "response.steer.failed") {
          const targetId = message.steer?.previous_response_id;
          const steer = this.pendingSteers.find(item => item.responseId === targetId
            && (!message.steer?.id || item.steerId === message.steer.id));
          if (steer) {
            this.finishSteer(steer, false);
            await onSteerUpdate?.({ responseId: targetId, phase: "failed" });
            if (steer.isAccepted) {
              steeredParentIds.delete(targetId);
              expectedContinuation = false;
            }
            const next = this.pendingSteers.find(item => !item.responseId);
            if (next && targetId === responseId && !isTerminal) this.sendSteer(next, targetId);
          }
          if (terminalResponseId === targetId && !this.pendingSteers.some(item => item.responseId === targetId)) {
            isTerminal = true;
          }
        }
        if (message.type === "response.interrupt.accepted" && message.response_id === responseId) {
          interruptAccepted = true;
        }
        if (message.type === "response.interrupt.failed" && message.response_id === responseId) {
          // 上游拒绝中断（例如响应带托管工具）：finally 关闭 socket 侧断上游，
          // 本轮按取消结束，用户看到的是「已取消」而不是请求失败。
          throw new DOMException("请求已取消", "AbortError");
        }
        if (typeof message.type === "string" && message.type.startsWith("response.")) isStarted = true;
        if (message.type === "response.output_text.delta" && typeof message.delta === "string") currentOutputText += message.delta;
        if (message.type === "response.output_text.done" && !currentOutputText && typeof message.text === "string") {
          currentOutputText = message.text;
        }
        if (message.type === "response.output_item.done") outputItems[message.output_index] = message.item;
        if ((message.type === "response.completed" || message.type === "response.incomplete")
          && typeof message.response?.id === "string") {
          const output = Array.isArray(message.response.output) ? message.response.output : outputItems.filter(Boolean);
          const outputText = output.flatMap((item: any) => item?.type === "message"
            ? (item.content ?? []).filter((part: any) => part?.type === "output_text").map((part: any) => part.text ?? "")
            : []).join("");
          const text = message.type === "response.incomplete"
            ? (currentOutputText || outputText)
            : (outputText || currentOutputText);
          parentSnapshots.set(message.response.id, {
            responseId: message.response.id,
            phase: message.type === "response.completed" ? "completed" : "steered",
            ...(text ? { text } : {}),
          });
        }
        if (message.type === "response.completed") {
          const response = message.response;
          terminalResponseId = response?.id;
          if (hasSteered && steeredParentIds.has(response?.id)) {
            await this.saveBaseline(undefined, fullRequest);
          } else {
            if (hasSteered) {
              await this.saveBaseline(undefined, fullRequest);
            } else {
              const output = Array.isArray(response?.output) && response.output.length ? response.output : outputItems.filter(Boolean);
              const baseline = this.makeBaseline(fullRequest, response?.id, output);
              await this.saveBaseline(baseline, fullRequest);
            }
            isCompleted = true;
          }
        }
        if (message.type === "response.completed" || message.type === "response.failed" || message.type === "response.incomplete") {
          const eventResponseId = message.response?.id;
          terminalResponseId = eventResponseId ?? terminalResponseId;
          const isSteeredParent = message.type !== "response.failed"
            && typeof eventResponseId === "string"
            && (steeredParentIds.has(eventResponseId)
              || this.pendingSteers.some(item => item.responseId === eventResponseId));
          isTerminal = !isSteeredParent;
        }
        if (message.type === "response.steer.pending") {
          // 客户端工具结果尚未提交：本轮结束时关闭当前 WS，下一请求用完整历史重放，
          // 不在新连接上依赖旧连接里排队的 steering 输入。
          await this.saveBaseline(undefined, fullRequest);
          await emitParentSegment(message.steer?.previous_response_id, true);
          const steer = this.pendingSteers.find(item => item.steerId === message.steer?.id && item.isAccepted);
          if (steer) {
            this.finishSteer(steer, true);
            await onSteerAccepted?.(steer.input);
          }
          isTerminal = true;
        }
        yield message;
        if (isTerminal && (!interruptSent || interruptAccepted)) {
          if (interruptAccepted) {
            await this.saveBaseline(undefined, fullRequest);
            keepSocket = true;
            throw new DOMException("请求已取消", "AbortError");
          }
          if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
          return;
        }
      }
      if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
      throw new Error("Responses WebSocket 未收到终态事件");
    } finally {
      signal?.removeEventListener("abort", abort);
      this.isBusy = false;
      this.activeResponseId = undefined;
      this.resolvePendingSteers(false);
      if (!isCompleted && !keepSocket) {
        const storedBaseline = fullRequest.store === true ? this.baseline : undefined;
        this.close();
        this.baseline = storedBaseline;
      }
    }
  }

  async create(
    params: Record<string, any>,
    signal?: AbortSignal,
    onSteerAccepted?: (input: string) => Promise<void>,
    useWebSocket = true,
    onSteerUpdate?: (update: SteerUpdate) => Promise<void>,
  ): Promise<any> {
    const events = this.streamWithFallback(params, signal, onSteerAccepted, useWebSocket, onSteerUpdate);
    if (params.stream) return events;
    for await (const event of events) {
      if (event.type === "response.completed") return event.response;
      if (event.type === "response.failed" || event.type === "response.incomplete") {
        throw new Error(`Responses 请求失败: ${event.type}`);
      }
    }
    throw new Error("Responses WebSocket 未收到完整响应");
  }

  private async *streamWithFallback(
    params: Record<string, any>,
    signal?: AbortSignal,
    onSteerAccepted?: (input: string) => Promise<void>,
    useWebSocket = true,
    onSteerUpdate?: (update: SteerUpdate) => Promise<void>,
  ): AsyncGenerator<any> {
    if (useWebSocket && !this.useHttp) {
      let canReconnect = true;
      let connectAttempts = 0;
      const key = this.retryKey;
      while (true) {
        try {
          yield* this.stream(params, signal, onSteerAccepted, onSteerUpdate);
          reportNetworkSuccess(key);
          return;
        } catch (error) {
          if (signal?.aborted) throw error;
          if (error instanceof WebSocketReconnectError && canReconnect) {
            canReconnect = false;
            continue;
          }
          if (!(error instanceof WebSocketConnectError)) throw error;
          // 只有网络类握手失败才值得重试；明确的协议拒绝（如 426）直接回退 HTTP
          const isNetworkFailure = isRetryableNetworkError(error) || isRetryableNetworkError((error as any).cause);
          if (isNetworkFailure && connectAttempts < MAX_RETRY_ATTEMPTS) {
            const delayMs = networkBackoffDelay(connectAttempts);
            connectAttempts += 1;
            this.logRetry("WS", { attempt: connectAttempts, delayMs, error });
            await retrySleep(delayMs, signal);
            continue;
          }
          if (isNetworkFailure) reportNetworkFailure(key);
          this.useHttp = true;
          break;
        }
      }
    }
    if (params.stream) {
      yield* this.streamHttp(params, signal);
    } else {
      yield { type: "response.completed", response: await this.createHttp(params, signal) };
    }
  }

  private async createHttp(params: Record<string, any>, signal?: AbortSignal): Promise<any> {
    if (this.isBusy) throw new Error("Responses 会话正在处理另一请求");
    this.isBusy = true;
    try {
      return await this.requestHttp(params, signal);
    } finally {
      this.isBusy = false;
    }
  }

  private async requestHttp(params: Record<string, any>, signal?: AbortSignal): Promise<any> {
    const fullRequest = { ...params };
    delete fullRequest.stream;
    await this.loadBaseline(fullRequest);
    const key = this.retryKey;

    const response = await withNetworkRetry(async () => {
      const request = fullRequest.store === true ? buildResponsesContinuation(fullRequest, this.baseline) : fullRequest;
      const canRetry = request.previous_response_id !== undefined && params.previous_response_id === undefined;
      try {
        recordLLMExchange("HTTP_REQUEST", { ...request, stream: false }, { sessionId: this.sessionId });
        return await this.client.responses.create({ ...request, stream: false } as any, { signal });
      } catch (error) {
        recordLLMExchange("HTTP_ERROR", this.errorDetails(error), { sessionId: this.sessionId });
        if (!canRetry || !isPreviousResponseNotFound(error)) throw error;
        await this.saveBaseline(undefined, fullRequest);
        recordLLMExchange("HTTP_REQUEST", { ...fullRequest, stream: false }, { sessionId: this.sessionId });
        try {
          return await this.client.responses.create({ ...fullRequest, stream: false } as any, { signal });
        } catch (retryError) {
          recordLLMExchange("HTTP_ERROR", this.errorDetails(retryError), { sessionId: this.sessionId });
          throw retryError;
        }
      }
    }, { key, signal, onRetry: info => this.logRetry("HTTP", info) });

    recordLLMExchange("HTTP_RESPONSE", response, { sessionId: this.sessionId });
    if (response?.status === "completed" || response?.status === undefined) {
      const baseline = Array.isArray(response?.output) ? this.makeBaseline(fullRequest, response?.id, response.output) : undefined;
      await this.saveBaseline(baseline, fullRequest);
    }
    return response;
  }

  private logRetry(transport: string, info: RetryInfo): void {
    const reason = (info.error as any)?.message ?? String(info.error);
    console.warn(`⚠️ [net] ${this.retryKey} ${transport} 第 ${info.attempt} 次重试（${info.delayMs}ms 后）：${reason}`);
  }

  private async *streamHttp(params: Record<string, any>, signal?: AbortSignal): AsyncGenerator<any> {
    if (this.isBusy) throw new Error("Responses 会话正在处理另一请求");
    this.isBusy = true;
    try {
      yield* this.streamHttpRequest(params, signal);
    } finally {
      this.isBusy = false;
    }
  }

  private async *streamHttpRequest(params: Record<string, any>, signal?: AbortSignal): AsyncGenerator<any> {
    const fullRequest = { ...params };
    delete fullRequest.stream;
    await this.loadBaseline(fullRequest);
    let request = fullRequest.store === true ? buildResponsesContinuation(fullRequest, this.baseline) : fullRequest;
    let canRetry = request.previous_response_id !== undefined && params.previous_response_id === undefined;
    const key = this.retryKey;
    // 熔断中就别再打上游
    requireRetryPermit(key);
    let networkAttempt = 0;
    let hasEmittedAny = false;

    while (true) {
      let hasEmitted = false;
      let shouldRetry = false;
      const outputItems: any[] = [];
      try {
        recordLLMExchange("HTTP_REQUEST", { ...request, stream: true }, { sessionId: this.sessionId });
        const stream = await this.client.responses.create({ ...request, stream: true } as any, { signal });
        for await (const event of stream as any) {
          recordLLMExchange("HTTP_SSE_EVENT", event, { sessionId: this.sessionId });
          if (canRetry && !hasEmitted && event.type === "error" && isPreviousResponseNotFound(event)) {
            shouldRetry = true;
            break;
          }
          if (event.type === "response.output_item.done" && event.item && event.output_index !== undefined) {
            outputItems[event.output_index] = event.item;
          }
          if (event.type === "response.completed") {
            const response = event.response;
            const output = Array.isArray(response?.output) && response.output.length ? response.output : outputItems.filter(Boolean);
            const baseline = this.makeBaseline(fullRequest, response?.id, output);
            await this.saveBaseline(baseline, fullRequest);
          }
          if (typeof event.type !== "string" || !event.type.startsWith("codex.")) hasEmitted = true;
          if (hasEmitted) hasEmittedAny = true;
          yield event;
        }
      } catch (error) {
        recordLLMExchange("HTTP_ERROR", this.errorDetails(error), { sessionId: this.sessionId });
        if (signal?.aborted) throw error;
        // 还没吐出任何事件的网络抖动：退避后重放同一请求（含 previous_response_id）
        if (!hasEmitted && !hasEmittedAny
          && isRetryableNetworkError(error)
          && networkAttempt < MAX_RETRY_ATTEMPTS) {
          const delayMs = networkBackoffDelay(networkAttempt);
          networkAttempt += 1;
          this.logRetry("SSE", { attempt: networkAttempt, delayMs, error });
          await retrySleep(delayMs, signal);
          continue;
        }
        if (isRetryableNetworkError(error)) reportNetworkFailure(key);
        if (!canRetry || hasEmitted || !isPreviousResponseNotFound(error)) throw error;
        shouldRetry = true;
      }
      if (!shouldRetry) {
        reportNetworkSuccess(key);
        return;
      }
      canRetry = false;
      await this.saveBaseline(undefined, fullRequest);
      request = fullRequest;
    }
  }
}
