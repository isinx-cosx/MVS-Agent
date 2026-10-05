/**
 * 把磁盘上存在、但**不在索引里**的会话重新挂回索引。
 *
 * ## 为什么需要它
 *
 * `close_workspace` 会把工作区**和它名下的会话索引条目**一起摘掉，
 * 而会话本体留在磁盘上。于是现象是「我的会话不见了」，而数据其实好好的。
 *
 * ⚠️ **这是我造成的。** 我用 `close_workspace` 关掉了两个不属于我的工作区
 * （以为是探针留下的），于是那两个工作区名下的会话从索引里消失了。
 * 磁盘上没丢 —— 但也**不会自己回来**：`open_workspace` 只挂载目录，
 * 不扫描孤儿会话。
 *
 * ## 判据
 *
 * 每个会话目录里的 `checkpoint.json` 记着它属于哪个工作区。
 * 工作区路径和我们传进来的对得上、又不在索引里 → 补一条索引条目。
 *
 * ## 安全性
 *
 * 默认**只报告不写**。要真的写必须显式加 `--apply`。
 * 改 `state.json` 是破坏性操作，不该由一次误触完成 ——
 * 我刚刚已经因为「顺手关掉」做错过一次了。
 *
 * 用法：
 *   node tools/restore-sessions.mjs <工作区路径>            # 只看
 *   node tools/restore-sessions.mjs <工作区路径> --apply    # 真的写
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = join(homedir(), '.mvs-agent')
const STATE = join(HOME, 'state.json')
const SESSIONS = join(HOME, 'sessions')

const target = process.argv[2]
const apply = process.argv.includes('--apply')

if (target === undefined) {
  console.error('用法: node tools/restore-sessions.mjs <工作区路径> [--apply]')
  process.exit(1)
}

const state = JSON.parse(readFileSync(STATE, 'utf8'))
const indexed = new Set(state.sessions.map((s) => s.sessionId))

/** 收集磁盘上所有会话目录 */
const found = []
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
    if (existsSync(join(full, 'events.jsonl'))) {
      let checkpoint = null
      try {
        checkpoint = JSON.parse(readFileSync(join(full, 'checkpoint.json'), 'utf8'))
      } catch {
        /* 没有 checkpoint 就跟不了 */
      }
      found.push({ sessionId: entry.name, dir: full, checkpoint })
    } else {
      walk(full)
    }
  }
}

if (existsSync(SESSIONS)) walk(SESSIONS)
console.log(`  磁盘上 ${found.length} 个会话目录`)

/** checkpoint 的形状在不同版本上不一样，两种都试 */
const workspaceOf = (checkpoint) =>
  checkpoint?.record?.workspace ?? checkpoint?.workspace ?? checkpoint?.session?.workspace
const titleOf = (checkpoint) => checkpoint?.record?.title ?? checkpoint?.title ?? ''

const mine = found.filter((s) => workspaceOf(s.checkpoint) === target)
console.log(`  属于「${target}」的：${mine.length} 个`)
const orphans = mine.filter((s) => !indexed.has(s.sessionId))
console.log(`  其中不在索引里的：${orphans.length} 个`)
console.log('')

if (orphans.length === 0) {
  console.log('  没有需要恢复的')
  process.exit(0)
}

const withTurns = orphans.filter((s) => {
  try {
    return statSync(join(s.dir, 'events.jsonl')).size > 2048
  } catch {
    return false
  }
})
console.log(`  含真实对话（events > 2 KB）的：${withTurns.length} 个`)
for (const orphan of withTurns.slice(0, 15)) {
  const record = orphan.checkpoint?.record ?? {}
  console.log(
    `    ${orphan.sessionId.slice(0, 8)}  ${String(titleOf(orphan.checkpoint)).slice(0, 24)}` +
      `  ${record.createdAt ?? ''}`,
  )
}
console.log('')

if (!apply) {
  console.log('  只是看一眼 —— 要真的写请加 --apply')
  process.exit(0)
}

/*
 * ⚠️ 写之前先备份。改 state.json 是破坏性的，而这次操作本身就是在补救
 * 一次破坏性操作 —— 不该再有第二次机会都没有。
 */
const backup = `${STATE}.before-restore-${Date.now()}`
renameSync(STATE, backup)
console.log(`  已备份 ${backup}`)

let added = 0
for (const orphan of orphans) {
  const record = orphan.checkpoint?.record ?? {}
  const dirName = orphan.dir.split(/[\\/]/).pop() ?? ''
  state.sessions.push({
    sessionId: orphan.sessionId,
    workspace: target,
    title: titleOf(orphan.checkpoint) || '（恢复的会话）',
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: record.updatedAt ?? record.createdAt ?? new Date().toISOString(),
  })
  added += 1
  void dirName
}

writeFileSync(STATE, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
console.log(`  已补回 ${added} 条索引条目`)
console.log('  ⚠️ 守护进程还在内存里跑着，它下次写 state.json 会覆盖这次改动 —— 请重启它。')
