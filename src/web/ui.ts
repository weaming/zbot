/**
 * Web 界面产物：`ui/` 用 Vite 构建成单文件 HTML（JS/CSS 全内联），
 * 这里以文本形式打进 zbot 二进制，保持「一个可执行文件」的分发方式。
 *
 * 构建：`bun run build:ui`（或 `make build` 会自动先构建）。
 * 产物目录 `.ui-dist/` 是生成物，不进版本库。
 */

import uiHtml from "./.ui-dist/index.html" with { type: "text" };

export function renderUiPage(): string {
    return uiHtml;
}
