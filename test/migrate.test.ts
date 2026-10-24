/**
 * 迁移机制 + 三处落盘数据的版本语义。
 *
 * 这一组测试守的是「**换代时数据不会悄悄丢**」：
 *
 *   · 版本更旧 → 按注册的迁移升上来
 *   · 版本更新 → **拒绝**（不是"尽力解析"）
 *   · 缺迁移步骤 → 报错（不是假装升好了）
 *   · 迁移函数忘了推进版本 → 当场报错
 *   · state / config / checkpoint 三处接的是同一套语义
 *
 * ⚠️ 生产里的迁移表现在是**空的**（v1 就是当前版本）。所以这里用**注入式** registry
 * 造一条 v1→v2 的假迁移，把机制本身跑通 —— 否则这段代码在第一次真改字段之前
 * 完全没有被执行过，那等于没有。
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { migrate, readVersion, type Migration } from '../src/config/migrate.ts'
import { ConfigStore, normalizeConfig } from '../src/config/index.ts'
import { StateStore } from '../src/config/state.ts'
import { SessionStore } from '../src/host/persistence.ts'

/* ── 机制本身 ─────────────────────────────────────────────────────────── */

test('迁移：版本相同 → 原样返回，不做任何事', () => {
  const raw = { version: 2, name: 'x' }
  const result = migrate({ kind: 't', current: 2, raw, migrations: [] })
  assert.equal(result.data, raw)
  assert.deepEqual(result.applied, [])
  assert.equal(result.from, 2)
  assert.equal(result.to, 2)
})

test('迁移：缺 version → 当作 0，走迁移链', () => {
  const migrations: Migration[] = [
    {
      from: 0,
      describe: 'v0→v1：补上 name',
      apply: (data) => ({ ...(data as object), name: 'default', version: 1 }),
    },
  ]
  const result = migrate({ kind: 't', current: 1, raw: {}, migrations })
  assert.equal(result.from, 0)
  assert.equal(result.to, 1)
  assert.deepEqual(result.applied, ['v0→v1：补上 name'])
  assert.equal((result.data as { name: string }).name, 'default')
})

test('迁移：版本比程序新 → 抛错，消息里有两个版本号', () => {
  assert.throws(
    () => migrate({ kind: 'state', current: 1, raw: { version: 5 }, migrations: [] }),
    (err: Error) => {
      assert.equal(err.name, 'DataTooNewError')
      assert.match(err.message, /5/)
      assert.match(err.message, /1/)
      assert.match(err.message, /更新版本写的/)
      return true
    },
  )
})

test('迁移：缺对应步骤 → 报错，不假装升级成功', () => {
  assert.throws(
    () => migrate({ kind: 'state', current: 3, raw: { version: 1 }, migrations: [] }),
    /缺少 v1 → v2 的迁移/,
  )
})

test('迁移：函数忘了推进 version → 当场报错，并指出是哪一条', () => {
  const migrations: Migration[] = [
    { from: 1, describe: '忘了写版本', apply: (data) => ({ ...(data as object) }) },
  ]
  assert.throws(
    () => migrate({ kind: 't', current: 2, raw: { version: 1 }, migrations }),
    /忘了写版本/,
  )
})

test('迁移：v1 → v2 的假迁移能改名一个字段，并把版本推到 2', () => {
  const migrations: Migration[] = [
    {
      from: 1,
      describe: 'v1→v2：model 从字符串升级成对象',
      apply: (data) => {
        const source = data as { version: number; model?: string }
        return {
          ...source,
          version: 2,
          model: typeof source.model === 'string' ? { model: source.model } : source.model,
        }
      },
    },
  ]
  const result = migrate({ kind: 't', current: 2, raw: { version: 1, model: 'qwen' }, migrations })
  assert.deepEqual(result.applied, ['v1→v2：model 从字符串升级成对象'])
  assert.deepEqual(result.data, { version: 2, model: { model: 'qwen' } })
})

test('readVersion：非数字 / 负数 / 小数都当 0', () => {
  assert.equal(readVersion({ version: '2' }), 0)
  assert.equal(readVersion({ version: -1 }), 0)
  assert.equal(readVersion({ version: 1.5 }), 0)
  assert.equal(readVersion(null), 0)
  assert.equal(readVersion([1]), 0)
})

/* ── state.json ───────────────────────────────────────────────────────── */

async function tempDir(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), 'mvs-migrate-'))
}

test('state：版本比程序新 → load 直接拒绝，**并且不动原文件**', async () => {
  const dir = await tempDir()
  const file = path.join(dir, 'state.json')
  const original = JSON.stringify({ version: 99, workspaces: [{ path: 'C:\\w' }], sessions: [] })
  try {
    await writeFile(file, original, 'utf8')
    const store = new StateStore(dir)
    await assert.rejects(() => store.load(), /state\.json 无法使用/)
    /* 关键：拒绝之后文件必须原样还在，否则"拒绝启动"就变成了"顺带把数据删了" */
    assert.equal(await readFile(file, 'utf8'), original)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('state：当前版本正常读，不产生备份文件', async () => {
  const dir = await tempDir()
  try {
    await writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify({ version: 1, workspaces: [], sessions: [], audit: [] }),
      'utf8',
    )
    const store = new StateStore(dir)
    const loaded = await store.load()
    assert.deepEqual(loaded.warnings, [])
    const files = await readdir(dir)
    assert.equal(
      files.some((name) => name.includes('backup')),
      false,
      `不该有备份：${files.join(', ')}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('state：坏文件仍然是"备份后重置"（这条路没被迁移改动）', async () => {
  const dir = await tempDir()
  try {
    await writeFile(path.join(dir, 'state.json'), '{ 不是 JSON', 'utf8')
    const store = new StateStore(dir)
    const loaded = await store.load()
    assert.equal(loaded.state.workspaces.length, 0)
    assert.match(loaded.warnings.join('\n'), /已备份/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ── config.json ──────────────────────────────────────────────────────── */

test('config：版本比程序新 → normalizeConfig 抛 DataTooNewError', () => {
  assert.throws(
    () => normalizeConfig({ version: 99, model: { model: 'x' } }),
    (err: Error) => err.name === 'DataTooNewError',
  )
})

test('config：版本比程序新 → ConfigStore.load 拒绝（消息里带文件路径）', async () => {
  const dir = await tempDir()
  try {
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ version: 99 }), 'utf8')
    const store = new ConfigStore(dir)
    await assert.rejects(() => store.load(), /配置文件无法使用/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('config：server.requireToken 读得出来', () => {
  const on = normalizeConfig({ version: 1, server: { requireToken: true } })
  assert.equal(on.config.server?.requireToken, true)

  const off = normalizeConfig({ version: 1, server: { requireToken: false } })
  assert.equal(off.config.server?.requireToken, false)
})

test('config：server.requireToken 写错类型 → 忽略并警告（默认是"要求"）', () => {
  const result = normalizeConfig({ version: 1, server: { requireToken: 'false' } })
  assert.equal(result.config.server?.requireToken, undefined)
  assert.match(result.warnings.join('\n'), /requireToken 必须是 true 或 false/)
})

/* ── checkpoint ───────────────────────────────────────────────────────── */

test('checkpoint：版本不符 → 返回 null，**并且带一条说明**（不是静默）', async () => {
  const dir = await tempDir()
  try {
    const store = new SessionStore(dir, 'ses-test')
    await store.init()
    await writeFile(
      path.join(dir, 'checkpoint.json'),
      JSON.stringify({ version: 99, eventsSeen: 3, turn: 1, step: 0 }),
      'utf8',
    )
    const detailed = await store.readCheckpointDetailed()
    assert.equal(detailed.checkpoint, null)
    assert.match(detailed.warning ?? '', /检查点版本是 99/)

    /* 老的入口行为不变：null */
    assert.equal(await store.readCheckpoint(), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('checkpoint：半个 JSON → 也是 null + 说明', async () => {
  const dir = await tempDir()
  try {
    const store = new SessionStore(dir, 'ses-test')
    await store.init()
    await writeFile(path.join(dir, 'checkpoint.json'), '{"version":1,"eventsSe', 'utf8')
    const detailed = await store.readCheckpointDetailed()
    assert.equal(detailed.checkpoint, null)
    assert.match(detailed.warning ?? '', /一半/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
