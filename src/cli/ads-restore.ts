/**
 * 恢复替代数据流的内容。
 *
 *     npm run ads:restore -- <事务 id>
 *     npm run ads:restore -- --list
 *
 * 命令改过文件时，`RecoveryGuard` 会把该文件的替代数据流（`a.txt:secret`）内容
 * 快照到 `.mvs/ads/<事务 id>/`，`index.json` 记录每条流的路径与字节数。
 * 这个脚本把内容写回去 —— 覆盖式的恢复，语义与 `undo` 一致：**回到那条命令之前**。
 *
 * 为什么单独一个命令、而不是塞进 `undo`：主数据流的恢复走事务快照，流是另一套
 * 存储（.mvs/ads）。混在一起会让 undo 的失败语义变模糊（主数据流恢复了、流没恢复，
 * 该报成功还是失败？）。分开之后两者各自可验证。
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { writeStream } from '../recovery/ads.ts'

interface SavedStream {
  path: string
  stream: string
  bytes: number
  file: string
}

const root = process.cwd()
const adsRoot = path.join(root, '.mvs', 'ads')
const arg = process.argv[2]

if (arg === '--list' || arg === undefined) {
  const { readdir } = await import('node:fs/promises')
  let entries: string[] = []
  try {
    entries = await readdir(adsRoot)
  } catch {
    process.stdout.write('没有 ADS 快照（.mvs/ads 不存在）。\n')
    process.exitCode = 0
  }
  if (entries.length === 0) {
    process.stdout.write('没有 ADS 快照。\n')
  } else {
    process.stdout.write(`ADS 快照（用 npm run ads:restore -- <事务 id> 恢复）：\n`)
    for (const entry of entries) process.stdout.write(`  ${entry}\n`)
  }
  process.exitCode = 0
} else {
  const dir = path.join(adsRoot, arg)
  let index: SavedStream[] = []
  try {
    index = JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf8')) as SavedStream[]
  } catch {
    process.stdout.write(`找不到事务 ${arg} 的 ADS 快照（${dir}）。\n`)
    process.exitCode = 1
  }

  if (index.length > 0) {
    let restored = 0
    for (const item of index) {
      const content = await readFile(path.join(dir, item.file))
      const ok = await writeStream(path.join(root, item.path), item.stream, content)
      if (ok) restored += 1
      process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${item.path}:${item.stream}（${item.bytes} 字节）\n`)
    }
    process.stdout.write(`\n恢复 ${restored}/${index.length} 条流。\n`)
    process.exitCode = restored === index.length ? 0 : 1
  }
}

void writeFile
