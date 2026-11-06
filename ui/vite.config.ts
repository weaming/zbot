import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/**
 * 单文件产物：构建成一个自带全部 JS/CSS 的 index.html，
 * 由 `src/web/ui.ts` 以文本形式内联进 zbot 二进制，保持单文件分发。
 * 开发时用 dev server + /api 代理，改 UI 不用重启后端。
 */
export default defineConfig({
    plugins: [react(), tailwindcss(), viteSingleFile()],
    base: "./",
    server: {
        port: 5173,
        proxy: {
            "/api": {
                target: process.env.ZBOT_WEB_URL || "http://127.0.0.1:8787",
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: "../src/web/.ui-dist",
        emptyOutDir: true,
        target: "es2022",
    },
});
