/**
 * 磁盘配额的**能力检查**与操作说明。
 *
 *     npm run sandbox:quota          # 只检查，不改系统
 *     npm run sandbox:quota -- --apply
 *
 * ## 为什么需要它
 *
 * 断网沙箱能挡住"把数据发出去"，但挡不住"把磁盘写满"：Job Object 有进程数、
 * 内存、CPU 的硬上限，**唯独没有磁盘配额**。现在靠轮询 `WriteTransferCount`
 * （10 ms → 50 ms 退避）发现超限再杀 —— 那是**事后**判定，几十毫秒里写掉几百 MB
 * 是可能的。
 *
 * 正解是 NTFS 按 SID 的硬配额：写超了由**文件系统**拒绝，跟轮询没关系。
 * 代价是它需要管理员 —— 所以这里分成两步：先**检查**（不需要权限），
 * 再让用户自己决定要不要用管理员跑那条命令。
 *
 * ## 为什么不自动 apply
 *
 * 改的是整卷的配额设置，影响这台机器上所有账户。这种事必须由人决定，
 * 而且要给得出回滚方式。
 */

import { spawnSync } from 'node:child_process'
import process from 'node:process'

import { APP_CONTAINER_NAME, APP_CONTAINER_SID } from '../sandbox/appcontainer.ts'
import { lookupProfileSid } from '../sandbox/profile-sid.ts'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const volume = argv.find((item) => !item.startsWith('--')) ?? 'C:'

const ownSid = lookupProfileSid(APP_CONTAINER_NAME) ?? APP_CONTAINER_SID

/* 1 GiB 上限 / 512 MiB 提示线：够构建与测试用，又不至于把盘写满 */
const LIMIT_MB = 1024
const THRESHOLD_MB = 512

const query = spawnSync('fsutil', ['quota', 'query', volume], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
const canQuery = query.status === 0

process.stdout.write(`卷：${volume}\n`)
process.stdout.write(`我们容器的 SID：${ownSid}\n`)
process.stdout.write(
  canQuery
    ? '配额查询：可用\n'
    : '配额查询：**不可用**（fsutil 需要管理员 —— 这不是故障，是权限）\n',
)

const command = [
  'fsutil',
  'quota',
  'modify',
  volume,
  String(LIMIT_MB * 1024 * 1024),
  String(THRESHOLD_MB * 1024 * 1024),
  ownSid,
].join(' ')

if (!apply) {
  process.stdout.write(
    '\n要用**硬配额**（写超了由文件系统拒绝，而不是靠轮询发现）请用管理员终端执行：\n' +
      `  ${command}\n` +
      '\n回滚：\n' +
      `  fsutil quota modify ${volume} 0 0 ${ownSid}\n` +
      '\n不加配额时，当前的兜底是轮询 `WriteTransferCount`（10 ms 起步、2 秒后退避到 50 ms），' +
      '超限杀整棵进程树。它是**事后**判定，突发写仍可能先落盘。\n',
  )
  process.exitCode = 0
} else if (!canQuery) {
  process.stdout.write('\n--apply 需要管理员权限：当前会话没有，什么都没改。\n')
  process.exitCode = 1
} else {
  const result = spawnSync('fsutil', ['quota', 'modify', volume, String(LIMIT_MB * 1024 * 1024), String(THRESHOLD_MB * 1024 * 1024), ownSid], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  })
  process.stdout.write(result.status === 0 ? '\n配额已设置。\n' : `\n设置失败：${result.stderr ?? result.stdout}\n`)
  process.exitCode = result.status === 0 ? 0 : 1
}
