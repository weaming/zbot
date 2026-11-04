/**
 * MCP 通知：连接状态变化、需要用户完成的授权链接。
 * 放在 types 层是为了让控制层的运行时注册表能按结构引用它，而不反向依赖 mcp 实现。
 */

export interface McpNotice {
    server: string;
    level: "info" | "warn" | "error";
    text: string;
    /** 需要用户打开的授权链接 */
    url?: string;
}
