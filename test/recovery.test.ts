/**
 * 恢复层测试。
 *
 * 最重要的一个用例是「用 shell 删文件，恢复能找回来」——
 * 那是整个恢复层存在的理由，也是 Claude Code / 华为 / Kiro 三家都做不到的事。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createRecovery, RecoveryGuard, RecoveryManager } from '../src/recovery/index.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import type { ToolContext } from '../src/tools/types.ts'
import os from 'node:os'


interface Harness {
  root: string
  storeDir: string
  manager: RecoveryManager
  guard: RecoveryGuard
  ctx: ToolContext
}

async function withHarness(
  fn: (h: Harness) => Promise<void>,
  options: { maxTransactions?: number; maxFileBytes?: number; excludes?: string[] } = {},
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  const storeDir = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    const manager = createRecovery({ root, storeDir, ...options })
    await manager.init()
    const guard = new RecoveryGuard(createDefaultRegistry(), manager)
    await fn({ root, storeDir, manager, guard, ctx: { root } })
  } finally {
    const retry = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const
    await rm(root, retry)
    await rm(storeDir, retry)
  }
}

const read = (root: string, rel: string): Promise<string> =>
  readFile(path.join(root, rel), 'utf8')

// ---------------------------------------------------------------------------
// 核心：shell 副作用也能撤
// ---------------------------------------------------------------------------

test('核心：run_command 用 shell 删掉的文件，恢复能找回来', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await writeFile(path.join(root, 'important.txt'), '不能被弄丢的内容', 'utf8')
    await writeFile(path.join(root, 'other.txt'), '别的文件', 'utf8')

    // 先做一次「基线」事务，让文件进入快照
    await guard.execute('write_file', { path: 'seed.txt', content: 'seed' }, ctx)

    // 用 node 走 shell 通道删掉文件 —— 这是工具级 checkpoint 看不见的路径
    const deletion = await guard.execute(
      'run_command',
      {
        command: process.execPath,
        args: ['-e', 'require("node:fs").rmSync("important.txt")'],
        cwd: '.',
      },
      ctx,
    )
    assert.equal(deletion.result.ok, true, deletion.result.error?.message)
    assert.equal(existsSync(path.join(root, 'important.txt')), false, '文件应该已被删除')

    // 恢复那一次删除
    assert.ok(deletion.transactionId, '删除操作应该产生事务')
    const report = await manager.restore(deletion.transactionId)
    assert.equal(report.ok, true, report.message)
    assert.deepEqual(report.restored, ['important.txt'])
    assert.equal(await read(root, 'important.txt'), '不能被弄丢的内容')
  })
})

test('核心：run_command 用 shell 覆盖的文件，恢复能还原原内容', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await writeFile(path.join(root, 'a.txt'), '原始内容', 'utf8')
    await guard.execute('write_file', { path: 'seed.txt', content: 'seed' }, ctx)

    const overwrite = await guard.execute(
      'run_command',
      {
        command: process.execPath,
        args: ['-e', 'require("node:fs").writeFileSync("a.txt","被覆盖了")'],
        cwd: '.',
      },
      ctx,
    )
    assert.equal(await read(root, 'a.txt'), '被覆盖了')

    assert.ok(overwrite.transactionId)
    const report = await manager.restore(overwrite.transactionId)
    assert.equal(report.ok, true, report.message)
    assert.equal(await read(root, 'a.txt'), '原始内容')
  })
})

// ---------------------------------------------------------------------------
// 事务的基本形状
// ---------------------------------------------------------------------------

test('无文件变化时不产生事务条目', async () => {
  await withHarness(async ({ guard, ctx, manager }) => {
    await guard.execute('write_file', { path: 'x.txt', content: '内容' }, ctx)

    // 写同样的内容 —— 文件系统没变
    const again = await guard.execute('write_file', { path: 'x.txt', content: '内容' }, ctx)
    assert.equal(
      again.transactionId,
      undefined,
      '没有变化就不该产生可撤销条目（否则会出现「点了撤销但什么也没发生」）',
    )

    const transactions = await manager.list()
    assert.equal(transactions.length, 1)
  })
})

test('读类工具不产生快照与事务', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await writeFile(path.join(root, 'r.txt'), '读我', 'utf8')
    const result = await guard.execute('read_file', { path: 'r.txt' }, ctx)
    assert.equal(result.result.ok, true)
    assert.equal(result.transactionId, undefined)
    assert.deepEqual(await manager.list(), [])
  })
})

test('参数不合法时不产生事务', async () => {
  await withHarness(async ({ guard, ctx, manager }) => {
    const bad = await guard.execute('write_file', { path: 123, content: 'x' }, ctx)
    assert.equal(bad.result.ok, false)
    assert.equal(bad.result.error?.kind, 'invalid_args')
    assert.deepEqual(await manager.list(), [])
  })
})

test('事务记录新增 / 修改 / 删除三类变化', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await mkdir(path.join(root, 'dir'), { recursive: true })
    await writeFile(path.join(root, 'dir/keep.txt'), 'keep', 'utf8')
    await writeFile(path.join(root, 'dir/edit.txt'), 'before', 'utf8')
    await writeFile(path.join(root, 'dir/gone.txt'), 'gone', 'utf8')

    const txn = await guard.execute(
      'write_file',
      { path: 'dir/edit.txt', content: 'after' },
      ctx,
    )
    await guard.execute('write_file', { path: 'dir/new.txt', content: 'new' }, ctx)
    await guard.execute('delete_file', { path: 'dir/gone.txt' }, ctx)

    const all = await manager.list()
    const merged = all.reduce(
      (acc, t) => ({
        added: [...acc.added, ...t.changes.added],
        modified: [...acc.modified, ...t.changes.modified],
        removed: [...acc.removed, ...t.changes.removed],
      }),
      { added: [] as string[], modified: [] as string[], removed: [] as string[] },
    )

    assert.ok(merged.added.includes('dir/new.txt'))
    assert.ok(merged.modified.includes('dir/edit.txt'))
    assert.ok(merged.removed.includes('dir/gone.txt'))
    assert.ok(txn.transactionId)
  })
})

// ---------------------------------------------------------------------------
// 三类恢复
// ---------------------------------------------------------------------------

test('恢复删除：文件回来', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await writeFile(path.join(root, 'doomed.txt'), '救救我', 'utf8')
    await guard.execute('write_file', { path: 'seed.txt', content: 's' }, ctx)

    const del = await guard.execute('delete_file', { path: 'doomed.txt' }, ctx)
    assert.equal(existsSync(path.join(root, 'doomed.txt')), false)

    const report = await manager.restore(del.transactionId!)
    assert.deepEqual(report.restored, ['doomed.txt'])
    assert.equal(await read(root, 'doomed.txt'), '救救我')
  })
})

test('恢复新增：新文件被删掉', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    const created = await guard.execute(
      'create_file',
      { path: 'fresh.txt', content: '新的' },
      ctx,
    )
    assert.equal(existsSync(path.join(root, 'fresh.txt')), true)

    const report = await manager.restore(created.transactionId!)
    assert.deepEqual(report.deleted, ['fresh.txt'])
    assert.equal(existsSync(path.join(root, 'fresh.txt')), false)
  })
})

test('恢复修改：内容回到动作之前', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await writeFile(path.join(root, 'v.txt'), 'v1', 'utf8')
    await guard.execute('write_file', { path: 'seed.txt', content: 's' }, ctx)

    const edit = await guard.execute('write_file', { path: 'v.txt', content: 'v2' }, ctx)
    assert.equal(await read(root, 'v.txt'), 'v2')

    await manager.restore(edit.transactionId!)
    assert.equal(await read(root, 'v.txt'), 'v1')
  })
})

test('恢复嵌套目录中的新文件时目录也被清理', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    const created = await guard.execute(
      'write_file',
      { path: 'deep/nested/file.txt', content: 'x' },
      ctx,
    )
    assert.equal(existsSync(path.join(root, 'deep/nested/file.txt')), true)

    await manager.restore(created.transactionId!)
    assert.equal(existsSync(path.join(root, 'deep/nested/file.txt')), false)
  })
})

// ---------------------------------------------------------------------------
// 冲突：拒绝，而不是覆盖
// ---------------------------------------------------------------------------

test('动作之后被改过的文件：恢复时跳过并报告冲突，不覆盖', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await writeFile(path.join(root, 'a.txt'), '原始', 'utf8')
    await guard.execute('write_file', { path: 'seed.txt', content: 's' }, ctx)

    const edit = await guard.execute('write_file', { path: 'a.txt', content: 'agent改的' }, ctx)

    // 用户在 agent 动作之后手动改了同一个文件
    await writeFile(path.join(root, 'a.txt'), '用户后来改的', 'utf8')

    const report = await manager.restore(edit.transactionId!)
    assert.equal(report.ok, false)
    assert.deepEqual(report.skipped, [{ path: 'a.txt', reason: 'conflict' }])
    assert.equal(
      await read(root, 'a.txt'),
      '用户后来改的',
      '冲突时绝不能覆盖 —— 那会毁掉用户之后的改动',
    )
  })
})

test('force 时冲突文件才被覆盖', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await writeFile(path.join(root, 'a.txt'), '原始', 'utf8')
    await guard.execute('write_file', { path: 'seed.txt', content: 's' }, ctx)
    const edit = await guard.execute('write_file', { path: 'a.txt', content: 'agent改的' }, ctx)
    await writeFile(path.join(root, 'a.txt'), '用户后来改的', 'utf8')

    const report = await manager.restore(edit.transactionId!, { force: true })
    assert.equal(report.ok, true)
    assert.equal(await read(root, 'a.txt'), '原始')
  })
})

// ---------------------------------------------------------------------------
// 恢复本身可恢复
// ---------------------------------------------------------------------------

test('恢复动作本身也是一个事务，可以再撤回去', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await writeFile(path.join(root, 'a.txt'), 'v1', 'utf8')
    await guard.execute('write_file', { path: 'seed.txt', content: 's' }, ctx)
    const edit = await guard.execute('write_file', { path: 'a.txt', content: 'v2' }, ctx)

    const restored = await manager.restore(edit.transactionId!)
    assert.equal(await read(root, 'a.txt'), 'v1')
    assert.ok(restored.restoreTransactionId, '恢复必须产生自己的事务')

    // 撤销「那次恢复」→ 回到 v2
    const undo = await manager.restore(restored.restoreTransactionId!)
    assert.equal(undo.ok, true, undo.message)
    assert.equal(await read(root, 'a.txt'), 'v2')
  })
})

test('restoreLast 撤销最近一次有变化的操作', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await guard.execute('write_file', { path: 'one.txt', content: '1' }, ctx)
    await guard.execute('write_file', { path: 'two.txt', content: '2' }, ctx)

    const report = await manager.restoreLast()
    assert.ok(report)
    assert.equal(existsSync(path.join(root, 'two.txt')), false)
    assert.equal(existsSync(path.join(root, 'one.txt')), true)
  })
})

// ---------------------------------------------------------------------------
// 诚实的盲区报告
// ---------------------------------------------------------------------------

test('全树事务：排除的目录出现在「本次恢复管不到」里，而不是被悄悄忽略', async () => {
  await withHarness(
    async ({ root, manager }) => {
      await mkdir(path.join(root, 'node_modules'), { recursive: true })
      await writeFile(path.join(root, 'node_modules/dep.js'), 'dep', 'utf8')
      await writeFile(path.join(root, 'app.js'), 'app', 'utf8')

      /*
       * 走 `manager` 而不是 `write_file`：文件工具现在按目标路径**收窄**，
       * 它压根不会碰到 node_modules，于是这条断言在收窄模式下测不到东西。
       * 全树路径（`run_command` 那一类）才是这条断言的场景。
       */
      const pending = await manager.begin({ tool: 'manual-full-tree' })
      await writeFile(path.join(root, 'app.js'), 'changed', 'utf8')
      const txn = await manager.commit(pending)
      const report = await manager.restore(txn!.id)

      assert.ok(
        report.notCovered.some((g) => g.includes('node_modules')),
        `盲区必须被报告出来，实际：${JSON.stringify(report.notCovered)}`,
      )
    },
    { excludes: ['node_modules'] },
  )
})

test('全树事务：超过体积上限的文件被跳过，并且被记录', async () => {
  await withHarness(
    async ({ root, manager }) => {
      await writeFile(path.join(root, 'big.bin'), 'x'.repeat(5000), 'utf8')
      await writeFile(path.join(root, 'small.txt'), 'ok', 'utf8')

      const pending = await manager.begin({ tool: 'manual-full-tree' })
      await writeFile(path.join(root, 'small.txt'), 'ok2', 'utf8')
      const txn = await manager.commit(pending)
      const report = await manager.restore(txn!.id)

      assert.ok(
        report.notCovered.some((g) => g.includes('big.bin')),
        `超大文件必须被记录为盲区，实际：${JSON.stringify(report.notCovered)}`,
      )
    },
    { maxFileBytes: 1000 },
  )
})

test('符号链接不被跟随，并被记录为盲区', async (t) => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await writeFile(path.join(root, 'real.txt'), 'real', 'utf8')
    try {
      await symlink(
        path.join(root, 'real.txt'),
        path.join(root, 'link.txt'),
        process.platform === 'win32' ? 'file' : undefined,
      )
    } catch {
      t.skip('本机无法创建符号链接（Windows 需要管理员或开发者模式）')
      return
    }

    const txn = await guard.execute('write_file', { path: 'real.txt', content: 'changed' }, ctx)
    const report = await manager.restore(txn.transactionId!)
    assert.ok(report.notCovered.some((g) => g.includes('符号链接')))
  })
})

// ---------------------------------------------------------------------------
// 存储行为
// ---------------------------------------------------------------------------

test('内容相同的文件只存一份 blob（内容寻址去重）', async () => {
  await withHarness(async ({ guard, ctx, storeDir }) => {
    const payload = 'x'.repeat(2000)
    await guard.execute('write_file', { path: 'a.txt', content: payload }, ctx)
    await guard.execute('write_file', { path: 'b.txt', content: payload }, ctx)

    const { readdir } = await import('node:fs/promises')
    const blobs = await readdir(path.join(storeDir, 'blobs'), { withFileTypes: true })
    let fileCount = 0
    for (const shard of blobs) {
      if (!shard.isDirectory()) continue
      const inner = await readdir(path.join(storeDir, 'blobs', shard.name))
      fileCount += inner.length
    }
    assert.equal(fileCount, 1, `两份相同内容应该只占一个 blob，实际 ${fileCount} 个`)
  })
})

test('超过保留上限的旧快照会被回收', async () => {
  await withHarness(
    async ({ guard, ctx, storeDir }) => {
      const rounds = 5
      for (let i = 0; i < rounds; i += 1) {
        await guard.execute('write_file', { path: `f${i}.txt`, content: `content-${i}` }, ctx)
      }

      const { readdir } = await import('node:fs/promises')
      const snapshots = await readdir(path.join(storeDir, 'snapshots'))

      // 每个事务持有 before + after 两份快照，所以上限是 2 × maxTransactions
      assert.ok(
        snapshots.length <= 2 * 3,
        `maxTransactions=3 时快照数应 ≤ 6，实际 ${snapshots.length}`,
      )
      // 不回收的话会是 2 × rounds
      assert.ok(
        snapshots.length < 2 * rounds,
        `应该发生了回收，实际仍有 ${snapshots.length} 份（不回收会是 ${2 * rounds}）`,
      )
    },
    { maxTransactions: 3 },
  )
})

test('status 报告事务数、存储占用与排除项', async () => {
  await withHarness(async ({ guard, ctx, manager }) => {
    await guard.execute('write_file', { path: 'x.txt', content: 'x' }, ctx)
    const status = await manager.status()
    assert.equal(status.transactions, 1)
    assert.ok(status.storeBytes > 0)
    assert.ok(status.excludes.length > 0)
    assert.equal(status.malformedJournalLines, 0)
  })
})

test('恢复不存在的事务时明确失败，而不是静默成功', async () => {
  await withHarness(async ({ manager }) => {
    const report = await manager.restore('txn-does-not-exist')
    assert.equal(report.ok, false)
    assert.match(report.message, /找不到/)
    assert.equal(report.restoreTransactionId, null)
  })
})

test('工作区之外的存储目录不会被自己快照进去', async () => {
  await withHarness(async ({ root, guard, ctx, manager }) => {
    await guard.execute('write_file', { path: 'x.txt', content: 'x' }, ctx)
    const transactions = await manager.list()
    assert.equal(transactions.length, 1)
    const touched = [
      ...transactions[0].changes.added,
      ...transactions[0].changes.modified,
      ...transactions[0].changes.removed,
    ]
    assert.ok(
      touched.every((p) => !p.includes('.mvs-agent')),
      `存储目录不该出现在工作区变更里：${JSON.stringify(touched)}`,
    )
    void root
  })
})
