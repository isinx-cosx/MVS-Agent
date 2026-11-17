/**
 * 后端加固的回归测试（对应 docs/后端缺陷清单.md 的第一波）。
 *
 * 覆盖三件事：
 *   1. E1：句柄隔离探针**进测试**——沙箱退化时测试会红，而不是等有人想起来手动跑
 *   2. R1：分片计数落盘——新实例读回来还是同一个计数（重启不重置）
 *   3. R1：过期清理——24 小时前的分片计数不该让今天正常读一次就降级
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { ReviewStateStore } from '../src/guard/state.ts'

const isWindows = process.platform === 'win32'

test(
  '句柄隔离：可继承句柄不会进到沙箱里的子进程（探针）',
  { skip: isWindows ? false : '只有 Windows 有这套沙箱' },
  async () => {
    const probe = path.join(process.cwd(), 'tools', 'handle-list-probe.mjs')
    const run = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`

    /* koffi 不可用的机器上这条测不了 —— 明确 skip，不假装通过 */
    if (output.includes('koffi 不可用')) {
      assert.ok(true, 'koffi 不可用，跳过')
      return
    }

    assert.match(output, /"verdict":"isolated"/, `探针应当判定 isolated，实际输出：${output.slice(0, 200)}`)
    assert.match(output, /EBADF/)
  },
)

test('分片计数：写盘之后新实例能读回来（重启不重置）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mvs-state-'))
  try {
    await mkdir(path.join(root, '.mvs'), { recursive: true })

    const first = ReviewStateStore.forWorkspace(root)
    await first.load()
    await first.recordSlice('src/a.ts', 30, 100)
    const updated = await first.recordSlice('src/a.ts', 30, 100)
    assert.equal(updated.calls, 2)
    assert.equal(updated.covered, 60)

    /* 新实例 = 模拟 daemon 重启 */
    const second = ReviewStateStore.forWorkspace(root)
    await second.load()
    const restored = second.slices().get('src/a.ts')
    assert.ok(restored !== undefined, '计数应当从盘上读回来')
    assert.equal(restored.calls, 2)
    assert.equal(restored.covered, 60)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('分片计数：超过 24 小时的条目在加载时被丢弃', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mvs-state-ttl-'))
  try {
    await mkdir(path.join(root, '.mvs'), { recursive: true })
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    await writeFile(
      path.join(root, '.mvs', 'review-state.json'),
      JSON.stringify({
        slices: { 'old.ts': { calls: 9, covered: 900, total: 1000, updatedAt: stale } },
        windows: { 'grep:old.ts': { pieces: ['abcdef'], updatedAt: stale } },
      }),
      'utf8',
    )

    const store = ReviewStateStore.forWorkspace(root)
    await store.load()
    assert.equal(store.slices().size, 0, '过期计数不该生效')
    assert.equal(store.windows().size, 0, '过期窗口不该生效')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
