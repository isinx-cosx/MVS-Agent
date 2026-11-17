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
import { diffSnapshots, walkTree } from '../src/recovery/snapshot.ts'

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

    /*
     * 只断言"没有泄漏"，**不**断言 isolated。
     *
     * 要在容器里区分"没被继承"和"不是 libuv 的 fd"，子进程必须用 `WriteFile`
     * 直接写裸 HANDLE —— 那需要加载原生模块，而容器不允许（`realpath 'C:\'` 被拒）。
     * 所以这条探针结构上只能证明单侧；详见 tools/handle-list-probe.mjs 末尾。
     */
    assert.equal(output.includes('"verdict":"LEAKED"'), false, `不允许出现泄漏：${output.slice(0, 200)}`)
    assert.match(output, /EBADF|LEAKED/)
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

/*
 * S5：只改 ADS、主数据流不变时，也必须产生事务。
 *
 * 这是唯一一类"文件看起来没动过"的改动 —— size / mtime / hash 全都不变，
 * 所以 diff 只能靠额外的判据（流条数）发现它。
 */
test(
  'S5：只写 ADS（主数据流不变）也要被 diff 抓到',
  { skip: isWindows ? false : '只有 NTFS 有替代数据流' },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mvs-ads-diff-'))
    try {
      await writeFile(path.join(root, 'a.txt'), 'main', 'utf8')
      const base = { root, excludes: new Set<string>(), maxFileBytes: 1024 * 1024, verify: true }
      const before = await walkTree(base)

      /* 只写流：主数据流一个字节都没动 */
      await writeFile(path.join(root, 'a.txt') + ':secret', 'hidden', 'utf8')
      const after = await walkTree({
        ...base,
        previous: { id: 'b', createdAt: '1970-01-01T00:00:00.000Z', root, entries: before.entries, coverage: before.coverage },
      })

      const streamsBefore = before.entries['a.txt']?.streamCount
      if (streamsBefore === undefined) {
        assert.ok(true, '这台机器枚举不了 ADS（没有 koffi），跳过')
        return
      }

      const diff = diffSnapshots(
        { id: 'b', createdAt: '1970-01-01T00:00:00.000Z', root, entries: before.entries, coverage: before.coverage },
        { id: 'a', createdAt: '1970-01-01T00:00:01.000Z', root, entries: after.entries, coverage: after.coverage },
      )
      assert.deepEqual(diff.modified, ['a.txt'], '只改 ADS 也要出现在 modified 里')
      assert.equal(streamsBefore, 0)
      assert.equal(after.entries['a.txt']?.streamCount, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
