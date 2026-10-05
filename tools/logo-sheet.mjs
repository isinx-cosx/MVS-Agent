/**
 * 生成一张 **logo 对照表**：图形标在各档尺寸下、以及和名称的组合。
 *
 * ## 为什么要单独一张
 *
 * 侧栏里图形只有 24px，首屏 32px —— 在那个尺寸下**看不出图形对不对**，
 * 只能看出「像不像一团东西」。要审 logo 必须放大看，还要看它在
 * 浅色/深色下、以及和名称并排时的比例。
 *
 * 这张表就是干这个的：一屏里把该看的都摆出来。
 *
 * 用法：node tools/logo-sheet.mjs [输出html]
 *
 * 默认输出到 `dist/web/brand/index.html` —— 那样守护进程的 `/brand/` 就能直接打开它，
 * 你可以自己缩放、切深色、对着真页面看，而不是看我拍的截图。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { BRAND, nameSvg, symbolSvg } from './replica-brand.mjs'

const out = process.argv[2] ?? 'dist/web/brand/index.html'
mkdirSync(dirname(out), { recursive: true })

const sizes = [16, 24, 32, 48, 64, 96]

/** 一行：尺寸标签 + 该尺寸下的图形 */
const sizeRow = sizes
  .map(
    (s) => `
      <div class="cell">
        <div class="mark" style="height:${s + 8}px">${symbolSvg(s)}</div>
        <div class="label">${s}px</div>
      </div>`,
  )
  .join('')

/** 侧栏里的实际组合：图形 + 8px 间隙 + 名称 */
const lockup = `
    <div class="lockup">
      <span class="markBox">${symbolSvg(24)}</span>
      <span class="nameBox">${nameSvg()}</span>
    </div>`

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>MVS logo 对照表</title>
<style>
  /* 用和界面同一套字体栈，这样名称的字形和实际一致 */
  :root { --fg:#0f1115; --bg:#fff; --muted:#7f8287; --line:rgba(0,0,0,.1); }
  * { box-sizing:border-box; }
  body {
    margin:0; padding:32px;
    font:14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    color:var(--fg); background:var(--bg);
  }
  h1 { font-size:16px; font-weight:600; margin:0 0 4px; letter-spacing:.02em; }
  p.note { color:var(--muted); margin:0 0 28px; font-size:12px; }
  h2 { font-size:12px; font-weight:600; color:var(--muted); margin:28px 0 12px;
       letter-spacing:.06em; text-transform:uppercase; }
  .row { display:flex; align-items:flex-end; gap:28px; flex-wrap:wrap;
         padding:20px; border:.5px solid var(--line); border-radius:8px; }
  .cell { display:flex; flex-direction:column; align-items:center; gap:8px; }
  .mark { display:flex; align-items:center; color:var(--fg); }
  .label { font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; }

  /* 侧栏实际组合 */
  .lockup { display:inline-flex; align-items:center; gap:8px; height:24px; color:var(--fg); }
  .markBox { flex:none; display:inline-flex; align-items:center; justify-content:center; }
  .nameBox { display:inline-flex; align-items:center; height:24px; }
  .lockupSm { transform:scale(1); }
  .zoom { transform:scale(3); transform-origin:left center; margin:36px 0 0 8px; }

  /* 深色底：验证 fill="currentColor" 有没有正确跟随 */
  .dark { background:#0f1115; color:#eaeff8; padding:20px; border-radius:8px; }
  /*
   * 深色底里**必须把 .mark 也覆盖掉**。
   *
   * .mark 自己声明了 color:var(--fg)（近黑）。那是**直接声明在元素上**的，
   * 而 .dark 的 color 只是它**祖先**的颜色 —— 继承赢不过直接声明。
   * 所以不显式覆盖的话，深色底里的图形仍然是黑的，等于没测。
   *
   * 这个错误的表现很隐蔽：图看着「有个东西在那儿」，但看不出它是黑的。
   *
   * ⚠️ 这一段在**模板字符串里**，注释里不能出现反引号 —— 会直接把模板撕开。
   * 同一个坑我已经踩了三次（另两次在探针的脚本里）。
   */
  .dark .mark, .dark .label, .dark .nameBox, .dark .lockup { color:#eaeff8; }
</style>
</head>
<body>
  <h1>MVS logo 对照表</h1>
  <p class="note">图形标来源于官网仓库 mvs-symbol-flat.svg（fill 已从硬编码黑改为 currentColor）</p>

  <h2>各档尺寸</h2>
  <div class="row">${sizeRow}</div>

  <h2>侧栏实际组合（图形 24px + 8px 间隙 + 名称）</h2>
  <div class="row">${lockup}</div>

  <h2>同一组合放大 3 倍</h2>
  <div class="row"><div class="zoom">${lockup}</div></div>

  <h2>深色底（验证 currentColor 跟随）</h2>
  <div class="row dark">
    <div class="cell"><div class="mark" style="height:40px">${symbolSvg(32)}</div><div class="label">32px</div></div>
    ${lockup}
  </div>
</body>
</html>
`

writeFileSync(out, page, 'utf8')
console.log(`  已生成 ${out}`)
