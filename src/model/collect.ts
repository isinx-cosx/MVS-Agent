/**
 * 阻塞式消费者。
 *
 * 注意它**不是第二套实现** —— 它是流的派生物，只是把所有 delta 收干。
 * 需要边到边显示（CLI、UI）的场景请直接消费 stream()，别走这里。
 */

import type {
  FinishReason,
  ModelError,
  ModelEvent,
  Notice,
  ToolCall,
  Usage,
} from './types.ts'

export interface ModelOutput {
  text: string
  reasoning: string
  toolCalls: ToolCall[]
  usage?: Usage
  finishReason: FinishReason
  notices: Notice[]
  /** 模型错误不抛异常，而是记在这里 —— 与「错误是一等事件」保持一致 */
  error?: ModelError
}

export interface CollectOptions {
  /**
   * 逐个事件的旁观回调。
   *
   * 有了它，调用方既能拿到**流式增量**（推给 UI），又能拿到**完整结果**，
   * 而不必复制一遍累积逻辑。这是「流式是原语」那条设计的红利：
   * 阻塞式消费者与流式消费者共用同一条路径。
   */
  onEvent?: (event: ModelEvent) => void
}

export async function collect(
  stream: AsyncIterable<ModelEvent>,
  options: CollectOptions = {},
): Promise<ModelOutput> {
  const { onEvent } = options
  let text = ''
  let reasoning = ''
  let usage: Usage | undefined
  let finishReason: FinishReason = 'unknown'
  let error: ModelError | undefined
  const notices: Notice[] = []

  // 工具调用参数要按 index 累积：碎片本身不是合法 JSON
  const fragments = new Map<number, { id?: string; name?: string; argsJson: string }>()

  for await (const event of stream) {
    onEvent?.(event)

    switch (event.type) {
      case 'text_delta':
        text += event.text
        break
      case 'reasoning_delta':
        reasoning += event.text
        break
      case 'tool_call_delta': {
        let fragment = fragments.get(event.index)
        if (!fragment) {
          fragment = { argsJson: '' }
          fragments.set(event.index, fragment)
        }
        if (event.id !== undefined) fragment.id = event.id
        if (event.name !== undefined) fragment.name = event.name
        if (event.argsJsonDelta !== undefined) fragment.argsJson += event.argsJsonDelta
        break
      }
      case 'usage':
        usage = event.usage
        break
      case 'notice':
        notices.push(event.notice)
        break
      case 'done':
        finishReason = event.reason
        break
      case 'error':
        error = event.error
        finishReason = 'error'
        break
    }
  }

  const toolCalls: ToolCall[] = [...fragments.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, fragment]) => ({
      id: fragment.id ?? `call_${index}`,
      name: fragment.name ?? '',
      argsJson: fragment.argsJson,
    }))

  return { text, reasoning, toolCalls, usage, finishReason, notices, error }
}

/**
 * 解析工具参数。
 *
 * 放在这里而不是模型层：模型层只负责把碎片拼回来，校验是工具层的职责。
 * 拼出来的东西完全可能是坏 JSON（流被截断、模型抽风），所以显式报错。
 */
export function parseToolArgs(call: ToolCall): unknown {
  const raw = call.argsJson.trim()
  if (raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error(
      `工具 ${call.name || '(未命名)'} 的参数不是合法 JSON：${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw}`,
    )
  }
}
