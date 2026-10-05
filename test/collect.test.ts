/**
 * collect() 的测试：流的派生物，不是第二套实现。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { collect, parseToolArgs } from '../src/model/collect.ts'
import { errorResponse, loadFixture, makeClient, sseResponse } from './replay.ts'

test('collect 从流组装出完整结果：文本 + 思维链 + 工具调用 + usage', async () => {
  const { client } = makeClient(() => sseResponse(loadFixture('reasoning-deepseek.sse')))
  const result = await collect(client.stream({ model: 'm', messages: [] }))

  assert.equal(result.text, '事件溯源是把状态存成事件序列。')
  assert.equal(result.reasoning, '用户问的是事件溯源，我应该先解释它是什么。')
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 30 })
  assert.equal(result.finishReason, 'stop')
  assert.equal(result.error, undefined)
  assert.deepEqual(result.toolCalls, [])
  assert.deepEqual(result.notices, [])
})

test('collect 把碎片拼成合法 JSON 的工具参数', async () => {
  const { client } = makeClient(() => sseResponse(loadFixture('tool-calls.sse')))
  const result = await collect(client.stream({ model: 'm', messages: [] }))

  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.toolCalls, [
    { id: 'call_abc', name: 'read_file', argsJson: '{"path":"README.md"}' },
    { id: 'call_def', name: 'list_dir', argsJson: '{"path":"."}' },
  ])
  assert.deepEqual(parseToolArgs(result.toolCalls[0]), { path: 'README.md' })
  assert.deepEqual(parseToolArgs(result.toolCalls[1]), { path: '.' })
})

test('collect 把错误记进结果，而不是抛出', async () => {
  const { client } = makeClient(() => errorResponse(401, 'bad key', 'Unauthorized'))
  const result = await collect(client.stream({ model: 'm', messages: [] }))

  assert.equal(result.finishReason, 'error')
  assert.equal(result.error?.kind, 'http')
  assert.equal(result.error?.status, 401)
  assert.equal(result.text, '')
})

test('collect 保留降级提示', async () => {
  const { client } = makeClient(() => sseResponse(loadFixture('no-usage.sse')))
  const result = await collect(client.stream({ model: 'm', messages: [] }))

  assert.deepEqual(
    result.notices.map((n) => n.code),
    ['missing_usage'],
  )
  assert.equal(result.text, '本地推理')
})

test('parseToolArgs：合法 / 空 / 坏 JSON', () => {
  assert.deepEqual(parseToolArgs({ id: '1', name: 't', argsJson: '{"a":1}' }), { a: 1 })
  assert.deepEqual(parseToolArgs({ id: '1', name: 't', argsJson: '  ' }), {})
  assert.throws(
    () => parseToolArgs({ id: '1', name: 'read_file', argsJson: '{"path":' }),
    /read_file.*不是合法 JSON/,
  )
})
