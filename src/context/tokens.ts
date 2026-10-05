/**
 * token 估算。
 *
 * ⚠️ **这是估算，不是分词。** 真正的分词需要 tokenizer —— 一份几百 KB 的数据
 * 文件加一份实现。
 *
 * 加它是**可以**的（开发机上 npm 是通的），我们只是**没加**：估算的用途只有
 * 「判断离撑爆还有多远」，而它已经靠真实 `usage.prompt_tokens` 校准到各家分词器
 * 上了（见 `calibration.ts`）。为了一个判定阈值把一份第三方数据文件带进长期演进
 * 的路径，不划算。
 *
 * 估算的用途只有一个：**判断「离撑爆还有多远」**。用来算钱的精度不够，
 * 用来决定「该不该压缩」足够了。误差方向要偏保守（宁可高估）。
 *
 * 分三类粗略计权：
 * - ASCII：约 4 字符 1 token
 * - CJK：约 1 字符 1 token（中文基本一字一 token）
 * - 其他（emoji、其他文种）：折中
 */

import type { Message } from '../model/types.ts'

const CJK_RANGES: Array<[number, number]> = [
  [0x3000, 0x303f], // CJK 标点
  [0x3040, 0x30ff], // 假名
  [0x3400, 0x4dbf], // 扩展 A
  [0x4e00, 0x9fff], // 基本汉字
  [0xf900, 0xfaff], // 兼容汉字
  [0xff00, 0xffef], // 全角
]

function isCjk(code: number): boolean {
  for (const [start, end] of CJK_RANGES) {
    if (code >= start && code <= end) return true
  }
  return false
}

export function estimateTokens(text: string): number {
  let ascii = 0
  let cjk = 0
  let other = 0

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) ascii += 1
    else if (isCjk(code)) cjk += 1
    else other += 1
  }

  // 向上取整并留一点余量，宁可高估
  return Math.ceil(ascii / 3.5 + cjk * 1.05 + other * 0.7)
}

/** 每条消息的结构开销（角色、分隔符、工具调用包裹等） */
const PER_MESSAGE_OVERHEAD = 6

export function estimateMessageTokens(message: Message): number {
  let total = PER_MESSAGE_OVERHEAD + estimateTokens(message.content)

  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += PER_MESSAGE_OVERHEAD
      total += estimateTokens(call.name)
      total += estimateTokens(call.argsJson)
    }
  }

  return total
}

/**
 * @param calibrationFactor 来自 {@link TokenCalibration} 的校准系数。1 = 不校准。
 *   这个系数的意义是：**让估算收敛到那家模型真实的分词器**，而我们并不需要分词器本身。
 */
export function estimateConversationTokens(
  messages: readonly Message[],
  calibrationFactor = 1,
): number {
  let total = 0
  for (const message of messages) total += estimateMessageTokens(message)
  return calibrationFactor === 1 ? total : Math.ceil(total * calibrationFactor)
}

export function describeBudget(used: number, budget: number): string {
  const percent = budget === 0 ? 0 : Math.round((used / budget) * 100)
  return `${used} / ${budget} 估算 token（${percent}%）`
}
