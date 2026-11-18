import type {
  ResponsesClientEvent as OpenAIResponsesClientEvent,
  ResponsesServerEvent as OpenAIResponsesServerEvent,
} from "openai/resources/responses/responses";
import type { ResponsesStreamMessage } from "openai/resources/responses/internal-base";

type ResponseInterruptClientEvent = {
  type: "response.interrupt";
  response_id: string;
};

type ResponsesClientEvent =
  | OpenAIResponsesClientEvent
  | ResponseInterruptClientEvent;

interface ResponseInterruptAcceptedEvent {
  type: "response.interrupt.accepted";
  response_id: string;
  sequence_number?: number;
}

interface ResponseInterruptFailedEvent {
  type: "response.interrupt.failed";
  response_id: string;
  sequence_number?: number;
  error?: {
    code?: string;
    message?: string;
    param?: string | null;
  };
}

/** Codex 上游返回的账户限额快照。 */
interface CodexRateLimitsEvent {
  type: "codex.rate_limits";
  rate_limits?: unknown;
  code_review_rate_limits?: unknown;
}

interface ResponseToolSearchCallInProgressEvent {
  type: "response.tool_search_call.in_progress";
  item_id: string;
  output_index: number;
  sequence_number: number;
}

interface ResponseToolSearchCallSearchingEvent {
  type: "response.tool_search_call.searching";
  item_id: string;
  output_index: number;
  sequence_number: number;
}

interface ResponseToolSearchCallCompletedEvent {
  type: "response.tool_search_call.completed";
  item_id: string;
  output_index: number;
  sequence_number: number;
}

export type ResponsesServerEvent =
  | OpenAIResponsesServerEvent
  | CodexRateLimitsEvent
  | ResponseInterruptAcceptedEvent
  | ResponseInterruptFailedEvent
  | ResponseToolSearchCallInProgressEvent
  | ResponseToolSearchCallSearchingEvent
  | ResponseToolSearchCallCompletedEvent;

/** OpenAI 云端网页搜索事件。 */
type OpenAIWebSearchEvent = Extract<ResponsesServerEvent, {
  type:
    | "response.web_search_call.completed"
    | "response.web_search_call.in_progress"
    | "response.web_search_call.searching";
}>;

/** OpenAI 云端文件搜索事件。 */
type OpenAIFileSearchEvent = Extract<ResponsesServerEvent, {
  type:
    | "response.file_search_call.completed"
    | "response.file_search_call.in_progress"
    | "response.file_search_call.searching";
}>;

/** OpenAI 云端代码解释器事件。 */
type OpenAICodeInterpreterEvent = Extract<ResponsesServerEvent, {
  type:
    | "response.code_interpreter_call_code.delta"
    | "response.code_interpreter_call_code.done"
    | "response.code_interpreter_call.completed"
    | "response.code_interpreter_call.in_progress"
    | "response.code_interpreter_call.interpreting";
}>;

/** OpenAI 云端图像生成事件。 */
type OpenAIImageGenerationEvent = Extract<ResponsesServerEvent, {
  type:
    | "response.image_generation_call.completed"
    | "response.image_generation_call.generating"
    | "response.image_generation_call.in_progress"
    | "response.image_generation_call.partial_image";
}>;

/** OpenAI 云端工具搜索事件。 */
type OpenAIToolSearchEvent = Extract<ResponsesServerEvent, {
  type:
    | "response.tool_search_call.in_progress"
    | "response.tool_search_call.searching"
    | "response.tool_search_call.completed";
}>;

/** OpenAI 云端托管工具调用事件；不包含由客户端执行的 function/custom tool。 */
type OpenAIHostedToolCallEvent =
  | OpenAIWebSearchEvent
  | OpenAIFileSearchEvent
  | OpenAICodeInterpreterEvent
  | OpenAIImageGenerationEvent
  | OpenAIToolSearchEvent;

type ResponsesWebSocketMessage =
  | Exclude<ResponsesStreamMessage, { type: "message" }>
  | { type: "message"; message: ResponsesServerEvent };
