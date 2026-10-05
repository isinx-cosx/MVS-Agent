/**
 * 模型客户端测试。
 *
 * 全部走注入的假 fetch —— 和线上完全相同的代码路径，但不需要网络和 key。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { OpenAICompatibleClient } from '../src/model/openai-compatible.ts'
import type { ModelEvent } from '../src/model/types.ts'
import {
  abortableHangingResponse,
  drain,
  errorResponse,
  eventTypes,
  failingResponse,
  hangingResponse,
  loadFixture,
  makeClient,
  mockFetch,
  reasoningDeltas,
  sseResponse,
  textDeltas,
  tick,
  type StreamState,
} from './replay.ts'

function noticeCodes(events: ModelEvent[]): string[] {
  const codes: string[] = []
  for (const event of events) {
    if (event.type === 'notice') codes.push(event.notice.code)
  }
  return codes
}

/** 把 tool_call_delta 碎片按 index 拼起来，验证累积逻辑 */
function joinToolArgs(events: ModelEvent[]): Array<[number, string]> {
  const fragments = new Map<number, string>()
  for (const event of events) {
    if (event.type !== 'tool_call_delta') continue
    fragments.set(event.index, (fragments.get(event.index) ?? '') + (event.argsJsonDelta ?? ''))
  }
  return [...fragments.entries()]
}

// ---------------------------------------------------------------------------
// 正常路径
// ---------------------------------------------------------------------------

test('文本流：delta 顺序、usage、done，且请求体与请求头正确', async () => {
  const { client, calls } = makeClient(() => sseResponse(loadFixture('text-basic.sse')))

  const events = await drain(
    client.stream({ model: 'test-model', messages: [{ role: 'user', content: '你好' }] }),
  )

  assert.deepEqual(textDeltas(events), ['你好', '，世界'])
  assert.deepEqual(events.at(-1), { type: 'done', reason: 'stop' })
  assert.deepEqual(
    events.find((e) => e.type === 'usage'),
    { type: 'usage', usage: { inputTokens: 11, outputTokens: 5 } },
  )
  // 有 usage 就不该出现降级提示
  assert.deepEqual(noticeCodes(events), [])

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://test.local/v1/chat/completions')
  const body = calls[0].body!
  assert.equal(body.model, 'test-model')
  assert.equal(body.stream, true)
  assert.deepEqual(body.stream_options, { include_usage: true })
  assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }])

  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers.authorization, 'Bearer sk-test')
  assert.equal(headers.accept, 'text/event-stream')
})

test('核心：任意网络分片下事件序列完全一致', async () => {
  const fixture = loadFixture('text-basic.sse')

  const baseline = textDeltas(
    await drain(makeClient(() => sseResponse(fixture)).client.stream({ model: 'm', messages: [] })),
  )

  for (const chunkSize of [1, 2, 3, 7, 64, [1, 5, 2, 40]]) {
    const events = await drain(
      makeClient(() => sseResponse(fixture, { chunkSize })).client.stream({
        model: 'm',
        messages: [],
      }),
    )
    assert.deepEqual(textDeltas(events), baseline, `chunkSize=${String(chunkSize)}`)
  }
})

test('DeepSeek 的 reasoning_content 映射为 reasoning_delta，且与正文分离', async () => {
  const events = await drain(
    makeClient(() => sseResponse(loadFixture('reasoning-deepseek.sse'))).client.stream({
      model: 'm',
      messages: [],
    }),
  )

  assert.deepEqual(reasoningDeltas(events), ['用户问的是', '事件溯源，我应该先解释它是什么。'])
  assert.deepEqual(textDeltas(events), ['事件溯源是把状态', '存成事件序列。'])
  assert.deepEqual(events.at(-1), { type: 'done', reason: 'stop' })
})

test('工具调用参数按 index 累积，而不是各管各的', async () => {
  const events = await drain(
    makeClient(() => sseResponse(loadFixture('tool-calls.sse'))).client.stream({
      model: 'm',
      messages: [],
    }),
  )

  assert.deepEqual(joinToolArgs(events), [
    [0, '{"path":"README.md"}'],
    [1, '{"path":"."}'],
  ])
  assert.deepEqual(events.at(-1), { type: 'done', reason: 'tool_calls' })

  // 文本流里不该混进工具调用的内容
  assert.deepEqual(textDeltas(events), [])
})

// ---------------------------------------------------------------------------
// 能力缺失：降级，不是崩溃
// ---------------------------------------------------------------------------

test('服务端不给 usage 时降级为提示，而不是报错', async () => {
  const events = await drain(
    makeClient(() => sseResponse(loadFixture('no-usage.sse'))).client.stream({
      model: 'm',
      messages: [],
    }),
  )

  assert.deepEqual(textDeltas(events), ['本地', '推理'])
  assert.deepEqual(noticeCodes(events), ['missing_usage'])
  assert.deepEqual(events.at(-1), { type: 'done', reason: 'stop' })
})

test('流既没有 [DONE] 也没有 finish_reason 时给出 truncated_stream 提示', async () => {
  const body =
    'data: {"choices":[{"index":0,"delta":{"content":"半截"},"finish_reason":null}]}\n\n'
  const events = await drain(
    makeClient(() => sseResponse(body)).client.stream({ model: 'm', messages: [] }),
  )

  assert.deepEqual(textDeltas(events), ['半截'])
  assert.ok(noticeCodes(events).includes('truncated_stream'))
  assert.deepEqual(events.at(-1), { type: 'done', reason: 'unknown' })
})

test('无法解析的 SSE data 记为提示，不中断整条流', async () => {
  const body = [
    'data: {不是 JSON}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"还能继续"},"finish_reason":"stop"}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
    'data: [DONE]\n\n',
  ].join('')

  const events = await drain(
    makeClient(() => sseResponse(body)).client.stream({ model: 'm', messages: [] }),
  )

  assert.deepEqual(noticeCodes(events), ['bad_sse_data'])
  assert.deepEqual(textDeltas(events), ['还能继续'])
  assert.deepEqual(events.at(-1), { type: 'done', reason: 'stop' })
})

// ---------------------------------------------------------------------------
// 错误路径
// ---------------------------------------------------------------------------

test('HTTP 500 映射为 error/http，带上状态码与响应体', async () => {
  const events = await drain(
    makeClient(() => errorResponse(500, '{"error":"boom"}')).client.stream({
      model: 'm',
      messages: [],
    }),
  )

  assert.equal(events.length, 1)
  const first = events[0]
  assert.ok(first.type === 'error')
  assert.equal(first.error.kind, 'http')
  assert.equal(first.error.status, 500)
  assert.match(first.error.message, /boom/)
})

test('流中途断开 → error/network，已经收到的文本不丢失', async () => {
  const head =
    'data: {"choices":[{"index":0,"delta":{"content":"半截"},"finish_reason":null}]}\n\n'

  const events = await drain(
    makeClient(() => failingResponse(head, new Error('socket hang up'))).client.stream({
      model: 'm',
      messages: [],
    }),
  )

  // 关键：吐了一半的文本必须还在 —— 上层要能区分「没开始」和「吐了一半」
  assert.deepEqual(textDeltas(events), ['半截'])

  const last = events.at(-1)
  assert.ok(last && last.type === 'error')
  assert.equal(last.error.kind, 'network')
  assert.match(last.error.message, /socket hang up/)
})

test('错误是事件而不是异常：不会向外抛', async () => {
  await assert.doesNotReject(async () => {
    const { client } = makeClient(() => errorResponse(401, 'bad key', 'Unauthorized'))
    await drain(client.stream({ model: 'm', messages: [] }))
  })
})

test('未指定模型时直接返回 protocol 错误，不发请求', async () => {
  const { client, calls } = makeClient(() => sseResponse(''), { model: undefined })
  const events = await drain(client.stream({ model: '', messages: [] }))

  assert.equal(calls.length, 0)
  assert.equal(events.length, 1)
  const first = events[0]
  assert.ok(first.type === 'error')
  assert.equal(first.error.kind, 'protocol')
})

// ---------------------------------------------------------------------------
// 取消与连接释放
// ---------------------------------------------------------------------------

test('消费者提前 break 会关掉底层连接，不留悬挂请求', async () => {
  const head =
    'data: {"choices":[{"index":0,"delta":{"content":"一"},"finish_reason":null}]}\n\n'
  const state: StreamState = { cancelled: false }

  const { client, calls } = makeClient(() => hangingResponse(head, state))

  const iterator = client.stream({ model: 'm', messages: [] })[Symbol.asyncIterator]()
  const first = await iterator.next()
  assert.equal(first.done, false)

  // 模拟 Ctrl+C / 用户关掉界面后消费者直接放弃
  await iterator.return?.(undefined)
  await tick()

  assert.equal(
    (calls[0].init.signal as AbortSignal).aborted,
    true,
    '内层请求信号没有被 abort，连接会泄漏',
  )
  assert.equal(state.cancelled, true, '底层响应流没有被取消')
})

test('外部 AbortSignal 取消 → done/aborted，而不是抛错', async () => {
  const { fn } = mockFetch(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal
        const fail = (): void =>
          reject(new DOMException('This operation was aborted', 'AbortError'))
        if (signal?.aborted) {
          fail()
          return
        }
        signal?.addEventListener('abort', fail, { once: true })
      }),
  )

  const client = new OpenAICompatibleClient(
    { baseUrl: 'http://test.local/v1', model: 'm', apiKey: 'k' },
    { fetch: fn },
  )

  const controller = new AbortController()
  const pending = drain(client.stream({ model: 'm', messages: [], signal: controller.signal }))
  controller.abort()

  assert.deepEqual(await pending, [{ type: 'done', reason: 'aborted' }])
})

test('流读到一半被取消 → done/aborted，已收到的内容仍可见', async () => {
  const head =
    'data: {"choices":[{"index":0,"delta":{"content":"一"},"finish_reason":null}]}\n\n'
  const state: StreamState = { cancelled: false }

  const { client } = makeClient((_url, init) =>
    // 这个假响应会响应 AbortSignal，模拟真实 fetch 被取消时 body 抛错
    abortableHangingResponse(head, state, init.signal),
  )

  const controller = new AbortController()
  const iterator = client.stream({
    model: 'm',
    messages: [],
    signal: controller.signal,
  })[Symbol.asyncIterator]()

  const events: ModelEvent[] = []
  const first = await iterator.next()
  assert.equal(first.done, false)
  if (!first.done) events.push(first.value)

  controller.abort()

  let step = await iterator.next()
  while (!step.done) {
    events.push(step.value)
    step = await iterator.next()
  }

  assert.deepEqual(textDeltas(events), ['一'])
  assert.deepEqual(events.at(-1), { type: 'done', reason: 'aborted' })
})

// ---------------------------------------------------------------------------
// 线上格式映射
// ---------------------------------------------------------------------------

test('多轮历史与工具的线上格式映射正确；includeUsage=false 时不带 stream_options', async () => {
  const { client, calls } = makeClient(() => sseResponse(loadFixture('text-basic.sse')), {
    includeUsage: false,
    headers: { 'x-custom': '1' },
  })

  const parameters = {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  }

  await drain(
    client.stream({
      model: 'test-model',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"a"}' }],
        },
        { role: 'tool', content: 'ok', toolCallId: 'c1' },
      ],
      tools: [{ name: 'read_file', description: '读文件', parameters }],
      temperature: 0.3,
      maxTokens: 128,
    }),
  )

  const body = calls[0].body!
  assert.equal(body.stream_options, undefined)
  assert.equal(body.temperature, 0.3)
  assert.equal(body.max_tokens, 128)

  assert.deepEqual(body.messages, [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ])

  assert.deepEqual(body.tools, [
    { type: 'function', function: { name: 'read_file', description: '读文件', parameters } },
  ])

  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers['x-custom'], '1')
})

test('baseUrl 末尾多余的斜杠不会拼出双斜杠', async () => {
  const { client, calls } = makeClient(() => sseResponse(loadFixture('text-basic.sse')), {
    baseUrl: 'http://test.local/v1///',
  })
  await drain(client.stream({ model: 'm', messages: [] }))
  assert.equal(calls[0].url, 'http://test.local/v1/chat/completions')
})

test('事件类型序列符合预期（无多余事件）', async () => {
  const events = await drain(
    makeClient(() => sseResponse(loadFixture('text-basic.sse'))).client.stream({
      model: 'm',
      messages: [],
    }),
  )
  assert.deepEqual(eventTypes(events), [
    'text_delta',
    'text_delta',
    'usage',
    'done',
  ])
})
