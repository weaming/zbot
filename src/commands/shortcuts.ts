/**
 * 快捷键清单（唯一事实源）：快捷键面板只读渲染这份表，
 * 键位与说明在此集中维护，避免实现与展示漂移。
 *
 * 按**生效场景**分组：主界面（会话 / 生成）、输入框、滚动与搜索、退出、
 * 仅 kitty 协议终端、各面板内、命令。同一键位在不同场景语义不同（如 ⌃D：主界面退出 /
 * 展开模式翻页 / 面板内翻页），因此允许跨组重复；条件写在该条 desc 里。
 */

/** 快捷键条目：仅本模块与快捷键面板的展示数据使用，不对外暴露。 */
interface ShortcutEntry {
    /** 键位展示文本（⌘ ⌃ ⌥ ⇧ 符号形式）。 */
    keys: string;
    /** 功能说明。 */
    desc: string;
}

export interface ShortcutGroup {
    title: string;
    entries: ShortcutEntry[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
    {
        title: "主界面 · 会话",
        entries: [
            { keys: "⌘P / ⌃P", desc: "会话面板（搜索 / 切换 / 重命名 / 删除 / 归档）" },
            { keys: "⌃N", desc: "新建会话" },
            { keys: "⌘R", desc: "重命名当前会话（终端未转发 ⌘ 时用 ⌘P 面板内 ⌃R）" },
            { keys: "⌃X", desc: "删除当前会话（2 秒内再按一次确认）" },
            { keys: "⌃[ / ⌃]", desc: "上一个 / 下一个会话（legacy 下 ⌃[ 等于 Esc）" },
            { keys: "⌃T", desc: "显示 / 收起历史 turn 的改动详情（向上滚动加载更早）" },
            { keys: "⌃O", desc: "展开 / 收起工具调用详情" },
        ],
    },
    {
        title: "主界面 · 生成",
        entries: [
            { keys: "Enter", desc: "发送；生成中则入队" },
            { keys: "⌥Enter", desc: "继续执行未完成的任务（需终端 Option as Meta）" },
            { keys: "Esc", desc: "生成中：中止当前生成；空闲时放行给输入框" },
            { keys: "⌃C", desc: "生成中：中止当前生成；空闲时提示 ⌃D 退出" },
            { keys: "⌃B", desc: "运行 shell 时放入后台；否则把会话间等待放入后台" },
            { keys: "⌥↑ / ⌥↓ / ⌥⌫", desc: "输入框为空且队列非空：浏览 / 删除入队消息（需 Option as Meta）" },
        ],
    },
    {
        title: "输入框",
        entries: [
            { keys: "⇧Enter / ⌃J", desc: "换行" },
            { keys: "Tab", desc: "补全命令 / 技能 / 路径" },
            { keys: "↑ / ↓ / ⌃R", desc: "历史输入（⌃R 向上；多行时光标上下移动）" },
            { keys: "⌃A / ⌃E", desc: "行首 / 行尾" },
            { keys: "⌃B / ⌃F", desc: "左 / 右移一个字符" },
            { keys: "⌥B / ⌥F", desc: "左 / 右移一个词（⌥← / ⌥→ 同；需 Option as Meta）" },
            { keys: "⌃U / ⌃K", desc: "删除到行首 / 行尾（⌃O 展开模式下 ⌃U 为翻页）" },
            { keys: "⌃W / ⌥⌫", desc: "删除前一个词" },
            { keys: "⌥D / Delete", desc: "删除后一个词 / 后一个字符" },
            { keys: "⌃Y / ⌥Y", desc: "粘贴 / 循环剪贴环" },
            { keys: "⌃-", desc: "撤销" },
            { keys: "⌃⌥]", desc: "跳到指定字符" },
        ],
    },
    {
        title: "滚动与搜索",
        entries: [
            { keys: "PgUp / PgDn", desc: "上 / 下翻页" },
            { keys: "⌃⇧↑ / ⌃⇧↓", desc: "跳到上 / 下一条提问" },
            { keys: "⌃U / ⌃D", desc: "⌃O 展开模式下：上 / 下翻页" },
            { keys: "滚轮", desc: "滚动（面板内同样有效）" },
        ],
    },
    {
        title: "退出",
        entries: [
            { keys: "⌃D", desc: "退出（2 秒内再按一次确认；⌃O 展开模式下为翻页）" },
        ],
    },
    {
        title: "提问面板",
        entries: [
            { keys: "↑ / ↓ / Enter", desc: "选择 / 确认答案" },
            { keys: "Esc", desc: "收起面板，返回阅读对话" },
            { keys: "⌃⇧Q", desc: "重新展开待回答的问题" },
            { keys: "⌃C", desc: "取消提问" },
        ],
    },
    {
        title: "仅 kitty 协议终端",
        entries: [
            { keys: "⌃/", desc: "打开快捷键面板（legacy 终端用 F1）" },
            { keys: "⌃1..9", desc: "切到会话条第 N 个会话（序号见会话条）" },
            { keys: "⌃⇧[ / ⌃⇧]", desc: "上一个 / 下一个会话（含已归档）" },
            { keys: "⌃⇧F", desc: "搜索对话（Enter / ⇧Enter 或 ⌃G / ⌃⇧G 上下一处；legacy 下等于 ⌃F）" },
        ],
    },
    {
        title: "面板内 · 会话面板（⌘P / ⌃P）",
        entries: [
            { keys: "↑ / ↓", desc: "选择会话（PgUp / PgDn / ⌃D 与滚轮翻页）" },
            { keys: "Enter", desc: "切换到选中会话" },
            { keys: "⌃R / ⌃X", desc: "重命名 / 删除选中会话（⌃X 需再按一次确认）" },
            { keys: "⌃A / ⌃U", desc: "归档 / 取消归档选中会话（归档需确认）/ 清空搜索" },
            { keys: "Esc / ⌃C", desc: "关闭面板" },
        ],
    },
    {
        title: "面板内 · 快捷键（⌃/）",
        entries: [
            { keys: "↑↓ / jk", desc: "滚动一行" },
            { keys: "⌃U / ⌃D", desc: "上 / 下翻页（PgUp / PgDn 同）" },
            { keys: "滚轮", desc: "滚动" },
            { keys: "Esc / ⌃C", desc: "关闭；⌃/ 或 F1 也可关闭快捷键面板" },
        ],
    },
    {
        title: "命令",
        entries: [
            { keys: "/new /sessions", desc: "新建会话 / 打开会话面板" },
            { keys: "/keys", desc: "快捷键面板" },
            { keys: "/clear /delete", desc: "清空当前会话 / 彻底删除会话" },
            { keys: "/close", desc: "关闭当前会话（释放持有，数据保留，⌘P 可重新打开）" },
            { keys: "/archive /unarchive", desc: "归档 / 取消归档当前会话" },
            { keys: "/compact /continue", desc: "压缩上下文 / 续跑未完成任务" },
            { keys: "/system", desc: "查看 system prompt" },
            { keys: "/model", desc: "模型与思考强度（查看 / 切换模型 / 设置强度）" },
            { keys: "/skills /mcp /help", desc: "技能清单 / MCP 状态 / 帮助" },
        ],
    },
];
