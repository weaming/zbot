import fs from 'node:fs';
import { arch, platform } from 'node:process';

const COMPILED_DIR = 'dist';
const OUT_DIR = 'dist-bundle';
const EMPTY_NATIVE = { contents: 'export default {};', loader: 'js' };

function cleanDir(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
}

// tokenizers 的 napi 加载器会 require 全部 13 个平台的 .node，而 bun 无法静态求值
// process.platform，会把它们统统当作资源复制进产物（每个入口 13 个，约 70MB）。
// 这里把非本机平台的 .node 指到空 stub，使产物只保留本机那一个。
function hostNativePrefix() {
  if (platform !== 'linux') return `tokenizers.${platform}-${arch}`;
  const libc = fs.existsSync('/etc/alpine-release') ? 'musl' : 'gnu';
  return `tokenizers.linux-${arch}-${libc}`;
}

const hostNativeOnly = {
  name: 'host-native-only',
  setup(build) {
    const host = hostNativePrefix();
    build.onResolve({ filter: /tokenizers\..*\.node$/ }, (args) => {
      const base = args.path.replace(/^.*\//, '');
      if (base.startsWith(host)) return;
      return { path: args.path, namespace: 'stub-native' };
    });
    build.onLoad({ filter: /.*/, namespace: 'stub-native' }, () => EMPTY_NATIVE);
  },
};

async function bunBuild(input, outDir) {
  console.log(`Building ${input}...`);
  fs.mkdirSync(outDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: [input],
    target: 'bun',
    outdir: outDir,
    plugins: [hostNativeOnly],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

// Clean and create output directory
cleanDir(OUT_DIR);

// UI 是独立工程（ui/），产物以文本形式内联进二进制；缺了就直接失败，别产出没有界面的包
const UI_BUNDLE = 'src/web/.ui-dist/index.html';
if (!fs.existsSync(UI_BUNDLE)) {
  console.error(`缺少 UI 产物 ${UI_BUNDLE}：先运行 \`bun run build:ui\``);
  process.exit(1);
}

// 身份文本按源码位置跟随模块：runtime-context 编译到 dist/host/，资源必须落在同一目录
fs.mkdirSync(`${COMPILED_DIR}/host`, { recursive: true });
fs.copyFileSync('src/host/AGENTS.md', `${COMPILED_DIR}/host/AGENTS.md`);

// 同理：ui.js 编译到 dist/web/，它 import 的界面产物要一并放过去，bun 才能内联
fs.mkdirSync(`${COMPILED_DIR}/web/.ui-dist`, { recursive: true });
fs.copyFileSync(UI_BUNDLE, `${COMPILED_DIR}/web/.ui-dist/index.html`);

await bunBuild(`${COMPILED_DIR}/tui/main.js`, OUT_DIR);

console.log('Build complete');
