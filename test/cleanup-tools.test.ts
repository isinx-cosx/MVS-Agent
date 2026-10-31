/**
 * 结构化的删除与移动。
 *
 * 这两个工具的存在理由不是"功能多一个"，而是**把改文件系统从 shell 里收回来**：
 * `rm` 拿不到路径围栏、拿不到可显示的影响面、也拿不到可撤销的事务。
 *
 * 所以这里测的也正是那三样：
 *   · 越界路径被拒（工作区外、`..`、根）
 *   · 影响面算得对（文件数、字节数）
 *   · 目录不给 `recursive` 就拒；`dryRun` 不真的删
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { deletePathsTool, movePathTool } from '../src/tools/cleanup-tools.ts'
import type { ToolContext } from '../src/tools/types.ts'

async function tempRoot(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'mvs-cleanup-'))
}

function ctx(root: string): ToolContext {
  return { root } as ToolContext
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

test('delete_paths：删文件，影响面与结果都要说清', async () => {
  const root = await tempRoot()
  try {
    await writeFile(path.join(root, 'a.txt'), '12345', 'utf8')
    const result = await deletePathsTool.run({ paths: ['a.txt'], why: '不再需要' }, ctx(root))

    assert.equal(result.ok, true, JSON.stringify(result.error))
    assert.equal(await exists(path.join(root, 'a.txt')), false)
    assert.match(result.content, /a\.txt/)
    assert.match(result.content, /可以撤销/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete_paths：目录不给 recursive 就拒绝（不接受默认递归）', async () => {
  const root = await tempRoot()
  try {
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'dist', 'x.js'), 'x', 'utf8')

    const refused = await deletePathsTool.run({ paths: ['dist'], why: '清理构建产物' }, ctx(root))
    assert.equal(refused.ok, false)
    assert.equal(refused.error?.kind, 'is_a_directory')
    assert.equal(await exists(path.join(root, 'dist')), true, '被拒绝时不能已经删了一半')

    const done = await deletePathsTool.run(
      { paths: ['dist'], why: '清理构建产物', recursive: true },
      ctx(root),
    )
    assert.equal(done.ok, true, JSON.stringify(done.error))
    assert.equal(await exists(path.join(root, 'dist')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete_paths：dryRun 只统计不删，统计要对', async () => {
  const root = await tempRoot()
  try {
    await mkdir(path.join(root, 'out', 'nested'), { recursive: true })
    await writeFile(path.join(root, 'out', 'a.txt'), '12345', 'utf8')
    await writeFile(path.join(root, 'out', 'nested', 'b.txt'), '123', 'utf8')

    const dry = await deletePathsTool.run(
      { paths: ['out'], why: '看看', recursive: true, dryRun: true },
      ctx(root),
    )
    assert.equal(dry.ok, true)
    const data = dry.data as { totalFiles: number; totalBytes: number; dryRun: boolean }
    assert.equal(data.dryRun, true)
    assert.equal(data.totalFiles, 2)
    assert.equal(data.totalBytes, 8)
    assert.equal(await exists(path.join(root, 'out')), true, 'dryRun 不能真的删')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete_paths：越界路径一律拒绝（工作区外 / .. / 根）', async () => {
  const root = await tempRoot()
  try {
    for (const bad of ['../outside.txt', path.join(path.parse(root).root, 'Windows'), '.']) {
      const result = await deletePathsTool.run({ paths: [bad], why: '试' }, ctx(root))
      assert.equal(result.ok, false, `${bad} 应当被拒`)
      assert.equal(result.error?.kind, 'outside_root', `${bad} 的错误类型`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete_paths：不存在的东西说"不存在"，不是静默成功', async () => {
  const root = await tempRoot()
  try {
    const result = await deletePathsTool.run({ paths: ['nope.txt'], why: '试' }, ctx(root))
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'not_found')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('delete_paths：一次最多 200 条', async () => {
  const root = await tempRoot()
  try {
    const many = Array.from({ length: 201 }, (_, index) => `f${index}.txt`)
    const result = await deletePathsTool.run({ paths: many, why: '太多' }, ctx(root))
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'invalid_args')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('move_path：改名成功，目标已存在时默认拒绝', async () => {
  const root = await tempRoot()
  try {
    await writeFile(path.join(root, 'a.txt'), 'A', 'utf8')
    await writeFile(path.join(root, 'b.txt'), 'B', 'utf8')

    const moved = await movePathTool.run({ from: 'a.txt', to: 'c.txt', why: '改名' }, ctx(root))
    assert.equal(moved.ok, true, JSON.stringify(moved.error))
    assert.equal(await exists(path.join(root, 'a.txt')), false)
    assert.equal(await exists(path.join(root, 'c.txt')), true)

    const clash = await movePathTool.run({ from: 'c.txt', to: 'b.txt', why: '覆盖试试' }, ctx(root))
    assert.equal(clash.ok, false)
    assert.equal(clash.error?.kind, 'already_exists')
    /* 覆盖被拒时两边都不能被改动 */
    assert.equal(await exists(path.join(root, 'c.txt')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('move_path：显式 overwrite 才覆盖；越界两端都拒', async () => {
  const root = await tempRoot()
  try {
    await writeFile(path.join(root, 'a.txt'), 'A', 'utf8')
    await writeFile(path.join(root, 'b.txt'), 'B', 'utf8')

    const over = await movePathTool.run(
      { from: 'a.txt', to: 'b.txt', why: '覆盖', overwrite: true },
      ctx(root),
    )
    assert.equal(over.ok, true, JSON.stringify(over.error))
    const items = await readdir(root)
    assert.ok(!items.includes('a.txt'))
    assert.equal(await (await import('node:fs/promises')).readFile(path.join(root, 'b.txt'), 'utf8'), 'A')

    const out = await movePathTool.run({ from: 'b.txt', to: '../x.txt', why: '越界' }, ctx(root))
    assert.equal(out.ok, false)
    assert.equal(out.error?.kind, 'outside_root')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
