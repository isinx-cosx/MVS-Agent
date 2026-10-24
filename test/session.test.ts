/**
 * 会话运行时测试。
 *
 * 重点在三件难事：
 *   1. **消息重建逐字一致** —— 否则 resume 之后模型看到的是另一段历史
 *   2. **中断的判定不猜** —— 有 intent 无 settled 时交给人，不假定执行过或没执行过
 *   3. **流式增量不落盘** —— 否则日志会被 token 撑爆，而恢复时又用不上
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { Session, SessionStore, type ToolExecutor } from '../src/host/index.ts'
import { Policy } from '../src/policy/index.ts'
import { okResult, type ToolResult } from '../src/tools/types.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import type { ModelClient, ModelEvent } from '../src/model/types.ts'
import type { HostEvent, PermissionMode } from '../src/protocol/types.ts'
import type { Envelope } from '../src/protocol/types.ts'
import os from 'node:os'


// ---------------------------------------------------------------------------
// 测试替身
// ---------------------------------------------------------------------------

/** 按剧本返回的假模型：每轮消费一份事件序列 */
function scriptedModel(turns: ModelEvent[][]): ModelClient {
  let index = 0
  return {
    stream(): AsyncIterable<ModelEvent> {
      const events: ModelEvent[] = turns[index] ?? [{ type: 'done', reason: 'stop' }]
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

const call = (id: string, name: string, args: unknown): ModelEvent[] => [
  { type: 'tool_call_delta', index: 0, id, name, argsJsonDelta: JSON.stringify(args) },
  { type: 'done', reason: 'tool_calls' },
]

interface RecordingExecutor extends ToolExecutor {
  calls: Array<{ name: string; rawArgs: unknown }>
}

function fakeExecutor(
  produce: (name: string) => ToolResult = () => okResult('已执行'),
  transactionId: string | undefined = 'txn-test',
): RecordingExecutor {
  const calls: Array<{ name: string; rawArgs: unknown }> = []
  return {
    calls,
    async execute(name, rawArgs) {
      calls.push({ name, rawArgs })
      return transactionId === undefined
        ? { result: produce(name) }
        : { result: produce(name), transactionId }
    },
  }
}

interface Harness {
  session: Session
  store: SessionStore
  root: string
  sessionDir: string
  executor: RecordingExecutor
  events: HostEvent[]
  policy: Policy
}

interface HarnessOptions {
  model: ModelClient
  mode?: PermissionMode
  executor?: RecordingExecutor
  maxSteps?: number
  interactive?: boolean
  policy?: Policy
}

async function withSession(
  options: HarnessOptions,
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  const root = path.join(base, 'workspace')
  const sessionDir = path.join(base, 'session')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(root, { recursive: true })

  try {
    const store = new SessionStore(sessionDir, 'ses-test')
    await store.init()

    const policy = options.policy ?? new Policy({ mode: options.mode ?? 'full-access' })
    const executor = options.executor ?? fakeExecutor()

    const session = new Session({
      sessionId: 'ses-test',
      workspace: root,
      model: options.model,
      modelName: 'test-model',
      registry: createDefaultRegistry(),
      policy,
      executor,
      store,
      maxSteps: options.maxSteps,
      interactive: options.interactive,
      system: 'system prompt',
    })

    const events: HostEvent[] = []
    session.subscribe((envelope: Envelope) => events.push(envelope.event))

    await session.init()
    await fn({ session, store, root, sessionDir, executor, events, policy })
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const typesOf = (events: HostEvent[]): string[] => events.map((e) => e.type)

// ---------------------------------------------------------------------------
// 基本循环
// ---------------------------------------------------------------------------

test('一轮纯文本：产生事件、检查点、可读投影', async () => {
  await withSession({ model: scriptedModel([say('你好')]) }, async ({ session, events }) => {
    await session.sendUserMessage('在吗')

    // 注意类型列表里包含实时的文本增量 —— 它不落盘，但对在线客户端可见
    assert.deepEqual(typesOf(events), [
      'session_started',
      'turn_started',
      'step_started',
      'model_text_delta',
      'assistant_message',
      'step_finished',
      'turn_finished',
    ])

    const projection = session.projection()
    assert.equal(projection.status, 'idle')
    assert.equal(projection.turn, 1)
    assert.equal(projection.step, 1)
    // system + user + assistant
    assert.equal(projection.messages.length, 3)
    assert.equal(projection.messages[2]?.content, '你好')
  })
})

/**
 * ★ 模型调用失败、一个字都没产出时，**不能**写空的 assistant 消息。
 *
 * 这条不是洁癖。空 assistant 消息会进历史，下一轮原样送给模型，而 OpenAI 兼容
 * 接口对 `{role:'assistant', content:''}`（且没有 tool_calls）是直接报错的 ——
 * 于是**一次网络抖动会让这段会话永久不可用**，而现象是「模型一直报错」，
 * 看起来像模型或 key 的问题，不像历史里埋了一条坏消息。
 */
test('★ 模型调用失败且无产出时不留空 assistant 消息（否则会永久毒化对话）', async () => {
  const failing: ModelClient = {
    stream() {
      return (async function* generate() {
        yield {
          type: 'error',
          error: { kind: 'network', message: 'socket hang up' },
        } satisfies ModelEvent
      })()
    },
  }

  await withSession({ model: failing }, async ({ session, events }) => {
    await session.sendUserMessage('在吗')

    assert.equal(
      typesOf(events).includes('assistant_message'),
      false,
      '什么都没产出就不该留下 assistant 消息 —— 那会让日志说「模型什么都没说」，而事实是调用失败了',
    )
    assert.ok(typesOf(events).includes('error'), '失败必须留下一条错误事件')

    const messages = session.projection().messages
    assert.deepEqual(
      messages.map((m) => m.role),
      ['system', 'user'],
      '历史里只该有 system 和 user —— 空的 assistant 会在下一轮被送给模型并触发接口报错',
    )
    assert.equal(
      messages.some((m) => m.role === 'assistant' && (m.content ?? '') === ''),
      false,
    )
  })
})

test('模型调用失败但吐了一半文本时，那半截必须留下', async () => {
  // 判据是「失败**且**毫无产出」。半截文本是真实产出，而且上层要能区分
  // 「没开始」和「吐了一半」—— 丢掉它就等于丢了那次调用的全部证据。
  const halfFailing: ModelClient = {
    stream() {
      return (async function* generate() {
        yield { type: 'text_delta', text: '说了一半' } satisfies ModelEvent
        yield {
          type: 'error',
          error: { kind: 'network', message: 'socket hang up' },
        } satisfies ModelEvent
      })()
    },
  }

  await withSession({ model: halfFailing }, async ({ session, events }) => {
    await session.sendUserMessage('在吗')

    assert.ok(typesOf(events).includes('assistant_message'), '半截文本要留下')
    const assistant = session.projection().messages.find((m) => m.role === 'assistant')
    assert.equal(assistant?.content, '说了一半')
    assert.ok(typesOf(events).includes('error'))
  })
})

test('工具调用：intent 先于 settled，且消息数组形状正确', async () => {  await withSession(
    {
      model: scriptedModel([
        call('call_1', 'write_file', { path: 'a.txt', content: 'hi' }),
        say('写完了'),
      ]),
    },
    async ({ session, events, executor }) => {
      await session.sendUserMessage('写个文件')

      const seq = typesOf(events)
      const intentAt = seq.indexOf('tool_intent')
      const settledAt = seq.indexOf('tool_settled')
      assert.ok(intentAt >= 0 && settledAt > intentAt, `intent 必须先于 settled：${seq.join(',')}`)

      assert.equal(executor.calls.length, 1)
      assert.equal(executor.calls[0]?.name, 'write_file')

      const messages = session.projection().messages
      // system, user, assistant(带 toolCalls), tool, assistant(最终)
      assert.equal(messages.length, 5)
      const assistant = messages[2]
      assert.ok(assistant !== undefined && assistant.role === 'assistant')
      if (assistant.role === 'assistant') {
        assert.equal(assistant.toolCalls?.[0]?.id, 'call_1')
        assert.equal(assistant.toolCalls?.[0]?.name, 'write_file')
      }
      const toolMessage = messages[3]
      assert.ok(toolMessage !== undefined && toolMessage.role === 'tool')
      if (toolMessage.role === 'tool') {
        assert.equal(toolMessage.toolCallId, 'call_1')
      }
    },
  )
})

test('恢复事务 id 随 tool_settled 一起入日志，供 UI 直接撤销', async () => {
  await withSession(
    { model: scriptedModel([call('c1', 'write_file', { path: 'a.txt', content: 'x' }), say('好')]) },
    async ({ session, events }) => {
      await session.sendUserMessage('写个文件')

      const settled = events.find((e) => e.type === 'tool_settled')
      assert.ok(settled !== undefined && settled.type === 'tool_settled')
      if (settled.type === 'tool_settled') {
        assert.equal(settled.recoveryTxnId, 'txn-test')
      }
    },
  )
})

test('达到步数上限时停下并给出通知', async () => {
  await withSession(
    {
      model: scriptedModel([
        call('c1', 'read_file', { path: 'a.txt' }),
        call('c2', 'read_file', { path: 'a.txt' }),
        call('c3', 'read_file', { path: 'a.txt' }),
      ]),
      maxSteps: 2,
    },
    async ({ session, events }) => {
      await session.sendUserMessage('一直读')
      const notice = events.find((e) => e.type === 'notice')
      assert.ok(notice !== undefined && notice.type === 'notice')
      if (notice.type === 'notice') assert.equal(notice.code, 'step_limit')
      assert.equal(session.projection().step, 2)
    },
  )
})

// ---------------------------------------------------------------------------
// 策略接入
// ---------------------------------------------------------------------------

test('策略拒绝时不写 intent、不执行工具，但仍把结果回填给模型', async () => {
  await withSession(
    {
      model: scriptedModel([call('c1', 'run_command', { command: 'sudo rm -rf /' }), say('好的')]),
      mode: 'workspace-write',
    },
    async ({ session, events, executor }) => {
      await session.sendUserMessage('提权')

      assert.equal(executor.calls.length, 0, '被拒绝的工具不该被执行')
      assert.equal(typesOf(events).includes('tool_intent'), false, '被拒绝时不写 intent')

      const decision = events.find((e) => e.type === 'policy_decision')
      assert.ok(decision !== undefined && decision.type === 'policy_decision')
      if (decision.type === 'policy_decision') assert.equal(decision.decision, 'deny')

      const settled = events.find((e) => e.type === 'tool_settled')
      assert.ok(settled !== undefined && settled.type === 'tool_settled')
      if (settled.type === 'tool_settled') {
        assert.equal(settled.ok, false)
        assert.match(settled.content, /被策略拒绝/)
      }
    },
  )
})

test('策略要求确认时挂起，人拒绝后不执行', async () => {
  await withSession(
    {
      model: scriptedModel([call('c1', 'run_command', { command: 'npm test' }), say('好')]),
      mode: 'workspace-write',
    },
    async ({ session, events, executor }) => {
      const running = session.sendUserMessage('跑测试')

      // 等到出现审批请求
      const approval = await waitFor(events, 'approval_requested')
      assert.ok(approval !== undefined && approval.type === 'approval_requested')
      assert.equal(session.projection().status, 'awaiting-approval')

      if (approval.type === 'approval_requested') {
        assert.equal(session.resolveApproval(approval.approvalId, false), true)
      }
      await running

      assert.equal(executor.calls.length, 0, '人拒绝之后不该执行')
      assert.equal(typesOf(events).includes('tool_intent'), false)
      const resolved = events.find((e) => e.type === 'approval_resolved')
      assert.ok(resolved !== undefined && resolved.type === 'approval_resolved')
      if (resolved.type === 'approval_resolved') assert.equal(resolved.granted, false)
    },
  )
})

test('策略要求确认时挂起，人同意后才写 intent 并执行', async () => {
  await withSession(
    {
      model: scriptedModel([call('c1', 'run_command', { command: 'npm test' }), say('好')]),
      mode: 'workspace-write',
    },
    async ({ session, events, executor }) => {
      const running = session.sendUserMessage('跑测试')
      const approval = await waitFor(events, 'approval_requested')
      if (approval?.type === 'approval_requested') {
        assert.equal(session.resolveApproval(approval.approvalId, true), true)
      }
      await running

      assert.equal(executor.calls.length, 1)
      const seq = typesOf(events)
      // intent 必须在审批结论**之后** —— 否则「等人时崩溃」会被误报成状态未知
      assert.ok(
        seq.indexOf('approval_resolved') < seq.indexOf('tool_intent'),
        `intent 必须在审批之后：${seq.join(',')}`,
      )
    },
  )
})

test('无人可应答时不是挂起，而是直接拒绝', async () => {
  await withSession(
    {
      model: scriptedModel([call('c1', 'run_command', { command: 'npm test' }), say('好')]),
      mode: 'workspace-write',
      interactive: false,
    },
    async ({ session, events, executor }) => {
      await session.sendUserMessage('跑测试')

      assert.equal(typesOf(events).includes('approval_requested'), false, '不该假装问过了')
      assert.equal(executor.calls.length, 0)
      assert.equal(session.projection().status, 'idle')
    },
  )
})

// ---------------------------------------------------------------------------
// 抗疲劳熔断：可见 + 可复位
// ---------------------------------------------------------------------------

test('★ 抗疲劳命中要发事件、投影里看得到、而且有复位入口', async () => {
  // 这一条钉的是一类失败模式，不是一行代码：**一道能拦住但说不清、也解不开
  // 的锁，最终只会训练人去绕过它**。熔断器命中后，之后每次写和执行都会被降级
  // 成「要你确认」；如果界面上既没有原因也没有出口，用户唯一能做的就是重启进程
  // —— 而重启会把整套记账一起清掉，等于用绕行代替了设计。
  const policy = new Policy({ mode: 'workspace-write', fatigueConsecutive: 1 })

  await withSession(
    {
      model: scriptedModel([call('c1', 'run_command', { command: 'sudo rm -rf /' }), say('好')]),
      mode: 'workspace-write',
      policy,
    },
    async ({ session, events }) => {
      await session.sendUserMessage('提权')

      // ① 命中时要留下一条能看见的事件，且只说一次
      const paused = events.filter((e) => e.type === 'notice' && e.code === 'fatigue_paused')
      assert.equal(paused.length, 1, '熔断命中必须留下恰好一条事件')
      const notice = paused[0]
      assert.ok(notice !== undefined && notice.type === 'notice')
      assert.match(notice.message, /暂停自动放行/, '要说清发生了什么，而不只是「已熔断」')

      // ② 状态要能从投影读到 —— 界面靠它显示原因
      const fatigue = session.projection().fatigue
      assert.equal(fatigue.active, true)
      assert.ok(fatigue.totalBlocks >= 1)

      // ③ 复位入口必须存在，而且要如实回答
      assert.equal(await session.resetFatigue(), true)
      assert.equal(session.projection().fatigue.active, false)
      assert.ok(events.some((e) => e.type === 'notice' && e.code === 'fatigue_reset'))

      assert.equal(
        await session.resetFatigue(),
        false,
        '本来就没命中时要如实说「不需要」，而不是假装成功 —— 报成功下次真命中时用户就不信这个按钮了',
      )
    },
  )
})

test('抗疲劳：自动放行的操作也打断「连续被拦」的计数', async () => {
  // 只在被拦时记账，会让「连续 3 次」退化成「累计 3 次」。中间放过一堆正事的
  // 三次被拦，和连着三次撞墙，不是同一种信号。
  const policy = new Policy({ mode: 'full-access', fatigueConsecutive: 3 })

  await withSession(
    {
      model: scriptedModel([
        call('c1', 'run_command', { command: 'sudo rm -rf /' }), // 被拦
        call('c2', 'read_file', { path: 'a.txt' }), // 自动放行（读）
        call('c3', 'run_command', { command: 'sudo rm -rf /' }), // 被拦
        call('c4', 'read_file', { path: 'a.txt' }), // 自动放行
        call('c5', 'run_command', { command: 'sudo rm -rf /' }), // 被拦
        say('好'),
      ]),
      mode: 'full-access',
      policy,
      maxSteps: 8,
    },
    async ({ session }) => {
      await session.sendUserMessage('试试')

      assert.equal(
        policy.status().fatigued,
        false,
        '三次被拦之间都夹着成功放行，所以它们**不**是连续的 —— 这里不该熔断',
      )
      assert.equal(policy.status().consecutiveBlocks, 1, '只有最后一次被拦还算数')
    },
  )
})

// ---------------------------------------------------------------------------
// 恢复
// ---------------------------------------------------------------------------

test('恢复：有 intent 无 settled 时标记为中断，并拒绝继续', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    const store = new SessionStore(path.join(base, 'session'), 'ses-test')
    await store.init()

    // 手写一份「执行到一半就死了」的日志
    await store.append({ type: 'session_started', workspace: base, model: 'm', mode: 'full-access' })
    await store.append({ type: 'turn_started', turn: 1, input: '删掉它' })
    await store.append({ type: 'step_started', turn: 1, step: 1 })
    await store.append({ type: 'assistant_message', text: '', toolCalls: [{ id: 'c1', name: 'delete_file', argsJson: '{"path":"x"}' }] })
    await store.append({ type: 'tool_intent', callId: 'c1', tool: 'delete_file', argsJson: '{"path":"x"}' })
    // ← 没有 tool_settled：进程就是在这一步没的

    const session = new Session({
      sessionId: 'ses-recover',
      workspace: base,
      model: scriptedModel([say('继续')]),
      modelName: 'm',
      registry: createDefaultRegistry(),
      policy: new Policy({ mode: 'full-access' }),
      executor: fakeExecutor(),
      store,
    })

    const result = await session.init()
    assert.equal(result.resumed, true)
    assert.ok(
      result.warnings.some((w) => w.includes('没有结算')),
      `必须明确警告，实际：${JSON.stringify(result.warnings)}`,
    )

    const projection = session.projection()
    assert.equal(projection.status, 'interrupted')
    assert.deepEqual(projection.interruptedCall, {
      callId: 'c1',
      tool: 'delete_file',
      argsJson: '{"path":"x"}',
    })

    await assert.rejects(
      () => session.sendUserMessage('接着来'),
      /无法确定|未结算/,
      '状态未知时必须拒绝继续，而不是猜',
    )
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('恢复：人确认「没执行过」之后可以继续', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    const store = new SessionStore(path.join(base, 'session'), 'ses-test')
    await store.init()
    await store.append({ type: 'turn_started', turn: 1, input: 'x' })
    await store.append({ type: 'tool_intent', callId: 'c1', tool: 'read_file', argsJson: '{"path":"a"}' })

    const session = new Session({
      sessionId: 'ses-ack',
      workspace: base,
      model: scriptedModel([say('继续了')]),
      modelName: 'm',
      registry: createDefaultRegistry(),
      policy: new Policy({ mode: 'full-access' }),
      executor: fakeExecutor(),
      store,
    })
    await session.init()
    assert.equal(session.projection().status, 'interrupted')

    await session.acknowledgeInterrupted()
    assert.equal(session.projection().status, 'idle')
    assert.equal(session.projection().interruptedCall, null)

    await session.sendUserMessage('接着来')
    assert.equal(session.projection().status, 'idle')
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('恢复：检查点记录的条数多于日志时报警，而不是照常恢复', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    const dir = path.join(base, 'session')
    const store = new SessionStore(dir, 'ses-test')
    await store.init()
    await store.append({ type: 'turn_started', turn: 1, input: 'x' })

    // 伪造一个「看过 99 条」的检查点 —— 说明日志被截断过
    await writeFile(
      path.join(dir, 'checkpoint.json'),
      JSON.stringify({
        version: 1,
        sessionId: 's',
        workspace: base,
        model: 'm',
        mode: 'full-access',
        status: 'idle',
        turn: 1,
        step: 0,
        eventsSeen: 99,
        interruptedCall: null,
        pendingApproval: null,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    )

    const session = new Session({
      sessionId: 's',
      workspace: base,
      model: scriptedModel([]),
      modelName: 'm',
      registry: createDefaultRegistry(),
      policy: new Policy({ mode: 'full-access' }),
      executor: fakeExecutor(),
      store,
    })
    const result = await session.init()
    assert.ok(
      result.warnings.some((w) => w.includes('被截断')),
      `日志截断必须报警，实际：${JSON.stringify(result.warnings)}`,
    )
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('恢复：日志损坏行会被报告，不是静默跳过', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    const dir = path.join(base, 'session')
    const store = new SessionStore(dir, 'ses-test')
    await store.init()
    await store.append({ type: 'turn_started', turn: 1, input: 'x' })
    const { appendFile } = await import('node:fs/promises')
    await appendFile(store.eventsPath, '{这不是 JSON\n', 'utf8')

    const session = new Session({
      sessionId: 's',
      workspace: base,
      model: scriptedModel([]),
      modelName: 'm',
      registry: createDefaultRegistry(),
      policy: new Policy({ mode: 'full-access' }),
      executor: fakeExecutor(),
      store,
    })
    const result = await session.init()
    assert.ok(result.warnings.some((w) => w.includes('损坏')))
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

// ---------------------------------------------------------------------------
// resume 正确性：消息必须逐字一致
// ---------------------------------------------------------------------------

test('★ 重开会话后重建的消息数组与中断前逐字相同', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    const dir = path.join(base, 'session')
    const store = new SessionStore(dir, 'ses-test')
    await store.init()

    const first = new Session({
      sessionId: 's',
      workspace: base,
      model: scriptedModel([
        call('c1', 'write_file', { path: 'a.txt', content: '你好世界' }),
        say('已经写好了'),
      ]),
      modelName: 'm',
      registry: createDefaultRegistry(),
      policy: new Policy({ mode: 'full-access' }),
      executor: fakeExecutor(() => okResult('已创建 a.txt（12 字节）')),
      store,
      system: 'system prompt',
    })
    await first.init()
    await first.sendUserMessage('帮我写个文件')

    const before = first.projection().messages

    // 用一个全新的 Session 从同一个日志恢复（模拟进程重启）
    const reopened = new Session({
      sessionId: 's',
      workspace: base,
      model: scriptedModel([]),
      modelName: 'm',
      registry: createDefaultRegistry(),
      policy: new Policy({ mode: 'full-access' }),
      executor: fakeExecutor(),
      store,
      system: 'system prompt',
    })
    await reopened.init()
    const after = reopened.projection().messages

    assert.deepEqual(
      after,
      before,
      '重建出来的消息数组必须逐字相同 —— 否则 resume 之后模型看到的是另一段历史',
    )

    // 逐字段确认关键内容都在
    const toolMessage = after.find((m) => m.role === 'tool')
    assert.ok(toolMessage !== undefined && toolMessage.role === 'tool')
    if (toolMessage.role === 'tool') {
      assert.equal(toolMessage.content, '已创建 a.txt（12 字节）')
      assert.equal(toolMessage.toolCallId, 'c1')
    }
    const assistant = after.find((m) => m.role === 'assistant')
    assert.ok(assistant !== undefined && assistant.role === 'assistant')
    if (assistant.role === 'assistant') {
      assert.equal(assistant.toolCalls?.[0]?.argsJson, '{"path":"a.txt","content":"你好世界"}')
    }
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

// ---------------------------------------------------------------------------
// 落盘边界
// ---------------------------------------------------------------------------

test('流式增量不落盘：日志里不出现 token 级事件', async () => {
  await withSession(
    {
      model: scriptedModel([
        [
          { type: 'text_delta', text: '一' },
          { type: 'text_delta', text: '二' },
          { type: 'text_delta', text: '三' },
          { type: 'done', reason: 'stop' },
        ],
      ]),
    },
    async ({ session, store, events }) => {
      await session.sendUserMessage('说三个字')

      // 在线客户端看得到增量
      assert.equal(events.filter((e) => e.type === 'model_text_delta').length, 3)

      // 但日志里一条都没有
      const raw = await readFile(store.eventsPath, 'utf8')
      assert.equal(raw.includes('model_text_delta'), false, '增量会把日志撑爆，且恢复时没用')
      assert.equal(raw.includes('assistant_message'), true, '最终消息必须在日志里')
    },
  )
})

test('检查点小而恒定：不随历史增长', async () => {
  await withSession(
    {
      model: scriptedModel([
        call('c1', 'write_file', { path: 'a.txt', content: 'x'.repeat(2000) }),
        call('c2', 'write_file', { path: 'b.txt', content: 'y'.repeat(2000) }),
        say('好'),
      ]),
    },
    async ({ session, store }) => {
      await session.sendUserMessage('写两个大文件')

      const checkpoint = await readFile(store.checkpointPath, 'utf8')
      assert.ok(
        checkpoint.length < 1500,
        `检查点应该小而恒定，实际 ${checkpoint.length} 字节 —— 消息内容不该进来`,
      )
      assert.equal(checkpoint.includes('xxxx'), false, '检查点里不该有消息内容')
    },
  )
})

// ---------------------------------------------------------------------------

async function waitFor<T extends HostEvent['type']>(
  events: HostEvent[],
  type: T,
  timeoutMs = 3000,
): Promise<Extract<HostEvent, { type: T }> | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = events.find((e) => e.type === type)
    if (found !== undefined) return found as Extract<HostEvent, { type: T }>
    if (Date.now() > deadline) return undefined
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
