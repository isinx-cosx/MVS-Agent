/**
 * 磁盘上还有多少个会话目录？索引里少了哪些？
 *
 * ## 为什么要分开看
 *
 * `close_workspace` 把工作区**和它名下的会话索引条目**一起摘掉了，
 * 但会话本体（`~/.mvs-agent/sessions/<工作区哈希>/<sessionId>/`）**留在磁盘上**。
 *
 * 所以「索引里没有」不等于「数据没了」。这两件事必须分开看，
 * 否则会以为必须从回收站恢复 —— 而回收站里只有被 `delete_session` 删的那些。
 *
 * 用法：node tools/scan-orphan-sessions.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = join(homedir(), '.mvs-agent')
const SESSIONS = join(HOME, 'sessions')

const state = JSON.parse(readFileSync(join(HOME, 'state.json'), 'utf8'))
const indexed = new Set(state.sessions.map((s) => s.sessionId))

/** 走一遍磁盘，收集每个会话目录 */
const onDisk = []
const walk = (dir) => {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    const events = join(full, 'events.jsonl')
    if (existsSync(events)) {
      let size = 0
      let mtime = 0
      try {
        const info = statSync(events)
        size = info.size
        mtime = info.mtimeMs
      } catch {
        /* 读不了 */
      }
      onDisk.push({ sessionId: entry.name, dir: full, size, mtime })
    } else {
      walk(full)
    }
  }
}

if (existsSync(SESSIONS)) walk(SESSIONS)

console.log(`  磁盘上 ${onDisk.length} 个会话目录`)
console.log(`  索引里 ${indexed.size} 条`)
console.log('')

const orphans = onDisk.filter((s) => !indexed.has(s.sessionId))
console.log(`  **不在索引里、但磁盘上有的**：${orphans.length} 个`)
console.log('')
console.log('  按 events.jsonl 大小排，前 20 个：')
orphans.sort((a, b) => b.size - a.size)
for (const orphan of orphans.slice(0, 20)) {
  console.log(
    `    ${(orphan.size / 1024).toFixed(1).padStart(8)} KB  ${orphan.sessionId.slice(0, 8)}  ` +
      `${new Date(orphan.mtime).toISOString().slice(0, 16)}`,
  )
}
console.log('')
const substantial = orphans.filter((o) => o.size > 2048)
console.log(`  超过 2 KB 的（含真实对话）：${substantial.length} 个`)
for (const orphan of substantial) {
  // 试着从 checkpoint 里读标题
  let title = ''
  try {
    const cp = JSON.parse(readFileSync(join(orphan.dir, 'checkpoint.json'), 'utf8'))
    title = String(cp?.title ?? cp?.record?.title ?? '')
  } catch {
    /* 没有就没 */
  }
  console.log(`    ${(orphan.size / 1024).toFixed(1).padStart(8)} KB  ${orphan.sessionId.slice(0, 8)}  ${title}`)
}
