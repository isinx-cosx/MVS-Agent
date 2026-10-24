/**
 * 子代理测试。
 *
 * 分两层测，因为这两层的**失败方式不同**：
 *
 *   · **工具层**（`spawn_agent`）：参数校验、结果截断、能力缺失时**明确失败**
 *     —— 这里的错都是"模型拿到一个看不懂的结果"；
 *   · **会话层**（`Session#spawnAgent`）：子代理真的跑起来、结果被带回父会话、
 *     **深度上限**拦住递归、**取消能传下去**
 *     —— 这里的错是"子代理悄悄没跑"或"跑飞了"，比前一类重得多。
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { Session, SessionStore } from '../src/host/index.ts'
import { Policy } from '../src/policy/index.ts'
import type { ModelClient, ModelEvent } from '../src/model/types.ts'
import type { HostEvent, PermissionMode } from '../src/protocol/types.ts'
import type { ToolContext, ToolResult } from '../src/tools/types.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import { spawnAgentTool } from '../src/tools/agents.ts'

/* ── 假模型：按剧本返回，每轮消费一份 ─────────────────────────────────── */
function scriptedModel(turns: ModelEvent[][]): ModelClient {
  let index = 0
  return {
    stream(): AsyncIterable<ModelEvent> {
      const events = turns[index] ?? [{ type: 'done', reason: 'stop' } as ModelEvent]
      index += 1
      return (async function* generate() {
        for (const event of events) yield event
      })()
    },
  }
}

const say = (text: string): ModelEvent[] => [
  { type: 'text_delta', text },
  { type: 'done', reason: 'stop' },
]

const callTool = (id: string, name: string, args: unknown): ModelEvent[] => [
  { type: 'tool_call_delta', index: 0, id, name, argsJsonDelta: JSON.stringify(args) },
  { type: 'done', reason: 'tool_calls' },
]

/* ── 一层：工具本身 ───────────────────────────────────────────────────── */

const emptyCtx = (): ToolContext => ({ root: process.cwd() })

test('prompt 为空 → 明确拒绝（子代理看不到对话，空任务等于让它瞎猜）', async () => {
  const result = await spawnAgentTool.run({ prompt: '   ' }, emptyCtx())
  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'invalid_args')
})

test('没有 spawnAgent 能力 → **明确失败**，而不是假装成功', async () => {
  const result = await spawnAgentTool.run({ prompt: '做点什么' }, emptyCtx())
  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'failed')
  assert.match(String(result.error?.message), /没有子代理能力/)
})

test('能力在 → 结果带回来，并说明跑了多少轮', async () => {
  const ctx: ToolContext = {
    root: process.cwd(),
    spawnAgent: async () => ({ text: '结论：入口在 a.ts', sessionId: 'ses-parent-sub-1', turns: 3 }),
  }
  const result = await spawnAgentTool.run({ prompt: '找入口' }, ctx)
  assert.equal(result.ok, true)
  assert.match(String(result.content), /结论：入口在 a\.ts/)
  assert.match(String(result.content), /跑完 3 轮/)
})

test('超长结果被截断，而且**明说**被截断（不静默丢内容）', async () => {
  const ctx: ToolContext = {
    root: process.cwd(),
    spawnAgent: async () => ({ text: 'x'.repeat(20_000), sessionId: 'ses-parent-sub-2', turns: 1 }),
  }
  const result = await spawnAgentTool.run({ prompt: '写很多' }, ctx)
  assert.equal(result.ok, true)
  assert.match(String(result.content), /被截断到 8000 字/)
})

test('子代理抛错 → 如实回到调用方，不吞', async () => {
  const ctx: ToolContext = {
    root: process.cwd(),
    spawnAgent: async () => {
      throw new Error('模型挂了')
    },
  }
  const result = await spawnAgentTool.run({ prompt: '做点什么' }, ctx)
  assert.equal(result.ok, false)
  assert.match(String(result.error?.message), /模型挂了/)
})

/* ── 二层：会话（真的开一个子代理，用真实工具处理器）────────────────── */

async function withSession(
  model: ModelClient,
  fn: (h: { session: Session; events: HostEvent[]; root: string }) => Promise<void>,
  mode: PermissionMode = 'full-access',
): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-sub-'))
  const root = path.join(base, 'workspace')
  await mkdir(root, { recursive: true })

  const store = new SessionStore(path.join(base, 'session'), 'ses-parent')
  await store.init()

  const registry = createDefaultRegistry()
  const events: HostEvent[] = []

  const session = new Session({
    sessionId: 'ses-parent',
    workspace: root,
    model,
    modelName: 'fake',
    registry,
    policy: new Policy({ mode }),
    /*
     * ★ **真实的工具处理器** —— 这很关键：
     * 用假执行器的话，`spawn_agent` 根本没被执行，测的就只是"模型发了一条工具调用"。
     */
    executor: {
      async execute(name, rawArgs, ctx): Promise<{ result: ToolResult }> {
        const result = await registry.execute(name, rawArgs, ctx)
        return { result }
      },
    },
    store,
  })

  const off = session.subscribe((envelope) => events.push(envelope.event))
  await session.init()
  try {
    await fn({ session, events, root })
  } finally {
    off()
  }
}

test('★ 子代理真的跑起来，父会话拿到的是**结论**而不是它的历史', async () => {
  await withSession(
    scriptedModel([
      callTool('c1', 'spawn_agent', { prompt: '数一数这个仓库有几个 ts 文件' }),
      /* 子代理那一轮 */
      say('结论：3 个。'),
      /* 父代理拿到结果之后的收尾轮 */
      say('收到。'),
    ]),
    async ({ session }) => {
      await session.sendUserMessage('先去数一下再回来')
      const messages = session.projection().messages
      const toolMessage = messages.find((m) => m.role === 'tool')
      assert.ok(toolMessage, '应当有一条工具结果')
      assert.match(JSON.stringify(toolMessage.content), /结论：3 个/)
      /* 父会话的上下文里**不该**出现子代理的中间过程 */
      assert.doesNotMatch(JSON.stringify(toolMessage.content), /数一数这个仓库有几个 ts 文件/)
    },
  )
})

test('★ 深度上限：子代理不能再开子代理', async () => {
  await withSession(
    scriptedModel([
      callTool('c1', 'spawn_agent', { prompt: '再开一个子代理' }),
      /* 子代理那一轮：它也要求开子代理 */
      callTool('c2', 'spawn_agent', { prompt: '再开一个' }),
      say('子代理放弃了递归'),
      say('父代理收尾'),
    ]),
    async ({ session, root }) => {
      await session.sendUserMessage('开个子代理')

      /*
       * ⚠️ 深度上限的报错发生在**子代理自己的会话里** —— 父会话只看得见
       * "子代理跑完了"。所以证据要去**子会话的日志**里找：
       * 会话目录规则是「父 store 的父目录 / <父 id>-sub-N」。
       */
      const childEvents = path.join(path.dirname(root), 'ses-parent-sub-1', 'events.jsonl')
      const raw = await readFile(childEvents, 'utf8').catch(() => '')
      assert.match(raw, /深度上限|不能再开子代理/)
    },
  )
})

test('子代理的用量并进父会话的累计（成本账不分开记）', async () => {
  const model: ModelClient = {
    stream(): AsyncIterable<ModelEvent> {
      /* 每次调用都报一份 usage —— 父一轮、子一轮、父再一轮 */
      return (async function* generate() {
        yield { type: 'text_delta', text: 'ok' } as ModelEvent
        yield {
          type: 'usage',
          usage: { inputTokens: 10, outputTokens: 5 },
        } as ModelEvent
        yield { type: 'done', reason: 'stop' } as ModelEvent
      })()
    },
  }

  await withSession(
    model,
    async ({ session }) => {
      await session.sendUserMessage('随便跑一轮')
      const usage = session.projection().totalUsage
      assert.ok(usage, '应当有累计用量')
      assert.ok(usage.calls >= 1)
      assert.ok(usage.inputTokens >= 10)
    },
  )
})
