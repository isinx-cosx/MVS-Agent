/**
 * 探测模型元信息。
 *
 * ## 为什么不一律靠 /v1/models
 *
 * OpenAI 兼容的 `GET /v1/models` **绝大多数情况下只返回 id**：
 *
 * ```json
 * { "object": "list", "data": [{ "id": "gpt-4o", "object": "model", "owned_by": "system" }] }
 * ```
 *
 * 上下文长度**不在里面**。OpenAI、DeepSeek、Anthropic 的兼容层都不给。
 *
 * 但有几家确实给，而且给了就比我们猜得准：
 *
 * | 来源 | 字段 | 谁会返回 |
 * |---|---|---|
 * | `GET /v1/models` | `max_model_len` | vLLM |
 * | `GET /v1/models` | `context_length` | OpenRouter 等网关 |
 * | `POST /api/show` | `model_info.<arch>.context_length` | **Ollama** |
 * | `GET /props` | `default_generation_settings.n_ctx` | llama.cpp |
 *
 * 所以策略是：**挨个试，试到就如实报告来源，试不到就明说试不到。**
 * 绝不因为探测失败就假装知道，也绝不因为探测成功就当成权威——
 * 探测到的值也会在启动横幅里标明来源，用户能看出它是「查到的」还是「你声明的」。
 */

const PROBE_TIMEOUT_MS = 5_000

export type ProbeSource = 'openai-models' | 'ollama-show' | 'llama-props' | 'none'

export interface ProbeResult {
  /** 探测到的上下文长度。undefined = 没探到 */
  contextLength?: number
  source: ProbeSource
  /** 原始证据片段，便于诊断「为什么是这个数」 */
  evidence?: string
  /** 探测过程中的错误（网络不通、404 等）。**不是致命问题** */
  error?: string
}

export interface ProbeOptions {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
  /** 注入点：测试用假 fetch */
  fetch?: typeof globalThis.fetch
}

/** 兼容层里可能承载上下文长度的字段名，按可信度排序 */
const CONTEXT_FIELDS = [
  'max_model_len',
  'context_length',
  'context_window',
  'max_context_length',
  'max_input_tokens',
  'n_ctx',
]

export async function probeContextLength(options: ProbeOptions): Promise<ProbeResult> {
  const doFetch = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  const notes: string[] = []

  const attempts: Array<{ label: string; run: () => Promise<ProbeResult> }> = [
    { label: '/v1/models', run: () => probeOpenAIModels(options, doFetch, timeoutMs) },
    { label: '/api/show', run: () => probeOllamaShow(options, doFetch, timeoutMs) },
    { label: '/props', run: () => probeLlamaProps(options, doFetch, timeoutMs) },
  ]

  for (const attempt of attempts) {
    try {
      const result = await attempt.run()
      if (result.contextLength !== undefined) return result

      // ★ 「端点通了、但返回里没有这个字段」必须也留下说明。
      //
      // 一开始我只收集抛出来的异常，结果最常见的那个情况（/v1/models 正常返回、
      // 里面只有 id）完全没有诊断信息 —— 用户看到的是一串 404，
      // 会以为是端点不通，而实际是端点通、只是那家不给窗口。
      if (result.error !== undefined) notes.push(`${attempt.label}：${result.error}`)
    } catch (err) {
      notes.push(`${attempt.label}：${messageOf(err)}`)
    }
  }

  return {
    source: 'none',
    error: notes.length > 0 ? notes.join('；') : '没有可用的探测端点',
  }
}

// ---------------------------------------------------------------------------

async function probeOpenAIModels(
  options: ProbeOptions,
  doFetch: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  const root = stripVersionSuffix(options.baseUrl)
  const response = await fetchJson(
    doFetch,
    `${options.baseUrl.replace(/\/+$/, '')}/models`,
    options.apiKey,
    undefined,
    timeoutMs,
  )

  const entries = Array.isArray(response.data) ? response.data : []
  // 先找与被请求模型同名的条目；找不到就退回第一个
  const match =
    entries.find((entry) => isRecord(entry) && entry.id === options.model) ??
    entries.find((entry) => isRecord(entry))

  if (!isRecord(match)) return { source: 'none', error: `模型列表里没有 ${options.model}` }

  for (const field of CONTEXT_FIELDS) {
    const value = match[field]
    if (typeof value === 'number' && value > 0) {
      return {
        source: 'openai-models',
        contextLength: value,
        evidence: `${root}/v1/models 里 ${options.model} 的 ${field}=${value}`,
      }
    }
  }

  return {
    source: 'none',
    error: `/v1/models 只返回了 ${Object.keys(match).join('、')}，没有上下文长度。这是 OpenAI / DeepSeek 这类端点的常态`,
  }
}

async function probeOllamaShow(
  options: ProbeOptions,
  doFetch: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  const root = stripVersionSuffix(options.baseUrl)
  const response = await fetchJson(
    doFetch,
    `${root}/api/show`,
    options.apiKey,
    // 新旧版本的字段名不同，两个都带上
    { name: options.model, model: options.model },
    timeoutMs,
  )

  const info = response.model_info
  if (!isRecord(info)) return { source: 'none', error: '/api/show 没有 model_info' }

  // key 带架构前缀，例如 qwen2.context_length / llama.context_length
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith('context_length')) continue
    if (typeof value === 'number' && value > 0) {
      return {
        source: 'ollama-show',
        contextLength: value,
        evidence: `${root}/api/show 的 model_info.${key}=${value}`,
      }
    }
  }

  return { source: 'none', error: '/api/show 的 model_info 里没有 context_length' }
}

async function probeLlamaProps(
  options: ProbeOptions,
  doFetch: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  const root = stripVersionSuffix(options.baseUrl)
  const response = await fetchJson(
    doFetch,
    `${root}/props`,
    options.apiKey,
    undefined,
    timeoutMs,
  )

  const settings = response.default_generation_settings
  if (isRecord(settings) && typeof settings.n_ctx === 'number' && settings.n_ctx > 0) {
    return {
      source: 'llama-props',
      contextLength: settings.n_ctx,
      evidence: `${root}/props 的 default_generation_settings.n_ctx=${settings.n_ctx}`,
    }
  }
  if (typeof response.n_ctx === 'number' && response.n_ctx > 0) {
    return {
      source: 'llama-props',
      contextLength: response.n_ctx,
      evidence: `${root}/props 的 n_ctx=${response.n_ctx}`,
    }
  }

  return { source: 'none', error: '/props 没有 n_ctx' }
}

// ---------------------------------------------------------------------------

/** http://host:11434/v1 → http://host:11434 */
export function stripVersionSuffix(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/, '')
}

async function fetchJson(
  doFetch: typeof globalThis.fetch,
  url: string,
  apiKey: string | undefined,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (apiKey !== undefined && apiKey !== '') headers.authorization = `Bearer ${apiKey}`

    const response = await doFetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const parsed: unknown = await response.json()
    if (!isRecord(parsed)) throw new Error('响应不是 JSON 对象')
    return parsed
  } finally {
    clearTimeout(timer)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.name === 'AbortError' ? '超时' : err.message
  }
  return String(err)
}
