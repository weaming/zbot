/**
 * shell 工具：在当前会话目录执行 shell 命令
 */

import * as fs from "fs";
import type { ExecutableTool, ToolExecutionResult } from "./tool-interface.js";
import { err } from "./tool-interface.js";
import { resolveExistingDir, type ResolvedDir } from "./cwd-tool.js";
import { backgroundTaskManager, type BackgroundTaskSummary } from "./background-tasks.js";
import { buildExecutionEnv } from "../utils/skill-env.js";
import { PROXY_URL } from "../utils/proxy.js";
import { getToolCwd } from "../utils/runtime-paths.js";

const DEFAULT_COMMAND_TIMEOUT_SECONDS = 120;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 3600;
const SHELL_PATH = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

const LOCAL_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^::1$/,
  /^0\.0\.0\.0$/,
  /\.local$/,
];

function isLocalHost(command: string): boolean {
  return LOCAL_HOST_PATTERNS.some((pattern) => pattern.test(command.trim()));
}

function shouldEnableProxy(command: string, enableProxy: boolean): boolean {
  if (!enableProxy) return false;
  if (isLocalHost(command)) return false;
  return true;
}

function resolveTimeoutSeconds(timeout?: number): number {
  if (typeof timeout !== "number" || Number.isNaN(timeout)) {
    return DEFAULT_COMMAND_TIMEOUT_SECONDS;
  }
  return Math.max(MIN_TIMEOUT_SECONDS, Math.min(MAX_TIMEOUT_SECONDS, Math.round(timeout)));
}

/**
 * 解析命令工作目录：cwd 必填，支持 ~（HOME）、相对会话目录的路径与绝对路径，
 * 目标必须是已存在的目录，否则直接报错而不是静默换个目录执行。
 */
function resolveShellCwd(input: unknown): ResolvedDir {
  if (typeof input !== "string" || input.trim() === "") {
    return { error: `缺少 cwd：shell 命令必须指定工作目录，支持 ~（HOME）、相对会话目录的路径与绝对路径，例如 {"cwd":"~"}` };
  }
  return resolveExistingDir(input, getExistingBaseCwd());
}

/** 会话目录可能已被删除（换机器、清理临时目录）：回退进程目录，避免所有命令整体失效。 */
function getExistingBaseCwd(): string {
  const toolCwd = getToolCwd();
  return fs.existsSync(toolCwd) ? toolCwd : process.cwd();
}

interface ShellRunOptions {
  command: string;
  cwd: string;
  enableProxy?: boolean;
  extraEnvs?: Record<string, string>;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  sessionId?: string;
  autoBackgroundOnTimeout?: boolean;
}

async function executeLocal(options: ShellRunOptions): Promise<string> {
  const {
    command,
    cwd,
    enableProxy = true,
    extraEnvs,
    signal,
    timeoutSeconds = DEFAULT_COMMAND_TIMEOUT_SECONDS,
    sessionId,
    autoBackgroundOnTimeout = false,
  } = options;

  if (signal?.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  const env = buildExecutionEnv();

  // 子进程里的 `zbot session …` 需要知道「我属于哪个会话」，才能拒绝把消息发给自己
  if (sessionId) env.ZBOT_SESSION_ID = sessionId;
  else delete env.ZBOT_SESSION_ID;

  if (shouldEnableProxy(command, enableProxy) && PROXY_URL) {
    env.HTTP_PROXY = PROXY_URL;
    env.HTTPS_PROXY = PROXY_URL;
    env.http_proxy = PROXY_URL;
    env.https_proxy = PROXY_URL;
  }

  if (extraEnvs) {
    Object.assign(env, extraEnvs);
  }

  const handle = backgroundTaskManager.startShell({
    command,
    cwd,
    env,
    shellPath: SHELL_PATH,
    sessionId,
    timeoutSeconds,
    autoBackgroundOnTimeout,
    signal,
  });
  const result = await handle.promise;

  if (result.kind === "detached") {
    return formatDetachedTask(result.task);
  }
  if (result.kind === "aborted") {
    throw new DOMException("The operation was aborted", "AbortError");
  }
  if (result.kind === "timed_out") {
    throw new Error(formatTimeoutError(result.stdout, result.stderr, timeoutSeconds));
  }

  const stdout = result.stdout;
  const stderr = result.stderr;
  if (stderr.trim()) {
    console.warn(`[${SHELL_PATH}] stderr: ${stderr.trim()}`);
  }

  if (result.exitCode !== 0) {
    const exitDesc = result.exitCode !== null ? `exit code ${result.exitCode}` : `signal ${result.signalName}`;
    const detail = stderr.trim() || stdout.trim();
    throw new Error(detail ? `Command failed with ${exitDesc}: ${detail}` : `Command failed with ${exitDesc}`);
  }

  return stdout.trim();
}

function formatTimeoutError(stdout: string, stderr: string, timeoutSeconds: number): string {
  let message = `Command execution timed out after ${timeoutSeconds}s and was terminated.`;
  const partialStdout = stdout.trim();
  const partialStderr = stderr.trim();
  if (partialStdout) message += `\n\n[Partial stdout]:\n${partialStdout}`;
  if (partialStderr) message += `\n\n[Partial stderr]:\n${partialStderr}`;
  message += `\n\n[Suggestion]: If this command is expected to take longer, pass a larger \`timeout\` parameter (e.g., timeout: ${Math.min(timeoutSeconds * 2, MAX_TIMEOUT_SECONDS)}). If it is waiting for interactive input, provide non-interactive flags (e.g., -y, --yes) or pipe input into the command.`;
  return message;
}

function formatDetachedTask(task: BackgroundTaskSummary): string {
  return JSON.stringify({
    background: true,
    task_id: task.id,
    status: task.status,
    command: task.command,
    reason: task.reason,
    message: `命令已放入后台。使用 background_task 查询 ${task.id} 的状态、等待完成或终止。`,
  });
}

export const executeShellTool: ExecutableTool = {
  name: "bash",
  description: "Execute a shell command inside the container (where zbot runs). Uses /bin/bash when available, otherwise /bin/sh. `cwd` is required: it accepts ~ for HOME, a path relative to the current session cwd (see the cwd tool), or an absolute path, and must be an existing directory. The default 120-second timeout moves long-running commands to the background; use background_task to inspect or stop them.",
  tags: ["core", "code"],
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute inside the container",
      },
      cwd: {
        type: "string",
        description: "命令的工作目录：支持 ~（HOME）、相对会话目录的路径与绝对路径，必须是已存在的目录",
      },
      enable_proxy: {
        type: "boolean",
        description: "是否启用代理（默认 true）。本地连接或中国可访问的服务建议设为 false",
        default: true,
      },
      envs: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "额外的环境变量，会合并到当前环境变量中",
      },
      timeout: {
        type: "integer",
        description: "命令执行超时时间（秒），默认 120 秒，取值范围 1~3600。显式传入时超时会终止进程组；省略时超时会将命令放入后台",
        minimum: 1,
        maximum: 3600,
        default: 120,
      },
    },
    required: ["command", "cwd"],
  },
  execute: async (
    args: { command: string; cwd: string; enable_proxy?: boolean; envs?: Record<string, string>; timeout?: number; __sessionId?: string },
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult> => {
    const { command, cwd, enable_proxy = true, envs, timeout, __sessionId } = args;

    const resolvedCwd = resolveShellCwd(cwd);
    if ("error" in resolvedCwd) {
      return err(resolvedCwd.error);
    }

    const timeoutSec = resolveTimeoutSeconds(timeout);
    const autoBackgroundOnTimeout = typeof timeout !== "number" || Number.isNaN(timeout);

    try {
      const result = await executeLocal({
        command,
        cwd: resolvedCwd.cwd,
        enableProxy: enable_proxy,
        extraEnvs: envs,
        signal,
        timeoutSeconds: timeoutSec,
        sessionId: __sessionId,
        autoBackgroundOnTimeout,
      });
      return {
        content: [{ type: "text", text: result }],
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Command failed: ${err.message}` }],
        isError: true,
      };
    }
  },
};
