/**
 * 直接看某个会话**事件日志的原文**，找 `assistant_message` 里有没有 `reasoning`。
 *
 * ## 为什么不再逐层猜
 *
 * 已经确认到这一步：
 *   · 模型非流式：`reasoning_content` 3245 字符
 *   · 模型流式：900 条 `reasoning_content` delta，累计 2481 字符
 *   · 客户端代码：`delta.reasoning_content ?? delta.reasoning` → yield `reasoning_delta`
 *   · `collect`：`case 'reasoning_delta': reasoning += event.text`
 *   · 会话：`...(output.reasoning.trim() === '' ? {} : { reasoning })`
 *   · 投影：`...(event.reasoning === undefined || event.reasoning === '' ? {} : { reasoning })`
 *
 * 一路上每一环看起来都对，而结果还是 0。**这时候不能再读代码了** ——
 * 要看日志原文：那一条 `assistant_message` 到底长什么样。
 *
 * 用法：node tools/dump-session-events.mjs [sessionId前缀]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = join(homedir(), '.mvs-agent')
const SESSIONS = join(HOME, 'sessions')

const state = JSON.parse(readFileSync(join(HOME, 'state.json'), 'utf8'))
const prefix = process.argv[2]
const session =
  prefix === undefined
    ? state.sessions[state.sessions.length - 1]
    : state.sessions.find((s) => String(s.sessionId).startsWith(prefix))

if (session === undefined) {
  console.log('  没找到会话')
  process.exit(1)
}
console.log(`  会话 ${String(session.sessionId).slice(0, 8)}  ${session.title}`)

/** 会话目录按工作区哈希分 — 找一遍 */
function findEvents(dir) {
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...findEvents(full))
    } else if (entry.name === 'events.jsonl' && full.includes(String(session.sessionId).slice(0, 8))) {
      found.push(full)
    }
  }
  return found
}

let candidates = findEvents(SESSIONS)
if (candidates.length === 0) {
  // 退一步：任何含这个 sessionId 的 events.jsonl
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'events.jsonl') {
        const text = readFileSync(full, 'utf8')
        if (text.includes(String(session.sessionId))) candidates.push(full)
      }
    }
  }
  if (existsSync(SESSIONS)) walk(SESSIONS)
}

if (candidates.length === 0) {
  console.log('  ✗ 找不到事件日志')
  process.exit(1)
}
for (const file of candidates) {
  console.log(`  日志 ${file.replace(HOME, '~')}  ${(statSync(file).size / 1024).toFixed(1)} KB`)
}
console.log('')

for (const file of candidates) {
  const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '')
  console.log(`  ── ${lines.length} 条事件`)
  for (const line of lines) {
    let envelope
    try {
      envelope = JSON.parse(line)
    } catch {
      continue
    }
    const event = envelope.event ?? envelope
    if (event.type !== 'assistant_message') continue
    console.log('')
    console.log(`     type=${event.type}`)
    console.log(`     键：${Object.keys(event).join(', ')}`)
    console.log(`     text 长度：${String(event.text ?? '').length}`)
    console.log(`     reasoning 字段：${event.reasoning === undefined ? '(没有)' : `${event.reasoning.length} 字符`}`)
    console.log(`     toolCalls：${(event.toolCalls ?? []).length}`)
    if (event.reasoning !== undefined) {
      console.log(`     reasoning 开头：${JSON.stringify(String(event.reasoning).slice(0, 100))}`)
    }
    console.log(`     原文：${line.slice(0, 300)}`)
  }
}
