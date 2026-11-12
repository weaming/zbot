/**
 * 配置值里的环境变量引用：`$NAME` / `${NAME}` 视为指向另一个环境变量。
 * 密钥只以引用形式落在 env 文件里，真实值只留在进程环境，避免明文二次落盘。
 */

/** 单个引用的匹配范围：`$NAME`（NAME 为 [A-Za-z_][A-Za-z0-9_]*）或 `${NAME}`。 */
const REFERENCE_PATTERN = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;

/** 整个值就是一个环境变量引用时返回其名字，否则返回 undefined。 */
function referencedEnvName(value: string): string | undefined {
    const matched = REFERENCE_PATTERN.exec(value.trim());
    return matched ? matched[1] ?? matched[2] : undefined;
}

/** 顺着引用链取环境变量值；链成环时按未设置处理。 */
function followEnvReference(name: string): string {
    const visited = new Set<string>();
    let current = name;
    while (!visited.has(current)) {
        visited.add(current);
        const resolved = process.env[current]?.trim() ?? "";
        const next = referencedEnvName(resolved);
        if (next === undefined) return resolved;
        current = next;
    }
    return "";
}

/** 展开单个配置值：是引用则取目标环境变量，其余值原样返回；引用落空时返回空串。 */
export function resolveEnvReference(value: string): string {
    const name = referencedEnvName(value);
    return name === undefined ? value : followEnvReference(name);
}

/**
 * 读环境变量并展开引用：变量未设置返回 undefined，引用未落地返回空串。
 * 密钥为空与未配置同义，调用方按缺失处理。
 */
export function readEnvValue(name: string): string | undefined {
    const raw = process.env[name];
    return raw === undefined ? undefined : resolveEnvReference(raw);
}

/** 该变量只写了引用、目标却没有值时的说明，用于报错点明配置断在哪一环。 */
export function describeBrokenEnvReference(name: string): string | undefined {
    const raw = process.env[name];
    const target = raw === undefined ? undefined : referencedEnvName(raw);
    if (target === undefined || followEnvReference(target)) return undefined;
    return `${name}=$${target} 引用的环境变量 ${target} 未设置`;
}
