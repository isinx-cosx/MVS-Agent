/**
 * 模型层的唯一契约：请求进，事件流出。
 *
 * 两条不可动摇的设计约束：
 *
 * 1. 流式是原语，不是可选功能。
 *    字符串随时能从流里塌缩出来（见 collect.ts），反过来不行。
 *    一旦这里暴露的是 `Promise<string>`，以后想加流式就要改穿每一层。
 *
 * 2. 能力缺失必须是可观测的降级，不是崩溃。
 *    不同兼容端点的能力不一致（有的不给 usage，有的不给 reasoning）。
 *    所以 Notice 是一等事件，上层永远不许假设某个字段一定存在。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  /**
   * 原始 JSON 字符串，**故意不在这里解析**。
   * 参数校验是工具层的职责：模型层只负责把碎片拼回来。
   */
  argsJson: string
}

export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content: string
      toolCalls?: ToolCall[]
      /**
       * 这一段思考的**完整文本**（不是逐 token 的增量）。
       *
       * ## 它只走展示那条路，**不发回模型**
       *
       * `openai-compatible.ts` 构造请求时是 `{ role:'assistant', content }` ——
       * 显式列出字段，所以这个值不会出现在 wire 上。那是有意的：
       *
       *   · llama.cpp 的 chat template **支持**保留 reasoning（它的日志里
       *     写着「preserving reasoning, enabled by default」），但把思考
       *     回灌会**显著增加 token**，而 agent 每一轮都要付这份钱。
       *   · 而且没有那一层的话，历史里的思考会越积越多，压缩策略也得跟着改。
       *
       * 所以留在这里是为了**投影和界面**（`rebuildMessages` 要能重建出它、
       * 垫片要能把它画出来），不是为了让模型再看一遍。
       */
      reasoning?: string
    }
  | { role: 'tool'; content: string; toolCallId: string }

export interface ToolSchema {
  name: string
  description?: string
  /** JSON Schema 对象。形状先定死，本版不实现工具循环。 */
  parameters: Record<string, unknown>
}

export interface ModelRequest {
  model: string
  messages: Message[]
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  /** 一路穿到底，中间不许吞掉 */
  signal?: AbortSignal
}

export type FinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'aborted'
  | 'error'
  | 'unknown'

export interface Usage {
  inputTokens: number
  outputTokens: number
  /**
   * 有多少输入 token 命中了引擎的提示缓存。
   *
   * 来自 OpenAI 标准字段 `usage.prompt_tokens_details.cached_tokens` ——
   * **流式下也在最后一帧**（只要请求带了 `stream_options.include_usage`，
   * 我们的客户端默认就带）。实测本机 llama.cpp 会给出这个字段。
   *
   * 缓存命中率 = `cachedTokens / inputTokens`（`timings` 里 `cache_n / (cache_n + prompt_n)`
   * 是同一个比值）。
   */
  cachedTokens?: number
  /**
   * 引擎自报的生成速度（token/秒）。
   *
   * 来自 llama.cpp 顶层的 `timings.predicted_per_second`（实测在流式最后一帧）。
   * 它比我们在界面上按字数估的准 —— 但**只在一次调用结束后才有**。
   */
  tokensPerSecond?: number
}

export type ModelErrorKind =
  /** 连接失败、TCP 中断、DNS 等 */
  | 'network'
  /** 拿到了 HTTP 响应但状态码非 2xx */
  | 'http'
  /** 响应形状不符合预期（缺 body、SSE 无法解析等） */
  | 'protocol'
  | 'aborted'
  | 'unknown'

export interface ModelError {
  kind: ModelErrorKind
  message: string
  status?: number
  cause?: unknown
}

/** 能力缺失 / 降级的可观测记录 */
export interface Notice {
  code:
    /** 服务端没有返回 usage —— 常见于兼容网关与本地推理，属正常降级 */
    | 'missing_usage'
    /** 流在没有 [DONE]、也没有 finish_reason 的情况下结束了 */
    | 'truncated_stream'
    /** 单条 SSE data 无法解析 */
    | 'bad_sse_data'
    | (string & {})
  message: string
}

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  /** 思维链。DeepSeek 用 reasoning_content，部分端点用 reasoning */
  | { type: 'reasoning_delta'; text: string }
  /**
   * 工具调用参数是**按 index 分组的 JSON 碎片**，必须累积后才能解析。
   * 哪怕本版不做工具循环，这个位置也必须先留着 —— 否则以后要重写模型层。
   */
  | {
      type: 'tool_call_delta'
      index: number
      id?: string
      name?: string
      argsJsonDelta?: string
    }
  | { type: 'usage'; usage: Usage }
  | { type: 'notice'; notice: Notice }
  | { type: 'done'; reason: FinishReason }
  /** 流中途失败也是事件，不是异常 —— 上层要能区分「没开始」和「吐了一半」 */
  | { type: 'error'; error: ModelError }

export interface ModelClient {
  stream(req: ModelRequest): AsyncIterable<ModelEvent>
}
