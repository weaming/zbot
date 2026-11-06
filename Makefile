BUN ?= bun
ZBOT_TUI_BIN ?= $(HOME)/.bun/bin/zbot
GO ?= go
BUNPACK_DIR = bunpack
BUNPACK = $(CURDIR)/.cache/bunpack

# ---- Web 界面产物 ----

# UI 是独立工程（ui/），产物以文本内联进二进制；
# 源码模式与两种打包方式都依赖它，缺了 bun 会直接报解析失败
UI_SRC = $(shell find ui/src -type f 2>/dev/null) \
	ui/index.html ui/package.json ui/bun.lock ui/vite.config.ts ui/tsconfig.json
UI_BUNDLE = src/web/.ui-dist/index.html

# 瘦身版：7MB 单文件，运行时借用系统 bun
build-pack: $(UI_BUNDLE)
	mkdir -p $(dir $(BUNPACK))
	$(GO) build -C $(BUNPACK_DIR) -trimpath -ldflags "-s -w" -o $(BUNPACK) .
	$(BUNPACK) build src/tui/main.ts -out $(ZBOT_TUI_BIN) -name zbot \
		-inline .tokjson

# dist-bundle 规则已包含 UI 构建与 tsc，这里只负责编译成单文件可执行
build-cli: dist-bundle/main.js
	mkdir -p "$(dir $(ZBOT_TUI_BIN))"
	$(BUN) build dist-bundle/main.js --compile --no-compile-autoload-dotenv --outfile="$(ZBOT_TUI_BIN)"

# 源文件没变就跳过重建
$(UI_BUNDLE): $(UI_SRC)
	cd ui && $(BUN) install --silent && $(BUN) run build

# ---- web（任务看板）----

PORT ?= 8787
CWD ?= $(CURDIR)

# 源码模式：bun 直接跑 TS，只需保证 UI 产物是最新的
web: $(UI_BUNDLE)
	$(BUN) src/tui/main.ts web --port $(PORT) --cwd $(CWD)

# 打包模式：全量构建（build:ui + tsc + bun build）后跑 dist-bundle；
# UI 由 `bun run build` 自己负责，这里不要再挂 $(UI_BUNDLE)，否则同一份 vite 构建跑两遍
dist-bundle/main.js: $(shell find src -name '*.ts' 2>/dev/null) $(UI_SRC) build.mjs package.json
	$(BUN) run build

web-prod: dist-bundle/main.js
	$(BUN) dist-bundle/main.js web --port $(PORT) --cwd $(CWD)

# 前端 HMR：改 UI 不用重启后端
dev-ui:
	ZBOT_WEB_URL=http://127.0.0.1:$(PORT) $(BUN) run dev:ui

.PHONY: web web-prod dev-ui
