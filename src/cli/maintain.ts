/**
 * 维护命令：**日志精简**与**临时目录清理**。
 *
 *     npm run maintain                       # 精简 + 清理（默认参数）
 *     npm run maintain -- --trim-only
 *     npm run maintain -- --older-than 7     # 只动 7 天以前的会话
 *     npm run maintain -- --max-body-kb 8    # 正文上限
 *
 * 为什么这是**离线**命令而不是 daemon 自带的定时任务：事件日志是唯一事实来源，
 * 改它要让人知道（也让人能选择不改）。daemon 半夜自动删掉你三个月前的工具输出，
 * 那种"优化"没人会感谢。
 */

import os from 'node:os'
import process from 'node:process'

import { defaultHomeDir } from '../config/index.ts'
import path from 'node:path'
import { describeMaintain, maintain } from '../host/log-maintenance.ts'

function argOf(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined
}

const argv = process.argv.slice(2)
const home = defaultHomeDir()
const olderThanRaw = Number(argOf(argv, '--older-than') ?? '7')
const maxBodyKb = Number(argOf(argv, '--max-body-kb') ?? '8')

const report = await maintain({
  sessionsDir: path.join(home, 'sessions'),
  ...(argv.includes('--temp-only') ? {} : { trim: {
    maxBodyBytes: (Number.isFinite(maxBodyKb) && maxBodyKb > 0 ? maxBodyKb : 8) * 1024,
    ...(Number.isFinite(olderThanRaw) && olderThanRaw > 0 ? { olderThanDays: olderThanRaw } : {}),
  } }),
  ...(argv.includes('--trim-only')
    ? {}
    : { tempDir: os.tmpdir(), tempOlderThanHours: 24 }),
})

process.stdout.write(`${describeMaintain(report)}\n`)
