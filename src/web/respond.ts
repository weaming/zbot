/** HTTP 响应与请求体工具：各前端路由共用，保持状态码与错误形状一致。 */

export function json(data: unknown, status = 200): Response {
    // 不缩进：会话事件动辄上万个对象，两个空格的缩进能白白多出 10%~20% 的字节。
    // 人类的可读性交给浏览器开发者工具的"格式化"按钮，传输层只求小。
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

export function fail(message: string, status: number): Response {
    return json({ error: message }, status);
}

/** 读 JSON body；非法 JSON 返回 undefined，由调用方给 400。 */
export async function readJson(req: Request): Promise<Record<string, unknown> | undefined> {
    try {
        const parsed = await req.json();
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}
