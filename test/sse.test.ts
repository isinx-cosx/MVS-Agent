/**
 * SSE 分帧的测试。
 *
 * 重点不是「能解析」，而是**任意切分下结果一致** —— 这是最容易在生产环境
 * 偶发崩溃、又最难复现的一类 bug。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSSE, type SSEEvent } from '../src/model/sse.ts'
import { loadFixture } from './replay.ts'

async function* fromBytes(chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const chunk of chunks) yield chunk
}

/** 把文本按固定字节数切开再解析，模拟真实网络分片 */
async function parseWithChunkSize(text: string, chunkSize: number): Promise<SSEEvent[]> {
  const bytes = new TextEncoder().encode(text)
  const chunks: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(bytes.slice(i, i + chunkSize))
  }

  const events: SSEEvent[] = []
  for await (const event of parseSSE(fromBytes(chunks))) events.push(event)
  return events
}

test('解析基本事件', async () => {
  const events = await parseWithChunkSize('data: hello\n\ndata: world\n\n', 4096)
  assert.deepEqual(events, [
    { event: '', data: 'hello' },
    { event: '', data: 'world' },
  ])
})

test('核心：整份 fixture 在任意字节切分下结果完全一致', async () => {
  const text = loadFixture('text-basic.sse')
  const baseline = await parseWithChunkSize(text, text.length)
  assert.equal(baseline.length, 6)
  assert.equal(baseline.at(-1)?.data, '[DONE]')

  for (const chunkSize of [1, 2, 3, 5, 17, 64, 333]) {
    const sliced = await parseWithChunkSize(text, chunkSize)
    assert.deepEqual(sliced, baseline, `chunkSize=${chunkSize} 时结果不一致`)
  }
})

test('CRLF 归一化，包括被切散的 \\r | \\n', async () => {
  // chunkSize=1 会把每个 \r 和 \n 都拆到不同 chunk，专门打这条路径
  const events = await parseWithChunkSize('data: a\r\n\r\ndata: b\r\n\r\n', 1)
  assert.deepEqual(events, [
    { event: '', data: 'a' },
    { event: '', data: 'b' },
  ])
})

test('多行 data 按 \\n 连接', async () => {
  const events = await parseWithChunkSize('data: line1\ndata: line2\n\n', 4096)
  assert.deepEqual(events, [{ event: '', data: 'line1\nline2' }])
})

test('注释行（心跳保活）被跳过，event 字段被保留', async () => {
  const events = await parseWithChunkSize(': keep-alive\nevent: ping\ndata: {}\n\n', 4096)
  assert.deepEqual(events, [{ event: 'ping', data: '{}' }])
})

test('冒号后只去掉一个空格；无空格的 data 也合法', async () => {
  const events = await parseWithChunkSize('data:no-space\n\ndata:  two-spaces\n\n', 4096)
  assert.deepEqual(events, [
    { event: '', data: 'no-space' },
    { event: '', data: ' two-spaces' },
  ])
})

test('末尾没有空行收尾的事件也会发出', async () => {
  const events = await parseWithChunkSize('data: tail', 3)
  assert.deepEqual(events, [{ event: '', data: 'tail' }])
})

test('多字节 UTF-8 字符跨 chunk 不被切坏', async () => {
  const text = `data: ${JSON.stringify({ t: '中文😀混合' })}\n\n`
  for (const chunkSize of [1, 2, 3, 5]) {
    const events = await parseWithChunkSize(text, chunkSize)
    assert.equal(events.length, 1, `chunkSize=${chunkSize}`)
    assert.equal(
      (JSON.parse(events[0].data) as { t: string }).t,
      '中文😀混合',
      `chunkSize=${chunkSize} 时多字节字符被切坏`,
    )
  }
})

test('纯空行与纯注释不会产生事件', async () => {
  const events = await parseWithChunkSize('\n\n: x\n\n\n\n', 4096)
  assert.deepEqual(events, [])
})
