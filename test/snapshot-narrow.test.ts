/**
 * 收窄快照：只扫目标路径。
 *
 * ## 为什么要有这一组测试
 *
 * 收窄是**性能优化**，而性能优化最容易顺手改坏语义。这里守三条：
 *
 *   1. **等价性**：同一个改动，在「收窄」与「全树」两种模式下，
 *      事务里的 `added / modified / removed` 必须**完全相同**；
 *   2. **范围要可见**：收窄之后 `restore()` 的 `notCovered` 必须说明
 *      「本次只覆盖这些路径」—— 收窄而不说，等于把"撤销覆盖全部变化"
 *      这个承诺偷偷改小；
 *   3. **排除规则不收窄**：目标落在 `node_modules` 里的文件，不该因为
 *      被点名就进快照。
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { RecoveryManager } from '../src/recovery/manager.ts'
import { walkTree } from '../src/recovery/snapshot.ts'

async function tempRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'mvs-narrow-'))
}

function managerFor(root: string, options: { excludes?: string[]; maxFileBytes?: number } = {}): RecoveryManager {
  return new RecoveryManager({
    root,
    /*
     * 存储目录放在工作区**外面**。
     *
     * 放里面的话，它自己写入的 blob / snapshot 会落在两次快照之间，
     * 于是每个事务都会多出一条"新增 .mvs-recovery/..." —— 那种噪音会盖掉
     * 这里真正要验的东西（等价性）。
     */
    storeDir: `${root}-recovery`,
    excludes: options.excludes ?? ['.git', 'node_modules'],
    maxTransactions: 10,
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
  })
}

test('等价性：收窄与全树对同一个改动给出相同的事务结果', async () => {
  const root = await tempRoot()
  try {
    await writeFile(path.join(root, 'a.txt'), 'one', 'utf8')
    await writeFile(path.join(root, 'b.txt'), 'two', 'utf8')

    /* ① 全树 */
    const full = managerFor(root)
    await full.init()
    const pendingFull = await full.begin({ tool: 'write_file' })
    await writeFile(path.join(root, 'a.txt'), 'ONE', 'utf8')
    const txnFull = await full.commit(pendingFull)

    /* ② 收窄到 a.txt */
    const narrow = managerFor(root)
    await narrow.init()
    const pendingNarrow = await narrow.begin({ tool: 'write_file', only: ['a.txt'] })
    await writeFile(path.join(root, 'a.txt'), 'ONE!', 'utf8')
    const txnNarrow = await narrow.commit(pendingNarrow)

    assert.ok(txnFull !== null && txnNarrow !== null, '两次都应该产生事务')
    assert.deepEqual(txnNarrow!.changes.modified, txnFull!.changes.modified)
    assert.deepEqual(txnNarrow!.changes.added, txnFull!.changes.added)
    assert.deepEqual(txnNarrow!.changes.removed, txnFull!.changes.removed)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('收窄后：新增的文件也能被算成 added（before 里没有它）', async () => {
  const root = await tempRoot()
  try {
    const manager = managerFor(root)
    await manager.init()

    const pending = await manager.begin({ tool: 'create_file', only: ['new.txt'] })
    await writeFile(path.join(root, 'new.txt'), 'hello', 'utf8')
    const txn = await manager.commit(pending)

    assert.ok(txn !== null)
    assert.deepEqual(txn!.changes.added, ['new.txt'])
    assert.deepEqual(txn!.changes.modified, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('收窄后：删掉目标文件会被算成 removed', async () => {
  const root = await tempRoot()
  try {
    await writeFile(path.join(root, 'gone.txt'), 'x', 'utf8')
    const manager = managerFor(root)
    await manager.init()

    const pending = await manager.begin({ tool: 'delete_file', only: ['gone.txt'] })
    await rm(path.join(root, 'gone.txt'))
    const txn = await manager.commit(pending)

    assert.ok(txn !== null)
    assert.deepEqual(txn!.changes.removed, ['gone.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('收窄的范围会出现在「本次恢复管不到」里（承诺变小要说出来）', async () => {
  const root = await tempRoot()
  try {
    await writeFile(path.join(root, 'a.txt'), 'one', 'utf8')
    await writeFile(path.join(root, 'b.txt'), 'two', 'utf8')
    const manager = managerFor(root)
    await manager.init()

    const pending = await manager.begin({ tool: 'write_file', only: ['a.txt'] })
    await writeFile(path.join(root, 'a.txt'), 'ONE', 'utf8')
    const txn = await manager.commit(pending)
    const report = await manager.restore(txn!.id)

    assert.ok(
      report.notCovered.some((gap) => gap.includes('本次事务只覆盖') && gap.includes('a.txt')),
      `必须说明收窄范围，实际：${JSON.stringify(report.notCovered)}`,
    )
    /* 而且那份说明必须点出：b.txt 这种同目录文件**不在**本次范围内 */
    assert.ok(
      !report.notCovered.some((gap) => gap.includes('b.txt')),
      '收窄范围不该把没扫到的文件一个个列出来，只说明范围就够',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('收窄模式仍然尊重排除规则：点名 node_modules 里的文件也不进快照', async () => {
  const root = await tempRoot()
  try {
    await mkdir(path.join(root, 'node_modules'), { recursive: true })
    await writeFile(path.join(root, 'node_modules', 'dep.js'), 'dep', 'utf8')

    const walked = await walkTree({
      root,
      excludes: new Set(['node_modules']),
      maxFileBytes: 10 * 1024 * 1024,
      only: ['node_modules/dep.js'],
    })

    assert.deepEqual(Object.keys(walked.entries), [])
    assert.deepEqual(walked.coverage.excludedDirs, ['node_modules'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('收窄到目录：目录下的文件都会被记录（不是只看目录本身）', async () => {
  const root = await tempRoot()
  try {
    await mkdir(path.join(root, 'sub'), { recursive: true })
    await writeFile(path.join(root, 'sub', 'x.txt'), 'x', 'utf8')
    await writeFile(path.join(root, 'sub', 'y.txt'), 'y', 'utf8')
    await writeFile(path.join(root, 'outside.txt'), 'o', 'utf8')

    const walked = await walkTree({
      root,
      excludes: new Set(['node_modules']),
      maxFileBytes: 10 * 1024 * 1024,
      only: ['sub'],
    })

    assert.deepEqual(Object.keys(walked.entries).sort(), ['sub/x.txt', 'sub/y.txt'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('收窄到不存在的路径：不报错，条目为空（删除场景由 diff 体现）', async () => {
  const root = await tempRoot()
  try {
    const walked = await walkTree({
      root,
      excludes: new Set(),
      maxFileBytes: 10 * 1024 * 1024,
      only: ['never-existed.txt'],
    })
    assert.deepEqual(Object.keys(walked.entries), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
