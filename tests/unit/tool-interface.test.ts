import { describe, expect, test } from 'bun:test';
import { canCompactJsonToolOutput, capToolOutput, compactJsonToolOutput } from '../../src/tools/tool-interface.js';

describe('tool output JSON compaction', () => {
    test('minifies a complete JSON object without changing its value', () => {
        const output = compactJsonToolOutput('{\n  "weather": {\n    "temp": 29\n  }\n}', 'qweather_weather');

        expect(output).toBe('{"weather":{"temp":29}}');
    });

    test('minifies a complete JSON array', () => {
        expect(compactJsonToolOutput('[\n  { "name": "tool" }\n]', 'LongPort__quote')).toBe('[{"name":"tool"}]');
    });

    test('preserves errors, Markdown, mixed text, and JSON scalars', () => {
        expect(compactJsonToolOutput('Error: invalid arguments', 'jin10__get_news')).toBe('Error: invalid arguments');
        expect(compactJsonToolOutput('结果：{"ok":true}', 'jin10__get_news')).toBe('结果：{"ok":true}');
        expect(compactJsonToolOutput('```json\n{"ok":true}\n```', 'jin10__get_news')).toBe('```json\n{"ok":true}\n```');
        expect(compactJsonToolOutput('true', 'jin10__get_news')).toBe('true');
    });

    test('preserves JSON formatting for file, command, and edit tools', () => {
        const formattedJson = '{\n  "nested": {\n    "value": 1\n  }\n}';

        expect(compactJsonToolOutput(formattedJson, 'cat')).toBe(formattedJson);
        expect(compactJsonToolOutput(formattedJson, 'bash')).toBe(formattedJson);
        expect(compactJsonToolOutput(formattedJson, 'edit_file')).toBe(formattedJson);
    });

    test('accepts configured structured-data tool keywords', () => {
        expect(canCompactJsonToolOutput('LongPortPrivate__stock_positions')).toBe(true);
        expect(canCompactJsonToolOutput('google_news_search')).toBe(true);
        expect(canCompactJsonToolOutput('cat')).toBe(false);
    });
});

describe('tool output size guard', () => {
    test('strips NUL bytes that would otherwise balloon the escaped log', () => {
        // 二进制输出（cat 到图片/日志）里的 \0 会变成 6 字节的 \u0000 转义
        expect(capToolOutput('a\u0000b\u0000c')).toBe('abc');
    });

    test('keeps short output untouched', () => {
        expect(capToolOutput('hello')).toBe('hello');
    });

    test('keeps head and tail with an explicit omission note', () => {
        const text = `${'A'.repeat(800)}${'B'.repeat(800)}`;

        const capped = capToolOutput(text, 1000);

        expect(capped.length).toBeLessThan(text.length);
        expect(capped.startsWith('AAA')).toBe(true);
        expect(capped.endsWith('BBB')).toBe(true);
        expect(capped).toContain('已省略中间 700 个字符');
        expect(capped).toContain('原长 1600');
    });
});
