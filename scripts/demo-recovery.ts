/**
 * 恢复层演示：用 shell 删掉文件，再撤销回来。
 *
 * 这正是 Claude Code / 华为 CodeArts / Kiro 三家文档都记录做不到的事——
 * 它们的快照只覆盖「自己的文件编辑工具碰过的文件」。
 *
 * 运行：node scripts/demo-recovery.ts
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { createRecovery, RecoveryGuard } from '../src/recovery/index.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'

const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-demo-'))
const storeDir = await mkdtemp(path.join(os.tmpdir(), 'mvs-demo-store-'))

const say = (text: string): void => process.stdout.write(`${text}\n`)
const rule = (): void => say('─'.repeat(68))

try {
  const manager = createRecovery({ root, storeDir })
  await manager.init()
  const guard = new RecoveryGuard(createDefaultRegistry(), manager)
  const ctx = { root }

  const target = path.join(root, 'chapter-3.md')
  await writeFile(target, '第三章：这是用户写了两周的内容。', 'utf8')

  // 先产生一次事务，把文件纳入保护范围
  await guard.execute('write_file', { path: 'notes.txt', content: '草稿' }, ctx)

  rule()
  say('【第 1 步】文件已存在')
  say(`  ${path.basename(target)} → ${JSON.stringify(await readFile(target, 'utf8'))}`)

  // ★ 关键：用 shell 删除。工具级 checkpoint 看不见这条路径。
  rule()
  say('【第 2 步】让 agent 通过 shell 删掉它')
  say(`  node -e "fs.rmSync('chapter-3.md')"`)
  const deletion = await guard.execute(
    'run_command',
    {
      command: process.execPath,
      args: ['-e', 'require("node:fs").rmSync("chapter-3.md")'],
      cwd: '.',
    },
    ctx,
  )
  say(`  执行结果: ${deletion.result.ok ? '成功' : '失败'}`)
  say(`  文件还在吗: ${existsSync(target)}`)

  // 用户发现之后…
  rule()
  say('【第 3 步】查看可撤销的操作')
  const transactions = await manager.list()
  for (const t of transactions) {
    const c = t.changes
    say(`  ${t.id}`)
    say(`    ${t.summary}`)
    say(`    新增 ${c.added.length} / 修改 ${c.modified.length} / 删除 ${c.removed.length}`)
    for (const p of c.removed) say(`      - ${p}`)
  }

  rule()
  say('【第 4 步】撤销')
  const report = await manager.restore(deletion.transactionId!)
  say(`  ${report.message}`)
  for (const p of report.restored) say(`    还原 ${p}`)

  rule()
  say('【结果】')
  say(`  文件回来了吗: ${existsSync(target)}`)
  if (existsSync(target)) {
    say(`  内容: ${JSON.stringify(await readFile(target, 'utf8'))}`)
  }

  if (report.notCovered.length > 0) {
    rule()
    say('【本次恢复管不到的东西】—— 快照会如实报告自己的盲区，而不是假装完整')
    for (const gap of report.notCovered) say(`  · ${gap}`)
  }

  rule()
  say(`  这次恢复本身也是事务 ${report.restoreTransactionId}`)
  say('  也就是说，撤销这个撤销，也是可以的。')
} finally {
  const cleanup = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const
  await rm(root, cleanup)
  await rm(storeDir, cleanup)
}
