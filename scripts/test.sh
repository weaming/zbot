#!/usr/bin/env bash
# 测试入口：把「依赖进程级 mock」的文件拆出来逐个跑。
#
# bun 的 mock.module 是进程级且不能撤回，也无法按文件隔离模块图：
# 同一进程里先有文件加载了真实模块，后面的 mock 就失效——测试会真的去请求上游模型，
# 整轮挂住而不是失败。所以凡是用了 mock.module 的文件，一律独占一个进程。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# 干净克隆没有 UI 产物（gitignore），而 src/web/ui.ts 静态 import 它，缺了连测试都加载不了
if [ ! -f src/web/.ui-dist/index.html ]; then
    echo "UI 产物缺失，先构建…"
    bun run build:ui || exit 1
fi

MOCKED=$(grep -rl 'mock\.module' tests/unit src --include='*.test.ts' 2>/dev/null | sort)
BATCH=$(find tests/unit src -name '*.test.ts' 2>/dev/null | sort | grep -vxF "$MOCKED")

status=0
if [ -n "$BATCH" ]; then
    # shellcheck disable=SC2086
    bun test $BATCH || status=$?
fi

# 每个 mock 文件独占进程（进程级 mock 不能混），但彼此无依赖，可并行缩短总时长
if [ -n "$MOCKED" ]; then
    printf '%s\n' "$MOCKED" \
        | xargs -P "${MOCK_JOBS:-4}" -o -I{} sh -c 'bun test "$1" || exit 1' _ {} \
        || status=1
fi

exit $status
