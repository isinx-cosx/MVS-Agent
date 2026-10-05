/**
 * 找本机的 llama.cpp 系二进制。
 *
 * 用途：`D:\models\35b` 里是 GGUF，需要知道用哪个运行时把它跑起来、以及它认哪些参数
 * （尤其是 `--ctx-size` 和 `-ngl`，那两个直接决定速度和显存/内存的分配）。
 *
 * 用法：node tools/find-llama.mjs
 */

import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = [
  'D:\\',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  join(process.env['LOCALAPPDATA'] ?? '', 'Programs'),
  join(process.env['USERPROFILE'] ?? '', '.lmstudio'),
  join(process.env['USERPROFILE'] ?? '', 'AppData', 'Local', 'Programs'),
]

const WANT = /^(llama-server|llama-cli|llama-bench|koboldcpp)\.exe$/i

/** 这些目录进去基本是浪费时间，而且很深 */
const SKIP = new Set([
  'Windows',
  'System32',
  'WinSxS',
  'node_modules',
  '$Recycle.Bin',
  'System Volume Information',
  'Packages',
])

const hits = []

function walk(dir, depth) {
  if (depth > 5 || hits.length > 20) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (hits.length > 20) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue
      walk(full, depth + 1)
    } else if (WANT.test(entry.name)) {
      try {
        hits.push({ path: full, mb: statSync(full).size / 1048576 })
      } catch {
        /* 读不到就跳过 */
      }
    }
  }
}

for (const root of ROOTS) {
  if (root !== '' && existsSync(root)) walk(root, 0)
}

if (hits.length === 0) {
  console.log('  没找到 llama-server / llama-cli / llama-bench / koboldcpp')
  console.log('')
  console.log('  → 要跑那两个 GGUF，得先有 llama.cpp 的 Windows 构建。')
  console.log('    官方发布页有预编译包（解压即用，无需安装）。')
} else {
  for (const hit of hits) {
    console.log(`  ${hit.mb.toFixed(1).padStart(7)} MB  ${hit.path}`)
  }
}
