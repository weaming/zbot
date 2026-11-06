/**
 * `Bun.serve` 的最小类型声明：zbot 的 HTTP 前端只在 bun 运行时加载。
 *
 * 用最小声明而不是 @types/bun —— 后者会把整套 Bun 全局注入类型系统，
 * 与本项目现有的 node 类型环境互相干扰；这里只声明实际用到的形状。
 * 完整 API 见 https://bun.sh/docs/api/http。
 */
interface BunServeOptions {
    port?: number;
    hostname?: string;
    /** 空闲超时（秒）；0 表示禁用，SSE 长连接必须用它。 */
    idleTimeout?: number;
    maxRequestBodySize?: number;
    fetch(req: Request): Response | Promise<Response>;
}

interface BunServerHandle {
    readonly port: number;
    readonly hostname: string;
    readonly url: URL;
    /** 停止监听；参数为 true 时同时断开既有连接（含 SSE）。 */
    stop(closeActiveConnections?: boolean): Promise<void>;
}

declare const Bun: {
    serve(options: BunServeOptions): BunServerHandle;
};
