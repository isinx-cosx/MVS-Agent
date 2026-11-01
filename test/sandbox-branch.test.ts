/**
 * 沙箱分支的端到端：`MVS_SANDBOX=low-il` 打开后，`run_command` 真的走 Job。
 *
 * 这一组必须真跑 —— 它验的是「命令在别的进程里、且受 Job 限制」，
 * 用假对象测不出来。
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { runCommandTool } from '../src/tools/command-tool.ts'
import type { ToolContext } from '../src/tools/types.ts'

function ctx(root: string): ToolContext {
  return { root } as ToolContext
}

async function withSandbox<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env['MVS_SANDBOX']
  process.env['MVS_SANDBOX'] = 'low-il'
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env['MVS_SANDBOX']
    else process.env['MVS_SANDBOX'] = previous
  }
}

test('沙箱：命令在 Job 里跑，输出与退出码都回来', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-sbxtool-'))
  try {
    await withSandbox(async () => {
      const result = await runCommandTool.run({ command: process.execPath, args: ['-v'] }, ctx(root))
      assert.equal(result.ok, true, `${result.error?.kind}: ${result.error?.message} :: ${result.content}`)
      assert.match(result.content, /v\d+\./)
      const data = result.data as { sandbox?: string; exitCode?: number; writeBytes?: number }
      assert.equal(data.sandbox, 'low-il')
      assert.equal(data.exitCode, 0)
      assert.equal(typeof data.writeBytes, 'number')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('沙箱：非零退出码是失败（沙箱自己正常 ≠ 命令成功）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-sbxtool-'))
  try {
    await withSandbox(async () => {
      const result = await runCommandTool.run(
        { command: process.execPath, args: ['-e', 'process.exit(3)'] },
        ctx(root),
      )
      assert.equal(result.ok, false)
      assert.match(result.content, /3/)
      const data = result.data as { exitCode?: number; sandbox?: string }
      assert.equal(data.exitCode, 3)
      assert.equal(data.sandbox, 'low-il')
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('沙箱：写字节计数能观测到（1 MB 写入被计量，或写入被拒绝）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-sbxtool-'))
  try {
    await withSandbox(async () => {
      const result = await runCommandTool.run(
        {
          command: process.execPath,
          args: ['-e', "require('fs').writeFileSync('big.bin', Buffer.alloc(1048576))"],
        },
        ctx(root),
      )
      const data = result.data as { writeBytes?: number }
      /*
       * 目录没打 Low 标签时写入会被拒（exitCode 非 0）—— 那也是正确行为：
       * 说明「默认拒绝」。两种结果的共同点是 writeBytes 必须是数字。
       */
      assert.equal(typeof data.writeBytes, 'number')
      if (result.ok) assert.ok((data.writeBytes ?? 0) >= 1024 * 1024, `writeBytes=${data.writeBytes}`)
      else assert.match(result.content, /Access is denied|EPERM|denied/i)
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/*
 * 进程数上限没有单测：在 Job 里 spawn 的失败是"创建被拒"而不是"报错返回"，
 * 靠 JS 侧计数测不稳定（同一台机器上时快时慢）。它由独立探针证明：
 *
 *   node tools/sandbox-run.mjs --max-processes 8 -- cmd /c "…起 80 个子进程…"
 *   → exitCode 1，stderr 里 80 行 "Not enough quota is available to process this command."
 *
 * 放在这里说明，是为了让下一个人不用再试一遍"用 JS 数 spawn 成功数"这条路。
 */


test('沙箱：关闭时行为完全不改变（默认值不能悄悄变）', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-sbxtool-'))
  try {
    const result = await runCommandTool.run({ command: process.execPath, args: ['-v'] }, ctx(root))
    assert.equal(result.ok, true)
    const data = result.data as { sandbox?: string; writeBytes?: number }
    assert.equal(data.sandbox, undefined, '没开沙箱时不该有 sandbox 字段')
    assert.equal(data.writeBytes, undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
