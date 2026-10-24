/**
 * 子代理工具：`spawn_agent`。
 *
 * ## 它买到的到底是什么
 *
 * **不是并行** —— 本机引擎是单槽位的（`llama-server --parallel 1`），
 * 两个模型调用同时发出去，第二个只是排队。所以拿"子代理"当"更快"是错的。
 *
 * 它买到的是**上下文隔离**：
 *
 *   · 子代理有自己的消息历史，摸索过程（试错、读了一堆不相干文件、跑挂的构建）
 *     全留在它那边；
 *   · 交回来的只有一段**有界的结果** —— 这正好治"父会话被探索过程撑爆"；
 *   · 它跑在**同一个 policy 与同一个恢复层**之下（见 `spawnAgent` 的实现），
 *     所以这不是"绕过权限的旁路" —— 这是它和别的实现最不一样的地方。
 *
 * ## 为什么标成 `execute`
 *
 * 它可能读到、改到、跑到任何东西 —— 按**可能的最坏后果**标。
 * 在 `workspace-write` 下它会**要一次确认**（合理：这是"放一个新 agent 出去"）；
 * 在 `full-access` 下不问。
 *
 * ## 为什么没有参数
 *
 * 只收 `prompt` 与 `name` 两个。工具子集、模型、温度这些**刻意不给** ——
 * 每多一个旋钮，就多一种"子代理和父代理行为不一致"的状态，
 * 而那种不一致**不报错**，只会让结果没法解释。
 */

import { failResult, okResult, type Tool } from './types.ts'

interface SpawnAgentArgs {
  /** 交给子代理的任务。要能独立完成 —— 它看不到父会话的历史 */
  prompt: string
  /** 日志里用的短名字，可选 */
  name?: string
}

/** 交回来的结果上限。超了就截断并**明确说明**被截断了，不静默丢内容 */
const MAX_RESULT_CHARS = 8_000

export const spawnAgentTool: Tool<SpawnAgentArgs> = {
  name: 'spawn_agent',
  description:
    '把一件独立的子任务交给一个子代理去做，它跑完后只把结论交回来。' +
    '适合"需要翻很多文件才得出结论"的活：它的探索过程不会占你的上下文。' +
    '注意：它看不到你们的对话历史，所以 prompt 要写完整；也不能并行（引擎单槽位）。',
  risk: 'execute',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          '交给子代理的完整任务。它看不到当前对话，所以要自带背景、目标和验收标准。',
      },
      name: {
        type: 'string',
        description: '给这次委派起个短名字（只用于日志与错误信息），例如 find-auth-entry。',
      },
    },
    required: ['prompt'],
  },

  async run(args, ctx) {
    const prompt = String(args.prompt ?? '').trim()
    if (prompt === '') {
      return failResult('invalid_args', 'prompt 不能为空 —— 子代理看不到当前对话，必须把任务写完整。')
    }

    if (ctx.spawnAgent === undefined) {
      /*
       * **明确失败，不退化** —— 没有这个能力时不要假装成功
       * （那种"看起来做了"的失败，比没做更糟）。
       */
      return failResult(
        /*
         * 用 `failed` 而不是新造一个码 —— 错误码是**模型据以决定下一步**的契约，
         * 加一个新码就得保证所有消费方都认识它。而这里希望的下一步很明确：
         * 「你自己做这件事」，那和普通失败的处理方式一样。
         */
        'failed',
        '这个环境没有子代理能力（宿主没有注入 spawnAgent）。请自己完成这件事。',
      )
    }

    let outcome
    try {
      outcome = await ctx.spawnAgent({ prompt, ...(args.name === undefined ? {} : { name: args.name }), ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) })
    } catch (err) {
      /* 子代理失败要**如实**回到父代理手里 —— 让它自己决定重试还是换路 */
      return failResult(
        'failed',
        `子代理没跑完：${err instanceof Error ? err.message : String(err)}`,
      )
    }

    const raw = outcome.text.trim()
    const truncated = raw.length > MAX_RESULT_CHARS
    const text = truncated ? raw.slice(0, MAX_RESULT_CHARS) : raw

    const head =
      `子代理（${outcome.sessionId.slice(0, 8)}）跑完 ${outcome.turns} 轮，` +
      `${outcome.usage === undefined ? '' : `用了 ${outcome.usage.inputTokens + outcome.usage.outputTokens} tokens，`}` +
      `结果${truncated ? `被截断到 ${MAX_RESULT_CHARS} 字` : `${text.length} 字`}：`

    return okResult(`${head}\n\n${text === '' ? '（它没有给出文字结论）' : text}`, {
      sessionId: outcome.sessionId,
      turns: outcome.turns,
      ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
      truncated,
    })
  },
}
