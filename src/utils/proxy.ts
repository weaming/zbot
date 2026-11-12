import { getNetworkConfig } from "../config/index.js";

/** 命令行工具与网络请求使用的代理；未配置时返回 undefined（直连）。 */
export function getNetworkProxy(): string | undefined {
    return getNetworkConfig().proxy;
}

/** 判断是否为容器内地址（单段主机名），此类请求不经过外部代理。 */
export function isInternalHostname(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || !hostname.includes(".");
}

/**
 * 为 LLM 请求创建代理 fetch：仅使用 OPENAI_PROXY，
 * 未设置时直连。容器内服务地址自动跳过代理。
 */
export function getOpenAIProxyFetch(): typeof fetch {
    const proxyUrl = getNetworkConfig().openaiProxy;

    return (input: RequestInfo | URL, init?: RequestInit) => {
        const targetUrl = typeof input === "string"
            ? new URL(input)
            : input instanceof URL
                ? input
                : new URL(input.url);

        if (isInternalHostname(targetUrl.hostname) || !proxyUrl) {
            return fetch(input, init);
        }

        return fetch(input, {
            ...init,
            // @ts-ignore — Bun native fetch supports proxy option
            proxy: proxyUrl,
        });
    };
}
