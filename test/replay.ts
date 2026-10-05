/**
 * 录制回放的假 provider。
 *
 * 通过注入 fetch 来替换网络层，**走的是和线上完全相同的代码路径**
 * （SSE 分帧、字段映射、usage、错误处理全都真实执行）。
 *
 * 结果：测试不需要网络、不需要 API key、不烧 token，而且 bug 可以精确复现。
 * 没有这个，你以后每调一次 bug 都要花一次钱。
 */

import { readFileSync } from 'node:fs'
import {
  OpenAICompatibleClient,
  type ClientDeps,
  type OpenAICompatibleConfig,
} from '../src/model/openai-compatible.ts'
import type { ModelEvent } from '../src/model/types.ts'

export interface CapturedRequest {
  url: string
  init: RequestInit
  body: Record<string, unknown> | undefined
}

export type FakeHandler = (
  url: string,
  init: RequestInit,
) => Response | Promise<Response>

export function mockFetch(handler: FakeHandler): {
  fn: typeof globalThis.fetch
  calls: CapturedRequest[]
} {
  const calls: CapturedRequest[] = []

  const fn: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    const raw = init?.body
    calls.push({
      url,
      init: init ?? {},
      body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
    })
    return await handler(url, init ?? {})
  }

  return { fn, calls }
}

// ---------------------------------------------------------------------------
// 响应构造
// ---------------------------------------------------------------------------

export interface ChunkingOptions {
  /** 固定分块大小；给数组则循环使用，用来模拟真实网络的不规则分片 */
  chunkSize?: number | number[]
  status?: number
  statusText?: string
}

/** 把一段 SSE 文本变成响应，并可以按任意分块大小切开 —— 用来压测跨 chunk 分帧 */
export function sseResponse(body: string, options: ChunkingOptions = {}): Response {
  const bytes = new TextEncoder().encode(body)
  const sizes = normalizeSizes(options.chunkSize)

  let cursor = 0
  let index = 0

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor >= bytes.length) {
        controller.close()
        return
      }
      const size = sizes[index % sizes.length]
      index += 1
      controller.enqueue(bytes.slice(cursor, cursor + size))
      cursor += size
    },
  })

  return new Response(stream, {
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    headers: { 'content-type': 'text/event-stream' },
  })
}

/** 非 2xx 响应 */
export function errorResponse(
  status: number,
  body: string,
  statusText = 'Internal Server Error',
): Response {
  return new Response(body, { status, statusText })
}

/** 先吐一段正常内容，然后连接断掉 —— 模拟「吐了一半」 */
export function failingResponse(head: string, error: unknown): Response {
  const bytes = new TextEncoder().encode(head)
  let sent = false

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(bytes)
        return
      }
      controller.error(error)
    },
  })

  return new Response(stream, { status: 200 })
}

export interface StreamState {
  cancelled: boolean
  reason?: unknown
}

/**
 * 吐一段内容后一直挂着（服务端不再发送）。
 * 通过 releasePendingPull 保证 cancel 能真正完成，否则测试会悬挂。
 */
export function hangingResponse(head: string, state: StreamState): Response {
  const bytes = new TextEncoder().encode(head)
  let sent = false
  let releasePendingPull: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true
        controller.enqueue(bytes)
        return
      }
      // 返回一个永不 resolve 的 promise，避免 pull 空转把 CPU 打满
      return new Promise<void>((resolve) => {
        releasePendingPull = resolve
      })
    },
    cancel(reason) {
      state.cancelled = true
      state.reason = reason
      releasePendingPull?.()
    },
  })

  return new Response(stream, { status: 200 })
}

/** 同上，但会响应 AbortSignal —— 模拟真实 fetch 被取消时 body 抛错的行为 */
export function abortableHangingResponse(
  head: string,
  state: StreamState,
  signal?: AbortSignal | null,
): Response {
  const bytes = new TextEncoder().encode(head)
  let sent = false
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null
  let releasePendingPull: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    pull(c) {
      if (!sent) {
        sent = true
        c.enqueue(bytes)
        return
      }
      return new Promise<void>((resolve) => {
        releasePendingPull = resolve
      })
    },
    cancel(reason) {
      state.cancelled = true
      state.reason = reason
      releasePendingPull?.()
    },
  })

  const failWithAbort = (): void => {
    try {
      controller?.error(new DOMException('This operation was aborted', 'AbortError'))
    } catch {
      // 流已经关闭，忽略
    }
    releasePendingPull?.()
  }

  if (signal) {
    if (signal.aborted) failWithAbort()
    else signal.addEventListener('abort', failWithAbort, { once: true })
  }

  return new Response(stream, { status: 200 })
}

function normalizeSizes(chunkSize: number | number[] | undefined): number[] {
  if (chunkSize === undefined) return [Number.MAX_SAFE_INTEGER]
  if (Array.isArray(chunkSize)) {
    if (chunkSize.length === 0 || chunkSize.some((n) => n <= 0)) return [1]
    return chunkSize
  }
  return [chunkSize > 0 ? chunkSize : 1]
}

// ---------------------------------------------------------------------------
// 便捷工具
// ---------------------------------------------------------------------------

export function loadFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

export const TEST_CONFIG: OpenAICompatibleConfig = {
  baseUrl: 'http://test.local/v1',
  model: 'test-model',
  apiKey: 'sk-test',
}

export function makeClient(
  handler: FakeHandler,
  config: Partial<OpenAICompatibleConfig> = {},
  deps: ClientDeps = {},
): { client: OpenAICompatibleClient; calls: CapturedRequest[] } {
  const { fn, calls } = mockFetch(handler)
  const client = new OpenAICompatibleClient({ ...TEST_CONFIG, ...config }, { fetch: fn, ...deps })
  return { client, calls }
}

/** 收干一个流。**仅测试用** —— 线上要边到边渲染就别用这个 */
export async function drain(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = []
  for await (const event of stream) events.push(event)
  return events
}

export function textDeltas(events: ModelEvent[]): string[] {
  const out: string[] = []
  for (const event of events) {
    if (event.type === 'text_delta') out.push(event.text)
  }
  return out
}

export function reasoningDeltas(events: ModelEvent[]): string[] {
  const out: string[] = []
  for (const event of events) {
    if (event.type === 'reasoning_delta') out.push(event.text)
  }
  return out
}

export function eventTypes(events: ModelEvent[]): string[] {
  return events.map((event) => event.type)
}

/** 等到下一个事件循环 tick，用于断言异步副作用（比如连接释放）已经发生 */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
