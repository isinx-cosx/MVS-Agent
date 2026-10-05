/**
 * 找 koffi 的**原生二进制**在哪，以及它有几种解析路径。
 *
 * 为什么要专门找：DSH 的 picker 靠 koffi 直接调 COM（`CoCreateInstance` +
 * `IFileOpenDialog` 的 vtable）。我们要照做，而 `import('koffi')` 能从
 * DSH 的安装目录里成功 —— 但**它把 .node 放在哪**决定了我们能不能可靠地
 * 复用它（而不是碰运气）。
 *
 * 用法：node tools/find-koffi.mjs
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const CANDIDATES = [
  'C:/Program Files/DSH NEXT/resources/app/node_modules/koffi',
  join(process.cwd(), 'node_modules', 'koffi'),
]

for (const root of CANDIDATES) {
  console.log(`  ── ${root}`)
  if (!existsSync(root)) {
    console.log('    （不存在）')
    console.log('')
    continue
  }

  const natives = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full, depth + 1)
      } else if (/\.(node|dll)$/i.test(entry.name)) {
        natives.push({ path: full.replace(root + '/', ''), kb: statSync(full).size / 1024 })
      }
    }
  }
  walk(root, 0)

  if (natives.length === 0) {
    console.log('    没有 .node/.dll —— 二进制不在这个包里')
  } else {
    for (const n of natives) console.log(`    ${n.kb.toFixed(0).padStart(7)} KB  ${n.path}`)
  }
  console.log('')
}

console.log('  ── 实际 import 一次，看它自己从哪加载')
try {
  const koffi = (await import('file:///C:/Program Files/DSH NEXT/resources/app/node_modules/koffi/index.cjs')).default
  console.log(`    ✓ koffi ${koffi.version ?? '?'}   sizeof(void*) = ${koffi.sizeof('void *')}`)
  console.log(`    load('user32.dll') 可不可以：`, (() => {
    try {
      koffi.load('user32.dll')
      return '可以'
    } catch (err) {
      return '不行：' + err.message
    }
  })())
} catch (err) {
  console.log(`    ✗ ${err.message}`)
}
