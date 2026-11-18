/**
 * 时间线滚动控制：贴底自动跟随、容器尺寸变化保持视口、上翻加载更早记录及滚动锚点还原。
 */

import { useEffect, useRef } from "react";
import type { AgentEvent } from "./types";

export function useTimelineScroll({
    active,
    sessionId,
    events,
    live,
    hasMore,
    loadingOlder,
    loadOlder,
}: {
    active: boolean;
    sessionId: string | null;
    events: AgentEvent[];
    live: { text: string; thinking: boolean };
    hasMore: boolean;
    loadingOlder: boolean;
    loadOlder: () => Promise<boolean>;
}) {
    const timelineRef = useRef<HTMLDivElement>(null);
    /** 是否贴底：用户往上翻看历史时暂停自动滚动，翻回底部自动恢复 */
    const stickToBottom = useRef(true);
    /** 上翻插入历史后要还原滚动位置：记录插入前的 scrollHeight / scrollTop */
    const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
    const canLoadMoreRef = useRef(hasMore && !loadingOlder);
    canLoadMoreRef.current = hasMore && !loadingOlder;

    // 滚到顶部附近触发上翻：依赖稳定，不随新事件到达反复解绑
    useEffect(() => {
        if (!active || !sessionId) return;
        const node = timelineRef.current;
        if (!node) return;
        const onScroll = (): void => {
            if (node.scrollTop >= 64 || !canLoadMoreRef.current) return;
            scrollAnchor.current = { height: node.scrollHeight, top: node.scrollTop };
            void loadOlder().then(loaded => {
                if (!loaded) scrollAnchor.current = null;
            });
        };
        node.addEventListener("scroll", onScroll, { passive: true });
        return () => node.removeEventListener("scroll", onScroll);
    }, [active, sessionId, loadOlder]);

    /**
     * 贴底判定 + 历史区变矮时的滚动策略。键盘弹起、输入区展开都会让历史区变矮：
     * - 原本贴底且内容已溢出：跟到新底部，最新消息被输入框顶上去，仍停在视野里
     * - 原本在看历史，或底部还有空白：原地不动，别被浏览器钳制滚动带走
     */
    useEffect(() => {
        if (!active) return;
        const node = timelineRef.current;
        if (!node) return;
        let height = node.clientHeight;
        let top = node.scrollTop;
        let selfScroll = false;

        /** 自己写的 scrollTop 不算用户意图，否则会被当成"用户滚到底"改写贴底状态 */
        const applyScroll = (value: number): void => {
            top = value;
            selfScroll = true;
            node.scrollTop = value;
            requestAnimationFrame(() => {
                selfScroll = false;
            });
        };

        const onScroll = (): void => {
            if (selfScroll) return;
            top = node.scrollTop;
            stickToBottom.current = node.scrollHeight - top - node.clientHeight < 48;
        };

        const observer = new ResizeObserver(() => {
            const next = node.clientHeight;
            if (next === 0 || next === height) return;
            height = next;
            if (stickToBottom.current) applyScroll(node.scrollHeight - next);
            else if (node.scrollTop !== top) applyScroll(top);
        });

        node.addEventListener("scroll", onScroll, { passive: true });
        observer.observe(node);
        return () => {
            node.removeEventListener("scroll", onScroll);
            observer.disconnect();
        };
    }, [active, sessionId]);

    // 上翻插入后还原滚动位置：插在前面会让内容整体下移，不补偿就会跳到别处
    useEffect(() => {
        const anchor = scrollAnchor.current;
        if (!anchor) return;
        scrollAnchor.current = null;
        const node = timelineRef.current;
        if (!node) return;
        stickToBottom.current = false;
        node.scrollTop = node.scrollHeight - anchor.height + anchor.top;
    }, [events]);

    // 新消息与流式增量都跟着贴底，否则看不到正在生成的最后几行
    useEffect(() => {
        const node = timelineRef.current;
        if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
    }, [events, live.text, live.thinking]);

    // 切进「会话」页或切换会话时默认贴底
    useEffect(() => {
        scrollAnchor.current = null;
        if (!active) return;
        stickToBottom.current = true;
        const raf = requestAnimationFrame(() => {
            const node = timelineRef.current;
            if (node) node.scrollTop = node.scrollHeight;
        });
        return () => cancelAnimationFrame(raf);
    }, [active, sessionId]);

    return timelineRef;
}
