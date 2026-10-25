/**
 * 成本：**usage × 单价**。
 *
 * ## 为什么单独一个文件
 *
 * 单价是用户填的，而额度是模型报的，两者相乘这件事本身没有争议；有争议的是
 * 「算不出来时怎么办」。这个文件的态度是：**算不出来就说算不出来，不填 0。**
 *
 * 一个假的 0 比没有更糟 —— 用户会以为这个会话不要钱。
 *
 * ## 缓存命中的价格
 *
 * 大多数供应商对命中提示缓存的那部分输入**单独计价**（通常是输入价的 10%–50%）。
 * 所以这里支持 `cachedInputPerMTok`：
 *
 *   · 填了 → 按它算
 *   · 没填 → **按输入价算**（保守：宁可高估，不要低估账单）
 *
 * 后一条是取舍，不是疏漏：低估会让人以为很便宜，高估只是让人多看一眼。
 */

import type { Pricing } from '../config/types.ts'

export interface UsageLike {
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
}

export interface Cost {
  /** 输入部分（含缓存命中） */
  input: number
  /** 输出部分 */
  output: number
  /** 合计 */
  total: number
  /** ISO 4217 代码，默认 USD */
  currency: string
  /**
   * 这次计算里**缓存命中按什么价算的**。
   *
   * 说出来是有意义的：用户填了输入价却没填缓存价时，看到的数字以后者为准，
   * 而账单上大概率更低 —— 这个差异必须能被看出来。
   */
  cachedPricing: 'separate' | 'same-as-input'
}

/** 一份小于一美分的结果保留 6 位有效数字就够了，不要打印 1e-7 那种东西 */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/**
 * 算一次成本。**没有单价就返回 `undefined`** —— 不要返回 0。
 */
export function computeCost(usage: UsageLike, pricing: Pricing | undefined): Cost | undefined {
  if (pricing === undefined) return undefined
  if (pricing.inputPerMTok === undefined && pricing.outputPerMTok === undefined) return undefined

  const currency = pricing.currency ?? 'USD'
  const inputPrice = pricing.inputPerMTok ?? 0
  const outputPrice = pricing.outputPerMTok ?? 0

  /*
   * 缓存命中那一部分**已经从 inputTokens 里算过了吗**？
   *
   * OpenAI 形状里 `prompt_tokens` 是总数、`prompt_tokens_details.cached_tokens`
   * 是其中命中缓存的部分。所以这里按"含在内"处理：拆成两块分别乘价。
   */
  const cached = Math.max(0, Math.min(usage.cachedTokens ?? 0, usage.inputTokens))
  const fresh = Math.max(0, usage.inputTokens - cached)

  const cachedPrice = pricing.cachedInputPerMTok
  const inputPart = (fresh * inputPrice + cached * (cachedPrice ?? inputPrice)) / 1_000_000
  const outputPart = (usage.outputTokens * outputPrice) / 1_000_000

  return {
    input: round(inputPart),
    output: round(outputPart),
    total: round(inputPart + outputPart),
    currency,
    cachedPricing: cachedPrice === undefined ? 'same-as-input' : 'separate',
  }
}
