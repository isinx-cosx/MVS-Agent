/**
 * 上下文层测试。
 *
 * 最重要的一条是**压缩之后 resume 仍然一致** —— 这是这一层唯一容易出错、
 * 而且出错后极难定位的地方：只有重启一次、对比两份数组才能发现。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { compact, COMPACTION_MARKER, needsCompaction, TokenCalibration } from '../src/context/index.ts'
import { estimateConversationTokens, estimateTokens } from '../src/context/tokens.ts'
import {
  DEFAULT_COMPACTION,
  triggerThreshold,
  usableBudget,
  type CompactionOptions,
} from '../src/context/types.ts'
import { Session, SessionStore, type ToolExecutor } from '../src/host/index.ts'
import { Policy } from '../src/policy/index.ts'
import { okResult, type ToolResult } from '../src/tools/types.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import type { Message, ModelClient, ModelEvent } from '../src/model/types.ts'
import os from 'node:os'


const big = (chars: number, fill = 'x'): string => fill.repeat(chars)

function options(overrides: Partial<CompactionOptions> = {}): CompactionOptions {
  return { ...DEFAULT_COMPACTION, ...overrides }
}

/** 造一段「很多轮、每轮一个工具调用」的对话，方便压到超预算 */
function longConversation(turns: number, toolResultChars: number): Message[] {
  const messages: Message[] = [{ role: 'system', content: '你是 MVS Agent。' }]
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: 'user', content: `第 ${i} 轮的请求` })
    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: `call_${i}`, name: 'read_file', argsJson: `{"path":"f${i}.txt"}` }],
    })
    messages.push({ role: 'tool', content: big(toolResultChars), toolCallId: `call_${i}` })
    messages.push({ role: 'assistant', content: `第 ${i} 轮完成` })
  }
  return messages
}

// ---------------------------------------------------------------------------
// token 估算
// ---------------------------------------------------------------------------

test('token 估算：中文按字计、英文按字符群计，且宁可高估', () => {
  const chinese = estimateTokens('这是一段中文'.repeat(20))
  const english = estimateTokens('abcdefghij'.repeat(20))

  // 同样字符数下中文明显更贵 —— 这是真实分词的行为
  assert.ok(chinese > english, `中文 ${chinese} 应大于英文 ${english}`)
  assert.ok(estimateTokens('') === 0)
  assert.ok(estimateTokens('a') >= 1)
})

test('token 估算计入工具调用的参数', () => {
  const withCall: Message[] = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'run_command', argsJson: big(400) }] },
  ]
  const withoutCall: Message[] = [{ role: 'assistant', content: '' }]
  assert.ok(estimateConversationTokens(withCall) > estimateConversationTokens(withoutCall))
})

// ---------------------------------------------------------------------------
// 触发与不触发
// ---------------------------------------------------------------------------

test('未超预算时什么都不做', () => {
  const messages: Message[] = [
    { role: 'system', content: '提示' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好' },
  ]
  const result = compact(messages, options())
  assert.deepEqual(result.actions, [])
  assert.deepEqual(result.messages, messages)
  assert.equal(needsCompaction(messages, options()), false)
})

test('超预算时触发', () => {
  const messages = longConversation(20, 5000)
  const opts = options({ windowTokens: 2000, outputReserveTokens: 0, triggerRatio: 0.5 })
  assert.equal(needsCompaction(messages, opts), true)
  assert.ok(compact(messages, opts).actions.length > 0)
})

// ---------------------------------------------------------------------------
// 第一级：裁剪超大工具结果
// ---------------------------------------------------------------------------

test('裁剪超大工具结果：保留头尾，中间标出裁掉了多少', () => {
  const messages: Message[] = [
    { role: 'system', content: '提示' },
    { role: 'user', content: '读文件' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{}' }] },
    { role: 'tool', content: `开头标记${big(20_000)}结尾标记`, toolCallId: 'c1' },
  ]

  const result = compact(messages, options({ windowTokens: 1000, outputReserveTokens: 0, triggerRatio: 0.5 }))
  const pruned = result.actions.find((a) => a.kind === 'prune-tool-result')
  assert.ok(pruned !== undefined, `应该裁剪工具结果，实际动作：${JSON.stringify(result.actions)}`)

  const toolMessage = result.messages.find((m) => m.role === 'tool')
  assert.ok(toolMessage !== undefined && toolMessage.role === 'tool')
  if (toolMessage.role === 'tool') {
    assert.ok(toolMessage.content.startsWith('开头标记'), '开头要保留')
    assert.ok(toolMessage.content.endsWith('结尾标记'), '结尾要保留')
    assert.match(toolMessage.content, /已裁剪 \d+ 字符/, '必须说明裁掉了多少')
    assert.ok(toolMessage.content.length < 20_000, '确实变小了')
    assert.equal(toolMessage.toolCallId, 'c1', 'id 不能丢 —— 丢了就配不上对')
  }
})

test('小工具结果不动', () => {
  const messages: Message[] = [
    { role: 'system', content: '提示' },
    { role: 'user', content: big(10_000) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', argsJson: '{}' }] },
    { role: 'tool', content: '很短的结果', toolCallId: 'c1' },
  ]
  const result = compact(messages, options({ windowTokens: 1500, outputReserveTokens: 0, triggerRatio: 0.5 }))
  assert.equal(
    result.actions.some((a) => a.kind === 'prune-tool-result'),
    false,
  )
})

// ---------------------------------------------------------------------------
// 第二级：丢最老的轮次
// ---------------------------------------------------------------------------

test('丢轮次：保留最近 N 轮，且留下显式标记', () => {
  const messages = longConversation(12, 100)
  const opts = options({ windowTokens: 400, outputReserveTokens: 0, triggerRatio: 0.5, keepRecentTurns: 3 })

  const result = compact(messages, opts)
  const dropped = result.actions.find((a) => a.kind === 'drop-turns')
  assert.ok(dropped !== undefined, '应该丢了轮次')

  const users = result.messages.filter((m) => m.role === 'user')
  assert.equal(users.length, 3, `应保留最近 3 轮，实际 ${users.length}`)
  assert.equal(users[0]?.content, '第 9 轮的请求')

  const marker = result.messages.find(
    (m) => m.role === 'system' && m.content.startsWith(COMPACTION_MARKER),
  )
  assert.ok(marker !== undefined, '必须留下显式标记，而不是让模型以为对话本来就始于此处')
  assert.match(marker.content, /不要编造/)
})

test('工具调用与结果永远成对 —— 不允许只留一半', () => {
  const messages = longConversation(12, 100)
  const result = compact(
    messages,
    options({ windowTokens: 400, outputReserveTokens: 0, triggerRatio: 0.5, keepRecentTurns: 3 }),
  )

  const callIds = new Set<string>()
  const resultIds = new Set<string>()
  for (const message of result.messages) {
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      for (const call of message.toolCalls) callIds.add(call.id)
    }
    if (message.role === 'tool') resultIds.add(message.toolCallId)
  }

  assert.deepEqual(
    [...resultIds].sort(),
    [...callIds].sort(),
    '有调用没结果、或有结果没调用，接口都会直接报错',
  )
})

test('系统提示永不动', () => {
  const messages = longConversation(12, 100)
  const result = compact(
    messages,
    options({ windowTokens: 400, outputReserveTokens: 0, triggerRatio: 0.5, keepRecentTurns: 2 }),
  )
  assert.equal(result.messages[0]?.role, 'system')
  assert.equal(result.messages[0]?.content, '你是 MVS Agent。')
})

test('反复压缩不会让标记越积越多', () => {
  let messages = longConversation(20, 100)
  const opts = options({ windowTokens: 400, outputReserveTokens: 0, triggerRatio: 0.5, keepRecentTurns: 3 })

  for (let i = 0; i < 4; i += 1) {
    messages.push({ role: 'user', content: `又一轮 ${i}` })
    messages.push({ role: 'assistant', content: big(300) })
    messages = compact(messages, opts).messages
  }

  const markers = messages.filter(
    (m) => m.role === 'system' && m.content.startsWith(COMPACTION_MARKER),
  )
  assert.equal(markers.length, 1, `标记应该只有一条，实际 ${markers.length} 条`)
})

test('轮次不够多时不硬凑，如实保留', () => {
  const messages: Message[] = [
    { role: 'system', content: '提示' },
    { role: 'user', content: big(5000) },
    { role: 'assistant', content: big(5000) },
  ]
  // 预算很小，但只有 1 轮，丢不出东西
  const result = compact(messages, options({ windowTokens: 100, outputReserveTokens: 0, triggerRatio: 0.5, keepRecentTurns: 3 }))
  assert.equal(result.messages.filter((m) => m.role === 'user').length, 1)
  assert.equal(
    result.actions.some((a) => a.kind === 'drop-turns'),
    false,
    '不该丢掉唯一的一轮',
  )
})

test('压缩后 token 数下降', () => {
  const messages = longConversation(15, 3000)
  const opts = options({ windowTokens: 3000, outputReserveTokens: 0, triggerRatio: 0.5 })
  const result = compact(messages, opts)
  assert.ok(
    result.tokensAfter < result.tokensBefore,
    `${result.tokensBefore} → ${result.tokensAfter}，应该下降`,
  )
})

// ---------------------------------------------------------------------------
// 触发条件：即将超出，不是「有点大了」
// ---------------------------------------------------------------------------

test('预算从模型窗口推导，不是一个写死的常量', () => {
  const opts = options({ windowTokens: 10_000, outputReserveTokens: 2_000, triggerRatio: 0.9 })
  assert.equal(usableBudget(opts), 8_000, '可用预算 = 窗口 − 输出预留')
  assert.equal(triggerThreshold(opts), 7_200, '触发线 = 可用预算 × 90%')
})

test('窗口越小越早触发 —— 写死的预算必然两个方向都错', () => {
  // 约 11.6k token：对 8k 窗口已经超标，对 200k 窗口还早得很
  const messages = longConversation(10, 4_000)
  const used = estimateConversationTokens(messages)

  const small = options({ windowTokens: 8_000, outputReserveTokens: 0, triggerRatio: 0.9 })
  const large = options({ windowTokens: 200_000, outputReserveTokens: 0, triggerRatio: 0.9 })

  assert.equal(
    needsCompaction(messages, small),
    true,
    `小窗口下（实测 ${used} token vs 触发线 ${triggerThreshold(small)}）必须触发 —— 写死 96k 的话它已经爆了却还没开始压`,
  )
  assert.equal(
    needsCompaction(messages, large),
    false,
    `大窗口下（实测 ${used} token vs 触发线 ${triggerThreshold(large)}）不该被无谓地压 —— 写死 96k 的话它好端端地就开始丢历史`,
  )
})

test('只在即将超出时动手：71% 不动，越线才压', () => {
  const opts = options({ windowTokens: 10_000, outputReserveTokens: 0, triggerRatio: 0.9 })

  // 约 7140 token，占可用预算 ~71% —— 远未「即将超出」
  const near = conversationWithTool(25_000)
  const untouched = compact(near, opts)
  assert.deepEqual(untouched.actions, [], '没到线就什么都不该做')
  assert.deepEqual(untouched.messages, near)

  // 约 11430 token —— 真的快装不下了
  const over = conversationWithTool(40_000)
  const compacted = compact(over, opts)
  assert.ok(compacted.actions.length > 0, '越过触发线才动手')
  assert.ok(compacted.tokensAfter < compacted.tokensBefore)
})

test('受保护的最近几轮本身太大时，如实报告「压完仍然超」', () => {
  const opts = options({ windowTokens: 5_000, outputReserveTokens: 0, triggerRatio: 0.9 })

  // 一条超大的**用户消息**：不是工具结果，裁不动；又只有一轮，丢不掉
  const messages: Message[] = [
    { role: 'system', content: '提示' },
    { role: 'user', content: big(30_000) },
  ]

  const result = compact(messages, opts)
  assert.equal(result.stillOverBudget, true, '必须如实报告，而不是假装压好了')
  // 但仍然不该丢东西：丢掉唯一一轮等于把用户的话删了
  assert.equal(result.messages.filter((m) => m.role === 'user').length, 1)
})

function conversationWithTool(toolChars: number): Message[] {
  return [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{}' }],
    },
    { role: 'tool', content: big(toolChars), toolCallId: 'c1' },
  ]
}

// ---------------------------------------------------------------------------
// 估算的自我校准
// ---------------------------------------------------------------------------

test('校准：首个样本直接采用，之后走滑动平均', () => {
  const calibration = new TokenCalibration()
  assert.equal(calibration.factor, 1)
  assert.equal(calibration.calibrated, false)

  // 我们估 1000，真实 1500 —— 说明我们低估了 50%
  assert.equal(calibration.observe(1_000, 1_500), true)
  assert.equal(calibration.factor, 1.5, '首个样本直接采用')

  // 再来一个真实恰好等于估算的样本，系数应向 1 靠但不跳过去
  calibration.observe(2_000, 2_000)
  assert.ok(calibration.factor < 1.5 && calibration.factor > 1, `实际 ${calibration.factor}`)
  assert.equal(calibration.samples, 2)
})

test('校准：没有 usage（0 或负数）的样本被拒收，不污染系数', () => {
  const calibration = new TokenCalibration()
  calibration.observe(1_000, 2_000)
  const before = calibration.factor

  assert.equal(calibration.observe(1_000, 0), false, '多数端点不给 usage 时会返回 0')
  assert.equal(calibration.observe(1_000, -5), false)
  assert.equal(calibration.observe(0, 1_000), false, '自己估成 0 也是无效样本')
  assert.equal(calibration.factor, before, '无效样本不该改变系数')
  assert.equal(calibration.samples, 1)
})

test('校准：野点被钳制，不会让系数跑飞', () => {
  const calibration = new TokenCalibration()
  // 一次离谱的观测（真实是估算的 100 倍）
  calibration.observe(100, 10_000)
  assert.ok(calibration.factor <= 3, `系数应被钳制，实际 ${calibration.factor}`)

  const other = new TokenCalibration()
  other.observe(10_000, 10) // 真实只有估算的千分之一
  assert.ok(other.factor >= 0.4, `系数应被钳制，实际 ${other.factor}`)
})

test('校准：apply 把系数乘回估算上', () => {
  const calibration = new TokenCalibration()
  assert.equal(calibration.apply(1_000), 1_000, '未校准时原样返回')

  calibration.observe(1_000, 1_800)
  assert.equal(calibration.apply(1_000), 1_800)
})

test('★ 会话用真实 usage 校准估算，并暴露在投影里', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    const store = new SessionStore(path.join(base, 'session'), 'ses-test')
    await store.init()

    // 先按**会话的口径**算出「我们以为这次请求有多大」，再给一个比它大 60% 的真实值。
    //
    // 注意口径里必须含工具 schema：端点的 prompt_tokens 是把 schema 算进去的，
    // 拿只算了消息的估算去比，本身就是错的比较。
    const schemas = createDefaultRegistry().toModelSchemas()
    const firstCallEstimate =
      estimateConversationTokens([{ role: 'user', content: '你好' }]) +
      estimateTokens(JSON.stringify(schemas))
    const actual = Math.round(firstCallEstimate * 1.6)
    assert.ok(actual > 0)

    const model: ModelClient = {
      stream(): AsyncIterable<ModelEvent> {
        return (async function* generate() {
          yield { type: 'text_delta', text: '好' }
          yield { type: 'usage', usage: { inputTokens: actual, outputTokens: 1 } }
          yield { type: 'done', reason: 'stop' }
        })()
      },
    }

    const session = new Session({
      sessionId: 's',
      workspace: base,
      model,
      modelName: 'm',
      registry: createDefaultRegistry(),
      policy: new Policy({ mode: 'full-access' }),
      executor: fakeExecutor(10),
      store,
    })
    await session.init()

    assert.equal(session.projection().contextCalibration.samples, 0, '还没调用过，不该有样本')

    await session.sendUserMessage('你好')

    const projection = session.projection()
    assert.equal(projection.contextCalibration.samples, 1, '应该采到了一个真实样本')
    assert.equal(
      projection.contextCalibration.factor,
      1.6,
      '首个样本直接采用：真实是估算的 1.6 倍，系数就该是 1.6',
    )

    // 投影里的 token 数必须是**校准后**的值：原始估算 × 系数
    const rawEstimate = estimateConversationTokens(projection.messages)
    assert.equal(
      projection.contextTokens,
      Math.ceil(rawEstimate * projection.contextCalibration.factor),
      `投影应该报告校准后的值（原始估算 ${rawEstimate} × ${projection.contextCalibration.factor}）`,
    )
    assert.ok(projection.contextTokens > rawEstimate, '校准后应当比原始估算更接近真实')
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

// ---------------------------------------------------------------------------
// 与运行时接起来
// ---------------------------------------------------------------------------

function scriptedModel(turns: ModelEvent[][]): ModelClient {
  let index = 0
  return {
    stream(): AsyncIterable<ModelEvent> {
      const events = turns[index] ?? [{ type: 'done', reason: 'stop' }]
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

function fakeExecutor(toolResultChars: number): ToolExecutor {
  return {
    async execute(): Promise<{ result: ToolResult; transactionId?: string }> {
      return { result: okResult(big(toolResultChars)), transactionId: 'txn-x' }
    },
  }
}

test('会话：超预算时发出 context_compacted 事件，并把压缩结果写回内存', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    const store = new SessionStore(path.join(base, 'session'), 'ses-test')
    await store.init()

    const session = new Session({
      sessionId: 's',
      workspace: base,
      model: scriptedModel([call('c1', 'read_file', { path: 'big.txt' }), say('好')]),
      modelName: 'm',
      registry: createDefaultRegistry(),
      policy: new Policy({ mode: 'full-access' }),
      executor: fakeExecutor(20_000),
      store,
      context: { windowTokens: 500, outputReserveTokens: 0, triggerRatio: 0.5, keepRecentTurns: 2 },
    })
    await session.init()

    const events: string[] = []
    session.subscribe((envelope) => events.push(envelope.event.type))

    // 先跑一轮，让上下文里塞进一个巨大的工具结果
    await session.sendUserMessage('读文件')

    assert.ok(
      events.includes('context_compacted'),
      `应该发出压缩事件，实际：${events.join(',')}`,
    )
    assert.ok(
      session.projection().contextTokens < 20_000,
      '内存里的上下文应该真的被压下来了',
    )
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('★ 压缩之后重开会话，消息数组仍与内存逐字相同', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    const dir = path.join(base, 'session')
    const store = new SessionStore(dir, 'ses-test')
    await store.init()

    const make = (model: ModelClient): Session =>
      new Session({
        sessionId: 's',
        workspace: base,
        model,
        modelName: 'm',
        registry: createDefaultRegistry(),
        policy: new Policy({ mode: 'full-access' }),
        executor: fakeExecutor(20_000),
        store,
        system: '系统提示',
        context: { windowTokens: 300, outputReserveTokens: 0, triggerRatio: 0.4, keepRecentTurns: 2 },
      })

    const first = make(
      scriptedModel([
        call('c1', 'read_file', { path: 'a.txt' }),
        say('第一次'),
        call('c2', 'read_file', { path: 'b.txt' }),
        say('第二次'),
      ]),
    )
    await first.init()
    await first.sendUserMessage('第一轮')
    await first.sendUserMessage('第二轮')

    const before = first.projection().messages
    assert.ok(
      before.some((m) => m.role === 'tool' && m.content.includes('已裁剪')),
      '这一轮测试必须真的发生过压缩，否则它没有验证到东西',
    )

    // 全新进程从日志恢复
    const reopened = make(scriptedModel([]))
    await reopened.init()

    assert.deepEqual(
      reopened.projection().messages,
      before,
      '压缩之后重建的数组必须与内存逐字相同 —— 否则 resume 之后模型看到的是压缩前的那段历史',
    )
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
