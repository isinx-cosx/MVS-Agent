/*
 * 查两件事：
 *   1. `tools/` 里还有哪些 `check-*` 脚本
 *   2. `package.json` 里那些依赖被谁 import
 *
 * ## 为什么要查
 *
 * 我在 AGENT.md 里写了「零运行时依赖」和「提交前跑 check-served / check-shim-sync」，
 * 而核对的时候发现：
 *   · `dependencies` 里有 react / react-dom / marked / katex / dompurify / highlight.js
 *   · 那两个 check 脚本不在 tools/ 里了（但我这一轮跑过它们，都出结果了）
 *
 * **文档里写不成立的东西比不写更坏** —— 它会被当成事实引用。所以先查清。
 *
 * 用法：node tools/audit-deps.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'

const ROOT = process.cwd()

console.log('  ══ tools/ 里的 check-* ══')
const checks = readdirSync('tools').filter((f) => f.startsWith('check-'))
if (checks.length === 0) console.log('    （一个都没有）')
for (const f of checks) console.log(`    ${existsSync(join('tools', f)) ? '✓' : '✗'} ${f}`)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
console.log('')
console.log('  ══ package.json 的依赖 ══')
const deps = Object.keys(pkg.dependencies ?? {})
const devDeps = Object.keys(pkg.devDependencies ?? {})
console.log(`    dependencies (${deps.length}):    ${deps.join(', ') || '(空)'}`)
console.log(`    devDependencies (${devDeps.length}): ${devDeps.join(', ')}`)

/* 走一遍源码，看谁 import 了它们 */
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'web', 'shots', 'reference', 'dist'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, out)
      continue
    }
    if (!/\.(ts|mjs|js|vue)$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

const files = walk(ROOT)
const hits = new Map()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const name of [...deps, ...devDeps]) {
    /* 匹配 `from 'name'` / `from "name"` / `require('name')` */
    const needles = [`from '${name}'`, `from "${name}"`, `require('${name}')`, `require("${name}")`]
    const found = needles.some((needle) => text.includes(needle))
    if (!found) continue
    if (!hits.has(name)) hits.set(name, [])
    hits.get(name).push(file.slice(ROOT.length + 1))
  }
}

console.log('')
console.log('  ══ 谁在用它们（扫了 ' + files.length + ' 个源文件）══')
for (const name of [...deps, ...devDeps]) {
  const users = hits.get(name)
  if (users === undefined) {
    console.log(`    ${name.padEnd(14)} **没有任何源文件 import**`)
  } else {
    console.log(`    ${name.padEnd(14)} ${users.length} 处：${users.slice(0, 3).join(', ')}`)
  }
}

/* tools/ 里被删掉的脚本 —— 从 AGENT.md 引用的名字反查 */
console.log('')
console.log('  ══ AGENT.md 里引用的脚本是否存在 ══')
const agentDoc = readFileSync('AGENT.md', 'utf8')
for (const m of agentDoc.matchAll(/node (tools\/[\w.-]+\.mjs)/g)) {
  const rel = m[1].split('/').join(sep)
  console.log(`    ${existsSync(rel) ? '✓' : '✗ **不存在**'} ${m[1]}`)
}
