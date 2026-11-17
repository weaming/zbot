import { describe, expect, test } from 'bun:test';
import { toolCatalog } from '../../src/tools/tool-catalog.js';
import { registerSessionRuntime } from '../../src/control/runtime.js';

describe('tool registry', () => {
    test('会话权限拒绝时不执行工具，未装配权限的会话沿用原策略', async () => {
        const { executeMcpTool } = await import('../../src/tools/tool-registry.js');
        let executed = 0;
        const toolName = 'zz_test_permission_tool';
        toolCatalog.registerLocalTools([{
            name: toolName,
            inputSchema: { type: 'object', properties: {} },
            execute: async () => { executed++; return { content: [{ type: 'text', text: 'executed' }] }; },
        }]);
        const unregister = registerSessionRuntime({
            ownsSession: id => id === 'protected',
            authorizeTool: async () => false,
        });
        try {
            const rejected = await executeMcpTool(toolName, { __sessionId: 'protected' });
            expect(rejected.isError).toBe(true);
            expect(executed).toBe(0);
            const unprotected = await executeMcpTool(toolName, { __sessionId: 'other' });
            expect(unprotected.isError).not.toBe(true);
            expect(executed).toBe(1);
        } finally { unregister(); }
    });
    test('executeMcpTool 回退到工具级 contextPolicy 声明', async () => {
        const { executeMcpTool } = await import('../../src/tools/tool-registry.js');
        const toolName = 'zz_test_full_context_tool';
        toolCatalog.registerLocalTools([{
            name: toolName,
            inputSchema: { type: 'object', properties: {} },
            contextPolicy: { mode: 'full' },
            execute: async () => ({ content: [{ type: 'text', text: 'full' }] }),
        }]);

        const result = await executeMcpTool(toolName, {});

        expect(result.content).toEqual([{ type: 'text', text: 'full' }]);
        expect(result.contextPolicy).toEqual({ mode: 'full' });
    });

    test('执行结果显式 contextPolicy 优先于工具级声明', async () => {
        const { executeMcpTool } = await import('../../src/tools/tool-registry.js');
        const toolName = 'zz_test_override_context_tool';
        toolCatalog.registerLocalTools([{
            name: toolName,
            inputSchema: { type: 'object', properties: {} },
            contextPolicy: { mode: 'full' },
            execute: async () => ({
                content: [{ type: 'text', text: 'adaptive' }],
                contextPolicy: { mode: 'adaptive' },
            }),
        }]);

        const result = await executeMcpTool(toolName, {});

        expect(result.contextPolicy).toEqual({ mode: 'adaptive' });
    });
});
