/**
 * 护栏的收尾三件：死循环提示、日志精简、事后审计。
 *
 * 三件都不是"更强的防护"，而是**把已经发生的事说清楚**：
 *
 *   · 死循环提示：告诉模型"这看起来会一直跑"，但不拦
 *   · 日志精简：删正文、留摘要、留报告（降级必须可见）
 *   · 事后审计：一条命令删了文件，如实说明并能补回
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { isScriptPath, lintTightLoops, loopWarningNote } from '../src/tools/loop-lint.ts'
import { cleanupTempDirs, trimSessionLog } from '../src/host/log-maintenance.ts'
import { RecoveryManager } from '../src/recovery/manager.ts'

/* ── 死循环提示 ───────────────────────────────────────────────────────── */

test('死循环：while(true) 里没有让出点 → 提醒', () => {
  const warnings = lintTightLoops('while (true) { x += 1 }')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!.message, /紧循环/)
})

test('死循环：有 await / sleep 就不提醒（那可能是正常的长驻程序）', () => {
  assert.equal(lintTightLoops('while (true) { await tick() }').length, 0)
  assert.equal(lintTightLoops('while (true) { sleep(1) }').length, 0)
  assert.equal(lintTightLoops('setInterval(() => poll(), 1000)').length, 0)
})

test('死循环：巨大的 for 边界单独提醒（不是死循环，但会跑很久）', () => {
  const warnings = lintTightLoops('for (let i = 0; i < 100000000; i++) { total += i }')
  assert.ok(warnings.some((w) => /上限很大/.test(w.message)))
})

test('死循环：普通代码一声不响', () => {
  assert.deepEqual(lintTightLoops('const a = 1\nfor (const x of items) { sum(x) }'), [])
  assert.equal(loopWarningNote('const a = 1'), null)
})

test('死循环：只看脚本文件（普通文本不提示）', () => {
  assert.equal(isScriptPath('a.js'), true)
  assert.equal(isScriptPath('a.ts'), true)
  assert.equal(isScriptPath('script.py'), true)
  assert.equal(isScriptPath('README.md'), false)
  assert.equal(isScriptPath('data.json'), false)
})

/* ── 日志精简 ─────────────────────────────────────────────────────────── */

function envelope(seq: number, event: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: 's1', seq, at: '2026-01-01T00:00:00.000Z', event })
}

test('日志精简：只删大正文，保留 summary 与其它事件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-trim-'))
  try {
    const big = 'x'.repeat(20_000)
    const lines = [
      envelope(1, { type: 'session_started', workspace: '/w', model: 'm', mode: 'workspace-write' }),
      envelope(2, { type: 'tool_settled', callId: 'c1', tool: 'grep', ok: true, content: big, summary: '一次很大的 grep' }),
      envelope(3, { type: 'tool_settled', callId: 'c2', tool: 'read_file', ok: true, content: 'small', summary: '小输出' }),
    ]
    await writeFile(path.join(dir, 'events.jsonl'), `${lines.join('\n')}\n`, 'utf8')

    const report = await trimSessionLog(dir, { maxBodyBytes: 1024 })
    assert.ok(report !== null)
    assert.equal(report!.trimmed.length, 1)
    assert.ok(report!.bytesFreed > 10_000)

    const after = await readFile(path.join(dir, 'events.jsonl'), 'utf8')
    assert.match(after, /输出已清理/)
    assert.match(after, /一次很大的 grep/, 'summary 必须留着')
    assert.match(after, /"content":"small"/, '小输出不被动')
    assert.equal(after.includes(big), false)

    /* 报告落盘：清理本身要可审计 */
    const reportFile = JSON.parse(await readFile(path.join(dir, 'trim-report.json'), 'utf8')) as {
      trimmed: number[]
    }
    assert.deepEqual(reportFile.trimmed, [2])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('日志精简：没有需要改的就**不写文件**（避免无意义地动 mtime）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-trim-'))
  try {
    const file = path.join(dir, 'events.jsonl')
    await writeFile(
      file,
      `${envelope(1, { type: 'tool_settled', callId: 'c1', tool: 'read_file', ok: true, content: 'small', summary: 's' })}\n`,
      'utf8',
    )
    const before = (await stat(file)).mtimeMs
    assert.equal(await trimSessionLog(dir, { maxBodyBytes: 1024 }), null)
    assert.equal((await stat(file)).mtimeMs, before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('日志精简：坏行原样保留（"日志有损坏"这件事要继续可见）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-trim-'))
  try {
    const file = path.join(dir, 'events.jsonl')
    await writeFile(
      file,
      `{ 不是 JSON\n${envelope(2, { type: 'tool_settled', callId: 'c1', tool: 'grep', ok: true, content: 'y'.repeat(5000), summary: 's' })}\n`,
      'utf8',
    )
    await trimSessionLog(dir, { maxBodyBytes: 1024 })
    const after = await readFile(file, 'utf8')
    assert.match(after, /不是 JSON/)
    assert.match(after, /输出已清理/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('临时目录清理：只删过期的 mvs-* 目录', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-temp-'))
  try {
    const oldDir = path.join(dir, 'mvs-old')
    const newDir = path.join(dir, 'mvs-new')
    const other = path.join(dir, 'keep-me')
    for (const p of [oldDir, newDir, other]) await mkdir(p, { recursive: true })

    const longAgo = new Date(Date.now() - 48 * 3600_000)
    await utimes(oldDir, longAgo, longAgo)

    const removed = await cleanupTempDirs(dir, 24)
    assert.deepEqual(removed, ['mvs-old'])
    assert.equal((await readdir(dir)).sort().join(','), 'keep-me,mvs-new')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ── 事后审计 ─────────────────────────────────────────────────────────── */

test('restorePaths：只补被删的文件，不动修改过的', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-audit-'))
  try {
    await writeFile(path.join(root, 'keep.txt'), 'original', 'utf8')
    await writeFile(path.join(root, 'gone.txt'), '要被删掉', 'utf8')

    const manager = new RecoveryManager({
      root,
      storeDir: path.join(root, 'rec'),
      excludes: ['.git'],
      maxTransactions: 5,
    })
    await manager.init()

    const pending = await manager.begin({ tool: 'run_command' })
    /* 命令：改一个、删一个 */
    await writeFile(path.join(root, 'keep.txt'), 'changed', 'utf8')
    await rm(path.join(root, 'gone.txt'))
    const txn = await manager.commit(pending)
    assert.ok(txn !== null)
    assert.deepEqual(txn!.changes.removed, ['gone.txt'])
    assert.deepEqual(txn!.changes.modified, ['keep.txt'])

    const fixed = await manager.restorePaths(txn!.id, txn!.changes.removed)
    assert.deepEqual(fixed.restored, ['gone.txt'])
    assert.equal(await readFile(path.join(root, 'gone.txt'), 'utf8'), '要被删掉')
    /* 关键：修改过的那份**不动** —— 自动兜底不该顺手撤掉正常改动 */
    assert.equal(await readFile(path.join(root, 'keep.txt'), 'utf8'), 'changed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
