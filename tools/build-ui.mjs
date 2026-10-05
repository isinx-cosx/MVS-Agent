/**
 * 把 `ui/` 打成 `web/` —— 守护进程直接服务的那个目录。
 *
 * ## 为什么是 esbuild 而不是 Vite
 *
 * 我们要的东西只有三件：认 TSX、能打包 CJS 的 React、输出到 `web/`。
 * Vite 在这三件之外还带来一个开发服务器、一套配置、一层插件体系；而我们的
 * 页面由守护进程自己吐出去（`UI_DIR` 就是 `web/`），**不需要第二个服务器**。
 *
 * esbuild 一条命令就够，且没有配置文件。代价是没有热更新 —— 改完刷新即可，
 * 对这个体量的界面足够。
 *
 * ⚠️ 必须打包的原因：React 的 npm 包是 **CJS**（`main: index.js`），浏览器
 * 不能直接 `import`。所以"tsc 编译 + importmap"那条路走不通，只能打包。
 *
 * ## 文件名带内容哈希（**这不是审美选择**）
 *
 * 输出是 `app-<hash>.js` / `app-<hash>.css`，`index.html` 里引用的是带哈希的名字。
 *
 * 起因是个反复咬人的坑：**名字固定的资源会被浏览器缓存钉住**，服务端改了七八版、
 * 浏览器一版都没取；而开发侧的验证（无头渲染、探针、截图）**全都不经过浏览器缓存**，
 * 所以看上去一切正常 —— 我只在用户说"改了没用"时才发现。这次也是这样：代码和
 * CSS 都在产物里，用户屏幕上就是没有。
 *
 * 文件名随内容变是**根治**：URL 变了，缓存就无从命中。顺带还有一个好处 ——
 * 守护进程的缓存策略（`src/host/server.ts` 的 `cachePolicyFor`）认这种形状，
 * 会给它们 `immutable`（一年），而那些不带哈希的文件只能 `no-cache`。
 * 两边本来就是照着这个设计写的，只是一直没人产出带哈希的名字。
 *
 * 用法：node tools/build-ui.mjs
 */

import { build } from 'esbuild'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'web')

mkdirSync(OUT, { recursive: true })

/*
 * `--dev`：开发版（React 开发包 + 不压缩）。
 *
 * ## 为什么默认改成生产版
 *
 * 原来固定 `development` + `minify: false` ✓，注释里的理由很实在：React 开发版会
 * 报出可读的警告（hooks 依赖写错、key 重复），而这是个本地应用。但代价实测出来是：
 *
 *     JS   2,242 KB  →  773 KB       （production + minify，省 66%）
 *     CSS     49 KB  →   41 KB
 *
 * 也就是**每次加载多搬 1.5 MB**，而且产物里带着 `react-dom.development` ✓。
 * 这两件事都该由"你在干什么"决定，而不是写死：
 *
 *   npm run ui:build        生产版（默认）—— 快，sourcemap 仍在，报错仍能映射回源码
 *   npm run ui:build:dev    开发版 —— 拿回 React 的可读警告
 *
 * ⚠️ 生产版并不是"不能调试"：`sourcemap: true` 一直开着 ✓，所以栈轨迹照样指到
 * 源码行 ✓。丢掉的是 React 自己那几句警告（生产包里只剩 `Minified React error #xxx`
 * 加一个链接）。**要那些警告时就用 `ui:build:dev`。**
 */
const dev = process.argv.includes('--dev')

const result = await build({
  /* 命名成 `app`，这样产物是 `app-<hash>.js` / `app-<hash>.css` */
  entryPoints: { app: join(ROOT, 'ui', 'main.tsx') },
  outdir: OUT,
  /* ★ 内容哈希进文件名 —— 见文件头那段 */
  entryNames: '[name]-[hash]',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome120', 'firefox120', 'safari17'],
  jsx: 'automatic',
  /*
   * ⚠️ **必须 define `process.env.NODE_ENV`。**
   *
   * React 的包里到处是 `if (process.env.NODE_ENV === 'production')`，而浏览器里
   * 根本没有 `process` —— 不替换掉就是白屏加一句 `process is not defined`。
   *
   * 取什么值见上面的 `--dev` 说明。
   */
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
  /*
   * CSS 由 main.tsx 里的 import 带出来，esbuild 会顺手输出 `app-<hash>.css`。
   *
   * KaTeX 的 CSS 给每个字体列了三种格式：woff2 / woff / ttf。
   * 现代浏览器**只会取 woff2**（`src:` 里第一个能用的），另两种永远不会下载。
   * 所以只把 woff2 当资源拷出去，woff/ttf 用 `empty` 顶掉 —— 它们是几十个
   * 加起来好几 MB 的死重，而 url 仍然能解析到（一个空文件）。
   */
  loader: { '.css': 'css', '.woff2': 'file', '.woff': 'empty', '.ttf': 'empty' },
  /* 开发版不压缩（浏览器里那一行可读）；生产版压缩。理由同上 */
  minify: !dev,
  sourcemap: true,
  /* 要拿到产物文件名（它们带哈希，猜不出来），所以必须开 metafile */
  metafile: true,
  logLevel: 'warning',
})

/* ── 从 metafile 里认出这次产出的入口文件 ─────────────────────────────── */
const produced = Object.keys(result.metafile.outputs)
  .map((p) => basename(p))
  .filter((name) => /^app-.*\.(js|css)$/.test(name))

const js = produced.find((name) => name.endsWith('.js'))
const css = produced.find((name) => name.endsWith('.css'))
if (js === undefined || css === undefined) {
  throw new Error(`没能从产物里认出 app-*.js / app-*.css，实际产出：${JSON.stringify(produced)}`)
}

/*
 * 生成 index.html：把模板里的 `./app.js` / `./app.css` 换成带哈希的名字。
 *
 * 模板仍然写死这两个名字 —— 它是**给人看的源文件**，不该出现哈希。
 */
const html = readFileSync(join(ROOT, 'ui', 'index.html'), 'utf8')
  .replace('./app.css', `./${css}`)
  .replace('./app.js', `./${js}`)
if (!html.includes(js) || !html.includes(css)) {
  throw new Error('index.html 里没能替换进带哈希的文件名 —— 模板里的引用是不是改了？')
}
writeFileSync(join(OUT, 'index.html'), html)

/* ── 清掉上一批产物，免得目录里越堆越多 ──────────────────────────────── */
const keep = new Set([js, css, `${js}.map`, `${css}.map`, 'index.html'])
for (const name of readdirSync(OUT)) {
  /*
   * 两类都要删：带哈希的 `app-<hash>.js`，以及更早的**不带哈希**的
   * `app.js` / `app.css`（那个正是缓存问题的源头，留着只会让人以为还在用它）。
   * 字体与别的文件一律不碰。
   */
  if (!/^app(?:-[^.]*)?\.(js|css)(\.map)?$/.test(name)) continue
  if (keep.has(name)) continue
  rmSync(join(OUT, name), { force: true })
}

/*
 * 收尾这行把**模式**说出来：产物文件名带哈希、看起来都一样，不写清楚的话
 * 没人知道刚才构建的是生产版还是开发版 —— 而这两者差 1.5 MB 和一堆警告。
 */
const kb = (n) => (n / 1024).toFixed(0)
console.log(
  `ui → web 完成（${dev ? '开发版' : '生产版'}）：${js} ${kb(statSync(join(OUT, js)).size)} KB` +
    ` + ${css} ${kb(statSync(join(OUT, css)).size)} KB`,
)
if (!dev) {
  console.log('  （要 React 的可读警告就用 npm run ui:build:dev 重建）')
}
