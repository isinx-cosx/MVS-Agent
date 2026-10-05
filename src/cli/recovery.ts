/**
 * 恢复层的人工调用入口。
 *
 * 和工具层同样的边界：**模型拿不到它。** 这里只有你。
 *
 * 用法：
 *   node src/cli/recovery.ts status
 *   node src/cli/recovery.ts list --root <工作区>
 *   node src/cli/recovery.ts restore last --root <工作区>
 *   node src/cli/recovery.ts restore txn-xxxx --force
 */

import process from 'node:process'
import { createRecovery } from '../recovery/index.ts'
import type { Transaction } from '../recovery/types.ts'
import { dim, bold, green, red, yellow } from './style.ts'

interface Options {
  command: string
  target?: string
  root: string
  storeDir?: string
  force: boolean
}

function parseArgs(argv: string[]): Options {
  const options: Options = { command: '', root: process.cwd(), force: false }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--force' || arg === '-f') {
      options.force = true
      continue
    }
    if (arg === '--root') {
      options.root = argv[++i] ?? options.root
      continue
    }
    if (arg === '--store') {
      options.storeDir = argv[++i]
      continue
    }
    positional.push(arg)
  }

  options.command = positional[0] ?? 'status'
  options.target = positional[1]
  return options
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

function printTransaction(t: Transaction, index: number): void {
  const changes = t.changes
  const parts = [
    changes.added.length > 0 ? green(`+${changes.added.length}`) : '',
    changes.modified.length > 0 ? yellow(`~${changes.modified.length}`) : '',
    changes.removed.length > 0 ? red(`-${changes.removed.length}`) : '',
  ].filter(Boolean)

  process.stdout.write(
    `${dim(String(index).padStart(3, ' '))}  ${bold(t.id)}\n` +
      `     ${t.summary}  ${parts.join(' ')}  ${dim(t.finishedAt)}\n`,
  )
  for (const p of changes.removed) process.stdout.write(red(`       删除 ${p}\n`))
  for (const p of changes.modified) process.stdout.write(yellow(`       修改 ${p}\n`))
  for (const p of changes.added) process.stdout.write(green(`       新增 ${p}\n`))
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const manager = createRecovery({ root: options.root, storeDir: options.storeDir })
  await manager.init()

  if (options.command === 'status') {
    const status = await manager.status()
    process.stdout.write(
      `${bold('恢复层状态')}\n` +
        `  工作区      ${status.root}\n` +
        `  存储目录    ${status.storeDir}\n` +
        `  事务数      ${status.transactions} / ${status.maxTransactions}\n` +
        `  存储占用    ${human(status.storeBytes)}\n` +
        `  排除目录    ${status.excludes.join('、')}\n`,
    )
    if (status.malformedJournalLines > 0) {
      process.stdout.write(
        yellow(`  ⚠ 日志有 ${status.malformedJournalLines} 行损坏、已被跳过\n`),
      )
    }
    process.stdout.write(
      dim('\n  注意：这是撤销设施，不是备份。它与工作区在同一块磁盘上。\n'),
    )
    return
  }

  if (options.command === 'list') {
    const transactions = await manager.list()
    if (transactions.length === 0) {
      process.stdout.write(dim('还没有任何可撤销的操作。\n'))
      return
    }
    transactions.forEach(printTransaction)
    process.stdout.write(dim(`\n用 recovery.ts restore <id> 撤销其中一个。\n`))
    return
  }

  if (options.command === 'restore') {
    if (options.target === undefined) {
      process.stderr.write(red('用法：restore <事务id|last> [--force]\n'))
      process.exitCode = 1
      return
    }

    const report =
      options.target === 'last'
        ? await manager.restoreLast({ force: options.force })
        : await manager.restore(options.target, { force: options.force })

    if (report === null) {
      process.stdout.write(dim('没有可撤销的事务。\n'))
      return
    }

    process.stdout.write(`${report.ok ? green('✔') : yellow('⚠')} ${report.message}\n`)
    for (const p of report.restored) process.stdout.write(green(`  还原 ${p}\n`))
    for (const p of report.deleted) process.stdout.write(green(`  删除 ${p}\n`))
    for (const s of report.skipped) {
      process.stdout.write(
        yellow(`  跳过 ${s.path}（${s.reason === 'conflict' ? '该文件在此之后被改动过' : s.reason}）\n`),
      )
    }
    if (report.skipped.some((s) => s.reason === 'conflict')) {
      process.stdout.write(
        dim('  这些文件没有被覆盖 —— 那会毁掉你之后的改动。要强制覆盖加 --force。\n'),
      )
    }
    if (report.notCovered.length > 0) {
      process.stdout.write(yellow('\n本次恢复管不到：\n'))
      for (const gap of report.notCovered) process.stdout.write(yellow(`  · ${gap}\n`))
    }
    if (report.restoreTransactionId !== null) {
      process.stdout.write(
        dim(`\n这次恢复本身也是一个事务（${report.restoreTransactionId}），可以再撤回去。\n`),
      )
    }
    return
  }

  process.stderr.write(
    red(`未知命令：${options.command}\n`) +
      '可用：status | list | restore <id|last>\n',
  )
  process.exitCode = 1
}

await main()
