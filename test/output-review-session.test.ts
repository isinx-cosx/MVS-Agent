/**
 * 输出审核的端到端：**真的跑一个会话**。
 *
 * 这一组不是单元测试 —— 它证明的是三件只有在真会话里才成立的事：
 *
 *   1. 模型看到的是**打码版**（工具结果在进消息之前就被改写）
 *   2. **事件日志里没有原文**（一旦写进去就已经在投影/界面/重放里了）
 *   3. 那个路径被记成 taint，**之后的修改会被拒**（模型没看过原文就不许盲改）
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { TaintStore } from '../src/guard/review.ts'
import { Policy } from '../src/policy/policy.ts'
import { RecoveryGuard } from '../src/recovery/guard.ts'
import { RecoveryManager } from '../src/recovery/manager.ts'
import { SessionStore } from '../src/host/persistence.ts'
import { Session } from '../src/host/session.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import type { ModelEvent } from '../src/model/types.ts'

const SECRET = 'sk-realsecretvalue123456'

type Step = { tool: { name: string; args: Record<string, unknown> } } | { say: string }

interface HarnessOptions {
  /**
   * 脚本化模型按顺序消费的回合：`{ tool }` 调一次工具，`{ say }` 直接收尾。
   *
   * 一条用户消息 → 模型的一次 stream 调用；工具调用之后模型会被再问一次，
   * 所以「读一次然后收尾」是两回合。
   */
  steps: Step[]
  files?: Record<string, string>
}

interface Harness {
  root: string
  session: Session
  taint: TaintStore
  events: () => Promise<string>
}

async function withSession(
  options: HarnessOptions,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-gate-'))
  await mkdir(path.join(root, '.mvs'), { recursive: true })
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }

  const store = new SessionStore(path.join(root, '.mvs', 'sess'), 's1')
  await store.init()
  const recovery = new RecoveryManager({
    root,
    storeDir: path.join(root, '.mvs', 'rec'),
    excludes: ['.git'],
    maxTransactions: 5,
  })
  await recovery.init()
  const registry = createDefaultRegistry()

  let turn = 0
  const model = {
    stream(): AsyncIterable<ModelEvent> {
      const step = options.steps[turn] ?? { say: '好了' }
      turn += 1
      const events: ModelEvent[] = []
      if ('tool' in step) {
        events.push({
          type: 'tool_call_delta',
          index: 0,
          id: `c${turn}`,
          name: step.tool.name,
          argsJsonDelta: JSON.stringify(step.tool.args),
        })
        events.push({ type: 'done', reason: 'tool_calls' })
      } else {
        events.push({ type: 'text_delta', text: step.say })
        events.push({ type: 'done', reason: 'stop' })
      }
      return (async function* generate() {
        for (const event of events) yield event
      })()
    },
  }

  const taint = TaintStore.forWorkspace(root)
  const session = new Session({
    sessionId: 's1',
    workspace: root,
    model,
    modelName: 'test',
    registry,
    policy: new Policy({ mode: 'workspace-write' }),
    executor: new RecoveryGuard(registry, recovery),
    store,
    taint,
  })
  await session.init()

  try {
    await fn({
      root,
      session,
      taint,
      events: () => readFile(path.join(root, '.mvs', 'sess', 'events.jsonl'), 'utf8'),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** 从事件日志里取所有 tool_settled 的正文 */
function settledContents(raw: string): string[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { event?: { type?: string; content?: string } })
    .filter((item) => item.event?.type === 'tool_settled')
    .map((item) => item.event?.content ?? '')
}

test('闸门：读含密钥的文件 → 模型看到打码、日志里没有原文、路径进 taint', async () => {
  await withSession(
    {
      files: { 'config.txt': `api_key = '${SECRET}'\nother = 1\n` },
      steps: [{ tool: { name: 'read_file', args: { path: 'config.txt' } } }, { say: '好了' }],
    },
    async ({ session, taint, events }) => {
      await session.sendUserMessage('看看 config.txt')

      const raw = await events()
      assert.equal(raw.includes(SECRET), false, '事件日志里不能出现原文')

      const contents = settledContents(raw)
      assert.equal(contents.length, 1)
      assert.match(contents[0]!, /输出审核/)
      assert.match(contents[0]!, /已扣留/)

      const record = await taint.has('config.txt')
      assert.ok(record !== undefined, 'taint 必须记下这个路径')
      assert.equal(record.category, 'api-key')
    },
  )
})

test('闸门：taint 之后改这个文件被拒（模型没看过原文，不许盲改）', async () => {
  await withSession(
    {
      files: { 'config.txt': `api_key = '${SECRET}'\n` },
      steps: [
        { tool: { name: 'read_file', args: { path: 'config.txt' } } },
        { tool: { name: 'write_file', args: { path: 'config.txt', content: 'x' } } },
        { say: '好' },
      ],
    },
    async ({ session, root, events }) => {
      await session.sendUserMessage('看看并改成 x')

      assert.equal(
        await readFile(path.join(root, 'config.txt'), 'utf8'),
        `api_key = '${SECRET}'\n`,
        '文件不能被盲改',
      )

      const contents = settledContents(await events())
      assert.equal(contents.length, 2, '读一次 + 写一次（被拒）')
      assert.match(contents[1]!, /tainted_path/)
      assert.match(contents[1]!, /没有看过它/)
    },
  )
})

test('闸门：敏感路径整份扣留（.env 不靠内容匹配）', async () => {
  await withSession(
    {
      files: { '.env': 'LOOKS_HARMLESS=yes\n' },
      steps: [{ tool: { name: 'read_file', args: { path: '.env' } } }, { say: '好了' }],
    },
    async ({ session, taint, events }) => {
      await session.sendUserMessage('看 .env')
      const contents = settledContents(await events())
      assert.match(contents[0]!, /整份输出已扣留/)
      assert.equal(contents[0]!.includes('LOOKS_HARMLESS'), false)
      assert.ok((await taint.has('.env')) !== undefined)
    },
  )
})

test('闸门：普通文件不受影响（原文照旧、不记 taint）', async () => {
  await withSession(
    {
      files: { 'a.txt': 'hello\nworld\n' },
      steps: [{ tool: { name: 'read_file', args: { path: 'a.txt' } } }, { say: '好了' }],
    },
    async ({ session, taint, events }) => {
      await session.sendUserMessage('读一下')
      const contents = settledContents(await events())
      /* read_file 原样返回文件内容（含末尾换行） */
      assert.equal(contents[0], 'hello\nworld\n')
      assert.equal(await taint.has('a.txt'), undefined)
    },
  )
})

test('闸门：clear 之后可以改（阻塞态必须有出口）', async () => {
  await withSession(
    {
      files: { 'a.txt': 'hello\n' },
      steps: [{ tool: { name: 'read_file', args: { path: 'a.txt' } } }, { say: '好了' }],
    },
    async ({ taint, root }) => {
      await taint.add('a.txt', 'api-key', '测试用')
      assert.ok((await taint.has('a.txt')) !== undefined)

      assert.equal(await taint.clear('a.txt'), true)
      assert.equal(await taint.has('a.txt'), undefined)
      /* 清掉之后文件本身没被动过 */
      assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'hello\n')
    },
  )
})
