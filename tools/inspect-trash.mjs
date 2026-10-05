/**
 * 看**真实的**回收站里有什么，以及能不能恢复。
 *
 * ## 位置
 *
 *     ~/.mvs-agent/trash/sessions/<sessionId>-<时间戳>/
 *
 * ⚠️ 清理脚本原来提示的是 `state/trash/sessions` —— **少了一层**，
 * 那个路径根本不存在。跟着它去找会以为「没有回收站、东西没了」。
 * 一个指错地方的「可恢复」提示比没有提示更糟：它让人放弃恢复。
 *
 * 用法：node tools/inspect-trash.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = join(homedir(), '.mvs-agent')
const TRASH = join(HOME, 'trash', 'sessions')

if (!existsSync(TRASH)) {
  console.log(`  没有 ${TRASH}`)
  process.exit(0)
}

console.log(`  ${TRASH}`)
console.log('')

const entries = readdirSync(TRASH, { withFileTypes: true })
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  const full = join(TRASH, entry.name)
  let inner = []
  try {
    inner = readdirSync(full)
  } catch {
    /* 读不了 */
  }
  const hasEvents = inner.includes('events.jsonl')
  const size = hasEvents ? (statSync(join(full, 'events.jsonl')).size / 1024).toFixed(1) : '?'
  console.log(`  ${entry.name}`)
  console.log(`      内容 ${inner.join(', ') || '(空)'}`)
  console.log(`      events.jsonl ${size} KB`)
}
console.log('')
console.log(`  共 ${entries.length} 个回收项`)

const state = JSON.parse(readFileSync(join(HOME, 'state.json'), 'utf8'))
console.log('')
console.log(`  索引里现在 ${state.workspaces.length} 个工作区、${state.sessions.length} 条会话`)
