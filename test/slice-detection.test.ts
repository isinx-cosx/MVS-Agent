/**
 * 分片读取检测：防**逐位重建**。
 *
 * 攻击形态：一次读 1 行，读 20 次，把整个文件"问"出来。每一次单独看都完全正常 ——
 * 没有密钥模式命中、路径也不敏感，所以单次判据一条都不会响。
 *
 * 这里验三件事：
 *   1. 正常读一次不会触发
 *   2. 反复窄切片、累计覆盖过半 → 告警 + 降级成元信息
 *   3. 降级之后同文件只回字节数与行数
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { Policy } from '../src/policy/policy.ts'
import { RecoveryGuard } from '../src/recovery/guard.ts'
import { RecoveryManager } from '../src/recovery/manager.ts'
import { SessionStore } from '../src/host/persistence.ts'
import { Session } from '../src/host/session.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import { TaintStore } from '../src/guard/review.ts'
import type { ModelEvent } from '../src/model/types.ts'

type Step = { tool: { name: string; args: Record<string, unknown> } } | { say: string }

/** 10 行文件，每行内容不同 —— 便于按 offset/limit 切 */
const TEN_LINES = Array.from({ length: 10 }, (_, index) => `line-${index}`).join('\n')

async function withSession(
  steps: Step[],
  fn: (h: { session: Session; taint: TaintStore; events: () => Promise<string> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-slice-'))
  await mkdir(path.join(root, '.mvs'), { recursive: true })
  await writeFile(path.join(root, 'big.txt'), TEN_LINES, 'utf8')

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
      const step = steps[turn] ?? { say: '好了' }
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
      session,
      taint,
      events: () => readFile(path.join(root, '.mvs', 'sess', 'events.jsonl'), 'utf8'),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function settledContents(raw: string): string[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { event?: { type?: string; content?: string } })
    .filter((item) => item.event?.type === 'tool_settled')
    .map((item) => item.event?.content ?? '')
}

test('分片读取：正常读一次不触发告警', async () => {
  await withSession([{ tool: { name: 'read_file', args: { path: 'big.txt' } } }, { say: '好' }], async ({ session, events }) => {
    await session.sendUserMessage('看 big.txt')
    const raw = await events()
    assert.equal(raw.includes('分片读取告警'), false)
    assert.match(settledContents(raw)[0] ?? '', /line-0/)
  })
})

test('分片读取：窄切片读 5 次、覆盖过半 → 告警并降级成元信息', async () => {
  const steps: Step[] = []
  /* 每次读 2 行：10 行文件，5 次即覆盖全部 */
  for (let index = 0; index < 5; index += 1) {
    steps.push({ tool: { name: 'read_file', args: { path: 'big.txt', offset: index * 2 + 1, limit: 2 } } })
  }
  steps.push({ tool: { name: 'read_file', args: { path: 'big.txt' } } })
  steps.push({ say: '好' })

  await withSession(steps, async ({ session, taint, events }) => {
    await session.sendUserMessage('逐段看 big.txt')
    const raw = await events()
    assert.match(raw, /分片读取告警/, '应当留下告警事件')

    const contents = settledContents(raw)
    const last = contents.at(-1) ?? ''
    assert.match(last, /内容未返回/, '降级后应当只给元信息')
    assert.equal(last.includes('line-0'), false, '降级后不该再给内容')

    assert.ok((await taint.has('big.txt')) !== undefined, '应当进 taint，后续写入也被拦')
  })
})
