/**
 * OpenAI 兼容端点客户端。
 *
 * 一份适配器覆盖 DeepSeek / OpenAI / Moonshot / 硅基流动 / Ollama / vLLM ——
 * 它们共用 chat completions 的形状。**刻意不做 provider 注册表**：
 * 等真接了第二家「形状不同」的（比如 Anthropic 的 messages），抽象会自己浮出来。
 *
 * 已知的行为差异不在这里抹平，而是降级成 Notice 让上层看见：
 *   - 有没有 reasoning_content
 *   - 有没有 usage 尾包
 *   - 有没有 [DONE]
 */

import type {
  FinishReason,
  Message,
  ModelClient,
  ModelError,
  ModelEvent,
  ModelRequest,
  ToolSchema,
} from './types.ts'
import { parseSSE } from './sse.ts'

export interface OpenAICompatibleConfig {
  /** 例：https://api.deepseek.com/v1 或 http://127.0.0.1:11434/v1 */
  baseUrl: string
  apiKey?: string
  /** 默认模型；请求里给了 model 时以请求为准 */
  model?: string
  /**
   * 是否请求 usage 尾包（stream_options.include_usage）。
   * OpenAI / DeepSeek 支持；部分兼容网关会拒绝这个字段，置 false 即可。
   * 缺失不是错误，会降级为 missing_usage 通知。
   */
  includeUsage?: boolean
  headers?: Record<string, string>
}

export interface ClientDeps {
  /** 注入点：测试用录制回放的假 fetch 替换，让测试不依赖网络和 key */
  fetch?: typeof globalThis.fetch
}

const DEFAULT_INCLUDE_USAGE = true

export class OpenAICompatibleClient implements ModelClient {
  #config: OpenAICompatibleConfig
  #fetch: typeof globalThis.fetch

  constructor(config: OpenAICompatibleConfig, deps: ClientDeps = {}) {
    this.#config = config
    this.#fetch = deps.fetch ?? globalThis.fetch
  }

  async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
    const model = req.model || this.#config.model
    if (!model) {
      yield {
        type: 'error',
        error: { kind: 'protocol', message: '未指定模型：请求和配置里都没有 model' },
      }
      return
    }

    // 内部 controller 与外部的 signal 联动：外部取消要能一路穿到底
    const controller = new AbortController()
    const external = req.signal
    const onAbort = () => controller.abort(external?.reason)
    if (external) {
      if (external.aborted) controller.abort(external.reason)
      else external.addEventListener('abort', onAbort, { once: true })
    }

    let finishReason: FinishReason = 'unknown'
    let sawUsage = false
    let sawDone = false
    let sawFinishReason = false

    try {
      const response = await this.#fetch(joinUrl(this.#config.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(this.#body(req, model)),
        signal: controller.signal,
      })

      if (!response.ok) {
        const detail = await readErrorBody(response)
        yield {
          type: 'error',
          error: {
            kind: 'http',
            status: response.status,
            message: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${detail ? ` — ${detail}` : ''}`,
          },
        }
        return
      }

      if (!response.body) {
        yield {
          type: 'error',
          error: { kind: 'protocol', message: '响应没有 body，无法流式读取' },
        }
        return
      }

      for await (const sse of parseSSE(response.body)) {
        // 终止标记，不是 JSON
        if (sse.data === '[DONE]') {
          sawDone = true
          break
        }

        let chunk: OpenAIChunk
        try {
          chunk = JSON.parse(sse.data) as OpenAIChunk
        } catch {
          yield {
            type: 'notice',
            notice: { code: 'bad_sse_data', message: `无法解析的 SSE data：${truncate(sse.data)}` },
          }
          continue
        }

        // usage 尾包的 choices 是空数组，必须在取 choice 之前处理
        if (chunk.usage) {
          sawUsage = true
          yield {
            type: 'usage',
            usage: {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
              /* 缓存命中：三家字段名都不一样，见 `cacheHitTokens` 的注释 */
              ...cachedTokensOf(chunk),
              /*
               * 速度：只有 llama.cpp 会报（非标准字段）。**API 没有这个**，
               * 由会话层自己掐表兜底 —— 见 `src/host/session.ts` 里那段注释。
               */
              ...(typeof chunk.timings?.predicted_per_second === 'number'
                ? { tokensPerSecond: chunk.timings.predicted_per_second }
                : {}),
            },
          }
        }

        const choice = chunk.choices?.[0]
        if (!choice) continue

        const delta = choice.delta ?? {}

        // DeepSeek 用 reasoning_content，部分端点用 reasoning
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (typeof reasoning === 'string' && reasoning !== '') {
          yield { type: 'reasoning_delta', text: reasoning }
        }

        if (typeof delta.content === 'string' && delta.content !== '') {
          yield { type: 'text_delta', text: delta.content }
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            if (typeof call?.index !== 'number') continue
            yield {
              type: 'tool_call_delta',
              index: call.index,
              id: call.id,
              name: call.function?.name,
              argsJsonDelta: call.function?.arguments,
            }
          }
        }

        if (choice.finish_reason) {
          sawFinishReason = true
          finishReason = mapFinishReason(choice.finish_reason)
        }
      }
    } catch (err) {
      // 主动取消是正常终止，不是错误
      if (controller.signal.aborted || isAbortError(err)) {
        yield { type: 'done', reason: 'aborted' }
        return
      }
      // 流中途失败也是一等事件：上层要能区分「没开始」和「吐了一半」
      yield { type: 'error', error: toModelError(err) }
      return
    } finally {
      if (external) external.removeEventListener('abort', onAbort)
      // 消费者提前 break 时，这里负责把底层连接关掉，避免连接泄漏。
      // AsyncIterable 不会自动替你做这件事。
      controller.abort()
    }

    // 只有「流正常结束」这一条路径会走到这里
    if (!sawUsage) {
      yield {
        type: 'notice',
        notice: {
          code: 'missing_usage',
          message: '服务端未返回 usage，token 统计不可用（正常的兼容性降级）',
        },
      }
    }
    if (!sawDone && !sawFinishReason) {
      yield {
        type: 'notice',
        notice: {
          code: 'truncated_stream',
          message: '流既没有 [DONE] 也没有 finish_reason 就结束了',
        },
      }
    }
    yield { type: 'done', reason: finishReason }
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...this.#config.headers,
    }
    if (this.#config.apiKey) headers.authorization = `Bearer ${this.#config.apiKey}`
    return headers
  }

  #body(req: ModelRequest, model: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model,
      messages: req.messages.map(toWireMessage),
      stream: true,
    }

    if (this.#config.includeUsage ?? DEFAULT_INCLUDE_USAGE) {
      body.stream_options = { include_usage: true }
    }
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(toWireTool)
    }
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens
    return body
  }
}

// ---------------------------------------------------------------------------
// 线上格式（wire format）
// ---------------------------------------------------------------------------

interface OpenAIChunk {
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    /** OpenAI 的提示缓存命中数 */
    prompt_tokens_details?: { cached_tokens?: number } | null
    /** **DeepSeek 自己的**缓存命中数字段（名字和 OpenAI 不一样） */
    prompt_cache_hit_tokens?: number
  } | null
  /**
   * llama.cpp 的计时信息（**非标准字段**，只在它自家服务上出现）。
   * `predicted_per_second` 是纯解码速度；`cache_n` 是缓存命中数。
   */
  timings?: { predicted_per_second?: number; cache_n?: number } | null
}

/**
 * 从响应里取出"提示缓存命中了多少 token"。
 *
 * ⚠️ **三家字段名都不一样**，只认一家就等于"只有那家能显示"：
 *
 *   OpenAI       usage.prompt_tokens_details.cached_tokens
 *   DeepSeek     usage.prompt_cache_hit_tokens
 *   llama.cpp    timings.cache_n（非标准，本机实测有）
 *
 * 一个都没有就**不填** —— "不知道"和"没命中"是两件事，不能用 0 冒充后者。
 */
function cachedTokensOf(chunk: {
  usage?: {
    prompt_tokens_details?: { cached_tokens?: number } | null
    prompt_cache_hit_tokens?: number
  } | null
  timings?: { cache_n?: number } | null
}): { cachedTokens?: number } {
  const openai = chunk.usage?.prompt_tokens_details?.cached_tokens
  if (typeof openai === 'number') return { cachedTokens: openai }

  const deepseek = chunk.usage?.prompt_cache_hit_tokens
  if (typeof deepseek === 'number') return { cachedTokens: deepseek }

  const llama = chunk.timings?.cache_n
  if (typeof llama === 'number') return { cachedTokens: llama }

  return {}
}

function toWireMessage(message: Message): Record<string, unknown> {
  switch (message.role) {
    case 'assistant': {
      const out: Record<string, unknown> = { role: 'assistant', content: message.content }
      if (message.toolCalls && message.toolCalls.length > 0) {
        out.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.argsJson },
        }))
      }
      return out
    }
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content }
    default:
      return { role: message.role, content: message.content }
  }
}

function toWireTool(tool: ToolSchema): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}

function mapFinishReason(raw: string): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop'
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    case 'length':
      return 'length'
    default:
      return 'unknown'
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return truncate(text.trim(), 400)
  } catch {
    return ''
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
  )
}

function toModelError(err: unknown): ModelError {
  if (err instanceof Error) {
    return { kind: 'network', message: err.message, cause: err }
  }
  return { kind: 'unknown', message: String(err), cause: err }
}

function truncate(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
