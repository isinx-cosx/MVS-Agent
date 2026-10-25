/**
 * 逐行差异 + 会话搜索。
 *
 * ## 差异这块守三条边界
 *
 *   · 二进制不展开（逐行 diff 一张 PNG 是一屏乱码，比看不出来更糟）
 *   · 大文件不展开（两万行的 DP 表就是几 GB 内存）
 *   · 内容被回收时给 `contentGone`，**不是**一个"没有差异"的空结果
 *
 * ## 搜索这块守另外三条
 *
 *   · 搜的是**消息**（折叠之后的句子），不是 token 碎片
 *   · 「搜不到」与「没搜完」必须能区分（`stats.truncated`）
 *   · 正则写错要报错，而不是"没有匹配"
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { diffText, looksBinary } from '../src/recovery/diff.ts'
import { compileMatcher, searchSessions, snippetAround } from '../src/host/search.ts'
import type { Message } from '../src/model/types.ts'

/* ── 差异 ─────────────────────────────────────────────────────────────── */

test('diff：改一行只产出一个小 hunk', () => {
  const before = Buffer.from('a\nb\nc\n', 'utf8')
  const after = Buffer.from('a\nB\nc\n', 'utf8')
  const result = diffText(before, after)
  assert.ok(result !== null)
  assert.equal(result.binary, false)
  assert.equal(result.added, 1)
  assert.equal(result.removed, 1)
  assert.equal(result.hunks.length, 1)
  const lines = result.hunks[0]!.lines
  assert.deepEqual(
    lines.map((line) => `${line.kind}:${line.text}`),
    ['context:a', 'del:b', 'add:B', 'context:c'],
  )
})

test('diff：新增文件 → 全是 add，旧侧 0 行', () => {
  const result = diffText(null, Buffer.from('x\ny\n', 'utf8'))
  assert.ok(result !== null)
  assert.equal(result.added, 2)
  assert.equal(result.removed, 0)
  assert.equal(result.hunks[0]!.oldLines, 0)
})

test('diff：删除文件 → 全是 del，新侧 0 行', () => {
  const result = diffText(Buffer.from('x\ny\n', 'utf8'), null)
  assert.ok(result !== null)
  assert.equal(result.removed, 2)
  assert.equal(result.hunks[0]!.newLines, 0)
})

test('diff：内容相同 → 没有 hunk（而不是一个空的 hunk）', () => {
  const same = Buffer.from('a\nb\n', 'utf8')
  const result = diffText(same, Buffer.from('a\nb\n', 'utf8'))
  assert.ok(result !== null)
  assert.deepEqual(result.hunks, [])
  assert.equal(result.added, 0)
  assert.equal(result.removed, 0)
})

test('diff：二进制被识别出来，不展开', () => {
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02])
  assert.equal(looksBinary(binary), true)
  const result = diffText(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x03]))
  assert.ok(result !== null)
  assert.equal(result.binary, true)
  assert.deepEqual(result.hunks, [])
})

test('diff：超过上限不展开，并说明是"太大"而不是"二进制"', () => {
  const big = Buffer.from('x'.repeat(200), 'utf8')
  const result = diffText(big, Buffer.from('y'.repeat(200), 'utf8'), { maxBytes: 100 })
  assert.ok(result !== null)
  assert.equal(result.tooLarge, true)
  assert.equal(result.binary, false)
})

test('diff：两侧都没有内容 → null（"内容没了"与"没有差异"是两件事）', () => {
  assert.equal(diffText(null, null), null)
})

test('diff：行号对得上（hunk 头指向正确的位置）', () => {
  const before = Buffer.from('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', 'utf8')
  const after = Buffer.from('1\n2\n3\n4\n5\n6\n7\n8\n9\nX\n', 'utf8')
  const result = diffText(before, after)
  assert.ok(result !== null)
  const hunk = result.hunks[0]!
  /* 改的是第 10 行，上下文 3 行 → 从第 7 行开始 */
  assert.equal(hunk.oldStart, 7)
  assert.equal(hunk.newStart, 7)
})

/* ── 搜索 ─────────────────────────────────────────────────────────────── */

function messagesOf(sessionId: string, texts: string[]): Message[] {
  return texts.map((text) => ({ role: 'user', content: text })) as Message[]
}

test('搜索：大小写不敏感，命中用户消息', async () => {
  const result = await searchSessions({
    sessions: [{ sessionId: 's1', title: '第一个', workspace: 'w', at: '2026-01-01' }],
    query: 'ECONNREFUSED',
    messages: async () => ({
      messages: [
        { role: 'user', content: '启动时报了 econnrefused' } as Message,
        { role: 'assistant', content: '看起来端口没起来' } as Message,
      ],
      events: 2,
    }),
  })
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.role, 'user')
  assert.match(result.matches[0]!.snippet, /\[econnrefused\]/)
})

test('搜索：也能命中助手与工具消息（工具输出是最常见的场景）', async () => {
  const result = await searchSessions({
    sessions: [{ sessionId: 's1', title: 't', workspace: 'w', at: '2026-01-01' }],
    query: 'permission denied',
    messages: async () => ({
      messages: [
        { role: 'assistant', content: 'permission denied 了' } as Message,
        { role: 'tool', content: 'stderr: permission denied\nmore' } as Message,
      ],
      events: 2,
    }),
  })
  assert.equal(result.matches.length, 2)
  assert.deepEqual(
    result.matches.map((hit) => hit.role),
    ['assistant', 'tool'],
  )
})

test('搜索：特殊字符当字面量（搜 "(" 不会变成正则错误）', async () => {
  const result = await searchSessions({
    sessions: [{ sessionId: 's1', title: 't', workspace: 'w', at: '2026-01-01' }],
    query: '(',
    messages: async () => ({ messages: [{ role: 'user', content: 'f(x) = 1' } as Message], events: 1 }),
  })
  assert.equal(result.matches.length, 1)
})

test('搜索：regex 模式写错 → 抛错（不是"没有匹配"）', () => {
  assert.throws(() => compileMatcher('([', true), /正则写错了/)
})

test('搜索：空查询 → 抛错', () => {
  assert.throws(() => compileMatcher('   '), /不能为空/)
})

test('搜索：limit 截断要在 stats 里说明', async () => {
  const sessions = Array.from({ length: 5 }, (_, index) => ({
    sessionId: `s${index}`,
    title: `t${index}`,
    workspace: 'w',
    at: '2026-01-01',
  }))
  const result = await searchSessions({
    sessions,
    query: 'hit',
    limit: 2,
    messages: async () => ({ messages: [{ role: 'user', content: 'hit here' } as Message], events: 1 }),
  })
  assert.equal(result.matches.length, 2)
  assert.match(result.stats.truncated ?? '', /命中已够/)
})

test('搜索：maxSessions 截断要在 stats 里说明扫了多少 / 一共多少', async () => {
  const sessions = Array.from({ length: 4 }, (_, index) => ({
    sessionId: `s${index}`,
    title: `t${index}`,
    workspace: 'w',
    at: '2026-01-01',
  }))
  const result = await searchSessions({
    sessions,
    query: 'nothing-here',
    maxSessions: 2,
    messages: async () => ({ messages: [{ role: 'user', content: 'zzz' } as Message], events: 1 }),
  })
  assert.equal(result.matches.length, 0)
  assert.equal(result.stats.sessions, 2)
  assert.equal(result.stats.sessionsAvailable, 4)
  assert.match(result.stats.truncated ?? '', /只扫了最近 2 个会话/)
})

test('搜索：某个会话读失败 → 跳过它，整次搜索不失败', async () => {
  const result = await searchSessions({
    sessions: [
      { sessionId: 'bad', title: 'bad', workspace: 'w', at: '2026-01-02' },
      { sessionId: 'good', title: 'good', workspace: 'w', at: '2026-01-01' },
    ],
    query: 'needle',
    messages: async (sessionId) => {
      if (sessionId === 'bad') throw new Error('日志坏了')
      return { messages: [{ role: 'user', content: 'a needle here' } as Message], events: 1 }
    },
  })
  assert.equal(result.matches.length, 1)
  assert.equal(result.matches[0]!.sessionId, 'good')
})

test('搜索：片段里命中处被方括号标出来，前后有上下文', () => {
  const text = 'x'.repeat(100) + 'NEEDLE' + 'y'.repeat(100)
  const snippet = snippetAround(text, [[100, 106]])
  assert.match(snippet, /\[NEEDLE\]/)
  assert.ok(snippet.startsWith('…'), '截断处要有省略号')
  assert.ok(snippet.endsWith('…'))
})

test('搜索：空白的折叠不影响命中位置', () => {
  const text = 'a\n\n\nNEEDLE\n\n\nb'
  const at = text.indexOf('NEEDLE')
  const snippet = snippetAround(text, [[at, at + 6]])
  assert.match(snippet, /\[NEEDLE\]/)
})

/* 一个端到端的小检查：真实的日志目录 → 能搜到（不经过 HTTP） */
test('搜索：真的从 events.jsonl 里捞出内容', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-search-'))
  try {
    const { SessionStore } = await import('../src/host/persistence.ts')
    const dir = path.join(base, 'sess', 's1')
    await mkdir(dir, { recursive: true })
    const store = new SessionStore(dir, 's1')
    await store.init()
    await store.append({ type: 'turn_started', turn: 1, input: '帮我看看为什么 ECONNREFUSED' })
    await store.append({ type: 'assistant_message', text: '端口没起来', toolCalls: [] })

    const result = await searchSessions({
      sessions: [{ sessionId: 's1', title: 't', workspace: base, at: '2026-01-01' }],
      query: 'econnrefused',
      messages: async () => {
        const probe = new SessionStore(dir, 's1')
        const { items } = await probe.readEvents()
        const { rebuildMessages } = await import('../src/protocol/projection.ts')
        return { messages: rebuildMessages(items.map((item) => item.event)), events: items.length }
      },
    })
    assert.equal(result.matches.length, 1)
    assert.equal(result.matches[0]!.role, 'user')
    assert.ok(result.stats.events >= 2, `应当扫到事件，实际 ${result.stats.events}`)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
