import fs from "fs";
import path from "path";
import { eastAsianWidth } from "get-east-asian-width";
import * as yaml from "js-yaml";

import {
    DEFAULT_TUI_MCP_CONFIG_FILE,
    normalizeParsedConfig,
    resolvePathWithTilde,
    type McpServerConfig,
} from "./config.js";
import { MCP_CLI_USAGE } from "./help.js";
import { getMcpConfig } from "../config/index.js";

interface McpCliOptions {
    configPath?: string;
}

interface McpAddOptions {
    name: string;
    url?: string;
    command?: string[];
    env: Record<string, string>;
    headers: Record<string, string>;
    cwd?: string;
}

function writeOutput(text: string): void {
    process.stdout.write(`${text}\n`);
}

function getConfigPath(): string {
    const configuredPath = getMcpConfig().serversFile;
    return configuredPath ? resolvePathWithTilde(configuredPath) : DEFAULT_TUI_MCP_CONFIG_FILE;
}

function readConfig(configPath: string): { root: Record<string, unknown>; servers: McpServerConfig[] } {
    if (!fs.existsSync(configPath)) return { root: {}, servers: [] };

    const parsed = yaml.load(fs.readFileSync(configPath, "utf-8"));
    if (parsed === undefined || parsed === null) return { root: {}, servers: [] };
    if (Array.isArray(parsed)) {
        return { root: {}, servers: normalizeParsedConfig(parsed) };
    }
    if (typeof parsed !== "object") {
        throw new Error(`MCP 配置根节点必须是对象：${configPath}`);
    }

    return { root: parsed as Record<string, unknown>, servers: normalizeParsedConfig(parsed) };
}

function writeConfig(configPath: string, root: Record<string, unknown>, servers: McpServerConfig[]): void {
    const mcpServers: Record<string, Omit<McpServerConfig, "name">> = {};
    for (const server of servers) {
        const { name, ...config } = server;
        mcpServers[name] = config;
    }

    const nextRoot: Record<string, unknown> = { ...root, mcpServers };
    delete nextRoot["servers"];
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, yaml.dump(nextRoot, { lineWidth: 120 }), { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
}

function parsePair(value: string, flag: string): [string, string] {
    const separator = value.indexOf("=");
    if (separator < 1) throw new Error(`${flag} 格式应为 KEY=VALUE`);
    return [value.slice(0, separator), value.slice(separator + 1)];
}

function parseAddArgs(args: string[]): McpAddOptions {
    const name = args.shift();
    if (!name || name.startsWith("-")) throw new Error("用法：zbot mcp add <名称> (--url <URL> | -- <命令> [参数...])");

    const options: McpAddOptions = { name, env: {}, headers: {} };
    let commandSeparator = -1;
    for (let index = 0; index < args.length; index++) {
        if (args[index] === "--") {
            commandSeparator = index;
            break;
        }
    }
    const optionArgs = commandSeparator < 0 ? args : args.slice(0, commandSeparator);
    if (commandSeparator >= 0) options.command = args.slice(commandSeparator + 1);

    for (let index = 0; index < optionArgs.length; index++) {
        const flag = optionArgs[index];
        const value = optionArgs[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少参数`);
        index++;

        if (flag === "--url") options.url = value;
        else if (flag === "--env") {
            const [key, envValue] = parsePair(value, flag);
            options.env[key] = envValue;
        } else if (flag === "--header") {
            const [key, headerValue] = parsePair(value, flag);
            options.headers[key] = headerValue;
        } else if (flag === "--cwd") options.cwd = value;
        else throw new Error(`未知参数：${flag}`);
    }

    if (options.url && options.command) throw new Error("--url 和 -- 命令不能同时使用");
    if (!options.url && (!options.command || options.command.length === 0)) {
        throw new Error("需要指定 --url 或 -- <命令> [参数...]");
    }
    if (options.url && Object.keys(options.env).length > 0) throw new Error("--env 仅适用于 stdio 服务");
    if (options.command && Object.keys(options.headers).length > 0) throw new Error("--header 仅适用于 HTTP 服务");
    if (options.cwd && !options.command) throw new Error("--cwd 仅适用于 stdio 服务");
    return options;
}

function printList(servers: McpServerConfig[], asJson: boolean): void {
    if (asJson) {
        const result = servers.map((server) => ({
            ...server,
            env: server.env ? Object.keys(server.env) : undefined,
            headers: server.headers ? Object.keys(server.headers) : undefined,
        }));
        writeOutput(JSON.stringify(result, null, 2));
        return;
    }

    if (servers.length === 0) {
        writeOutput("尚未配置 MCP 服务。使用 `zbot mcp add <名称> -- <命令>` 添加服务。");
        return;
    }

    const rows = servers.map((server) => [
        server.name,
        server.disabled ? "disabled" : "enabled",
        server.type,
        String(server.defer === true),
        String(server.lazy === true),
        server.type === "stdio" ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") : server.url || server.serverUrl || "-",
    ]);
    const displayWidth = (value: string): number =>
        Array.from(value).reduce((width, character) => width + eastAsianWidth(character.codePointAt(0) ?? 0), 0);
    const headers = ["名称", "状态", "类型", "defer", "lazy", "命令 / URL"];
    const widths = headers.map((header, index) =>
        Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[index]))),
    );
    const format = (row: string[]): string => row.map((cell, index) =>
        cell + " ".repeat(widths[index] - displayWidth(cell)),
    ).join("  ");
    writeOutput(format(headers));
    for (const row of rows) writeOutput(format(row));
}

function printHelp(): void {
    writeOutput(MCP_CLI_USAGE);
}

export async function runMcpCli(args: string[], options: McpCliOptions = {}): Promise<void> {
    const [subcommand, ...subcommandArgs] = args;
    const configPath = options.configPath ?? getConfigPath();

    if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
        printHelp();
        return;
    }

    if (subcommand === "list") {
        const unknownArgs = subcommandArgs.filter((arg) => arg !== "--json");
        if (unknownArgs.length > 0) throw new Error(`未知参数：${unknownArgs.join(" ")}`);
        printList(readConfig(configPath).servers, subcommandArgs.includes("--json"));
        return;
    }

    if (subcommand === "add") {
        const options = parseAddArgs(subcommandArgs);
        const config = readConfig(configPath);
        if (config.servers.some((server) => server.name === options.name)) {
            throw new Error(`MCP 服务已存在：${options.name}`);
        }
        const server: McpServerConfig = options.url
            ? { name: options.name, type: "http", url: options.url, headers: options.headers }
            : {
                name: options.name,
                type: "stdio",
                command: options.command![0],
                args: options.command!.slice(1),
                ...(Object.keys(options.env).length > 0 ? { env: options.env } : {}),
                ...(options.cwd ? { cwd: options.cwd } : {}),
            };
        writeConfig(configPath, config.root, [...config.servers, server]);
        writeOutput(`已添加 MCP 服务：${options.name}`);
        return;
    }

    if (subcommand === "remove") {
        const [name, ...extraArgs] = subcommandArgs;
        if (!name || extraArgs.length > 0) throw new Error("用法：zbot mcp remove <名称>");
        const config = readConfig(configPath);
        if (!config.servers.some((server) => server.name === name)) throw new Error(`找不到 MCP 服务：${name}`);
        writeConfig(configPath, config.root, config.servers.filter((server) => server.name !== name));
        writeOutput(`已移除 MCP 服务：${name}`);
        return;
    }

    throw new Error(`未知 MCP 子命令：${subcommand}`);
}
