/**
 * 脚本化模型：**没有可用模型时，让 eval 仍然能证明自己是活的**。
 *
 * 它按固定脚本回答：第一轮读一下工作区里的文件，第二轮给一句收尾。
 * 它对模型质量**没有任何结论** —— 这是它的用途，也是它的局限，
 * 所以 CLI 会在报告里把 `scripted: true` 标出来，汇总行还会明说一句。
 *
 * 为什么需要它：评估工具最容易坏的地方不是断言，是**跑不起来**
 * （模型连不上、环境不对、超时没人管）。那些故障在没有模型的日子里
 * 会一直藏着，直到第一次真跑才暴露。给一条不依赖网络的路径，
 * 至少让"跑不起来"和"跑起来但不通过"这两件事分得开。
 */

import type { ModelClient, ModelEvent } from '../model/types.ts'

export interface ScriptedOptions {
  /** 第一轮要调用的工具；给 null 表示第一轮直接说话 */
  tool?: { name: string; args: Record<string, unknown> } | null
  /** 收尾正文 */
  finalText?: string
}

/** 按调用次数轮流出脚本：第 1 次工具调用，第 2 次收尾，之后一直收尾 */
export function createScriptedModel(options: ScriptedOptions = {}): ModelClient {
  const tool = options.tool === undefined ? { name: 'read_file', args: { path: 'README.md' } } : options.tool
  const finalText = options.finalText ?? '看完了，没有别的问题。'
  let turn = 0

  return {
    stream(): AsyncIterable<ModelEvent> {
      turn += 1
      const events: ModelEvent[] = []

      if (turn === 1 && tool !== null) {
        events.push({
          type: 'tool_call_delta',
          index: 0,
          id: `scripted-${turn}`,
          name: tool.name,
          argsJsonDelta: JSON.stringify(tool.args),
        })
        events.push({ type: 'done', reason: 'tool_calls' })
      } else {
        events.push({ type: 'text_delta', text: finalText })
        events.push({ type: 'done', reason: 'stop' })
      }

      return (async function* generate() {
        for (const event of events) yield event
      })()
    },
  }
}
