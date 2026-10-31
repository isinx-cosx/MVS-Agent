/**
 * 输出捕获的硬上限与磁盘哨兵。
 *
 * 两个都是"我们自己的放大器"被修掉之后的回归测试：
 *
 *   1. 原来 `readFile` 整个读进内存 → 一个 200 MB 的输出能把守护进程打穿
 *   2. 原来临时文件无上限 → `yes` 跑 30 秒能写出 GB 级文件
 *   3. 磁盘本来就快满了还照跑 → 恢复层连快照都写不进去
 *
 * ⚠️ 这些测试是真的起子进程，不是 mock。它们要验的正是"子进程把巨量输出
 * 写进 fd 之后我们怎么活下来"，mock 掉子进程就等于把要验的东西删了。
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { runCommandTool } from '../src/tools/command-tool.ts'
import type { ToolContext } from '../src/tools/types.ts'

async function tempRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'mvs-capture-'))
}

function ctxOf(root: string): ToolContext {
  return { root } as ToolContext
}

/** 本地临时目录里还剩几个 `mvs-cmd-*`（测试前后比较，验证"跑完就删"） */
async function captureDirs(): Promise<string[]> {
  const items = await readdir(os.tmpdir())
  return items.filter((name) => name.startsWith('mvs-cmd-'))
}

test('输出炸弹：200 MB stdout 被截断，正文有上限，字节数如实给出', async () => {
  const root = await tempRoot()
  const before = await captureDirs()
  try {
    const result = await runCommandTool.run(
      {
        command: process.execPath,
        args: [
          '-e',
          "const s='x'.repeat(1000); for(let i=0;i<200000;i++) process.stdout.write(s)",
        ],
        timeoutMs: 30_000,
      },
      ctxOf(root),
    )

    const data = result.data as { stdout: string; truncated: boolean; stdoutBytes: number }
    assert.equal(data.truncated, true, '必须标记为截断')
    assert.equal(data.stdoutBytes, 200_000_000, `原始字节数要如实给出，实际 ${data.stdoutBytes}`)
    assert.ok(data.stdout.length < 70_000, `正文应当被截到 6 万字符上下，实际 ${data.stdout.length}`)
    assert.match(data.stdout, /输出已截断/, '要说明截断了以及原始大小')

    /* 临时目录必须清掉：捕获文件可能有 8 MB，留着就是泄漏 */
    const after = await captureDirs()
    assert.deepEqual(after.sort(), before.sort(), `临时目录没清干净：${after.join(', ')}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('空输出：不崩，且不产生假的"截断"（曾经的 end=-1 边界）', async () => {
  const root = await tempRoot()
  try {
    const result = await runCommandTool.run(
      { command: process.execPath, args: ['-e', ''], timeoutMs: 10_000 },
      ctxOf(root),
    )
    const data = result.data as { stdout: string; stderr: string; truncated: boolean }
    assert.equal(result.ok, true)
    assert.equal(data.stdout, '')
    assert.equal(data.truncated, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('普通输出：原文照旧、字节数正确、不标记截断', async () => {
  const root = await tempRoot()
  try {
    const result = await runCommandTool.run(
      { command: process.execPath, args: ['-e', "process.stdout.write('hello-世界')"], timeoutMs: 10_000 },
      ctxOf(root),
    )
    const data = result.data as { stdout: string; truncated: boolean; stdoutBytes: number }
    assert.equal(data.stdout, 'hello-世界')
    assert.equal(data.truncated, false)
    assert.equal(data.stdoutBytes, Buffer.byteLength('hello-世界', 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('磁盘哨兵：剩余空间低于底线时**不启动**命令，回 insufficient_disk', async () => {
  const root = await tempRoot()
  const marker = path.join(root, 'should-not-exist.txt')
  const saved = process.env.MVS_DISK_FLOOR_MB
  try {
    /* 把底线抬到不可能满足的高度，逼出"拒绝启动"这条路 */
    process.env.MVS_DISK_FLOOR_MB = '999999999'
    const result = await runCommandTool.run(
      {
        command: process.execPath,
        args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        timeoutMs: 10_000,
      },
      ctxOf(root),
    )

    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'insufficient_disk', `实际：${JSON.stringify(result.error)}`)
    assert.match(result.error?.message ?? '', /低于底线/)

    /* 关键：命令根本没跑 —— 副作用文件不该存在 */
    const exists = await readdir(root).then((items) => items.includes('should-not-exist.txt'))
    assert.equal(exists, false, '被拒绝的命令不该产生任何副作用')
  } finally {
    if (saved === undefined) delete process.env.MVS_DISK_FLOOR_MB
    else process.env.MVS_DISK_FLOOR_MB = saved
    await rm(root, { recursive: true, force: true })
  }
})
