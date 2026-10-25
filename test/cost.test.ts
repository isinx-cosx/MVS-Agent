/**
 * 成本：`用量 × 单价`。
 *
 * 这一组守的不是算术，而是**"算不出来时说什么"**：
 *
 *   · 没有单价 → `undefined`，**不是 0**（假的 0 会让人以为不要钱）
 *   · 缓存价没填 → 按输入价算，并且把这件事记在 `cachedPricing` 里
 *   · 缓存 token 多于输入 token（端点自相矛盾时）→ 不产生负数
 *   · 只在 `providers` 段配了单价 → 也能取到
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { computeCost } from '../src/model/cost.ts'
import { normalizeConfig } from '../src/config/index.ts'
import { resolveConfig } from '../src/config/resolve.ts'
import { defaultConfig } from '../src/config/types.ts'

test('成本：没有单价 → undefined（不是 0）', () => {
  assert.equal(computeCost({ inputTokens: 100, outputTokens: 50 }, undefined), undefined)
  /* 空对象也算"没填" —— 只写个空 pricing 不该被当成 0 元 */
  assert.equal(computeCost({ inputTokens: 100, outputTokens: 50 }, {}), undefined)
})

test('成本：输入与输出分开计价', () => {
  const cost = computeCost(
    { inputTokens: 1_000_000, outputTokens: 500_000 },
    { inputPerMTok: 3, outputPerMTok: 12 },
  )
  assert.ok(cost !== undefined)
  assert.equal(cost.input, 3)
  assert.equal(cost.output, 6)
  assert.equal(cost.total, 9)
  assert.equal(cost.currency, 'USD')
})

test('成本：缓存命中单独计价时按缓存价算', () => {
  const cost = computeCost(
    { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 800_000 },
    { inputPerMTok: 3, cachedInputPerMTok: 0.3 },
  )
  assert.ok(cost !== undefined)
  /* 20 万按 3 元 + 80 万按 0.3 元 */
  assert.equal(cost.input, 0.6 + 0.24)
  assert.equal(cost.cachedPricing, 'separate')
})

test('成本：没填缓存价 → 按输入价算，并且**说出来**', () => {
  const cost = computeCost(
    { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 800_000 },
    { inputPerMTok: 3 },
  )
  assert.ok(cost !== undefined)
  assert.equal(cost.input, 3)
  assert.equal(cost.cachedPricing, 'same-as-input')
})

test('成本：缓存 token 比输入还多（端点自相矛盾）→ 不出现负数', () => {
  const cost = computeCost(
    { inputTokens: 100, outputTokens: 0, cachedTokens: 500 },
    { inputPerMTok: 1 },
  )
  assert.ok(cost !== undefined)
  assert.ok(cost.input >= 0, `实际 ${cost.input}`)
  assert.equal(cost.input, 0.0001)
})

test('成本：货币代码会被带上，且规范成大写', () => {
  const normalized = normalizeConfig({
    version: 1,
    model: { pricing: { inputPerMTok: 1, currency: 'cny' } },
  })
  assert.equal(normalized.config.model?.pricing?.currency, 'CNY')
  const resolved = resolveConfig({ config: defaultConfig(), overrides: {}, env: {} })
  assert.equal(resolved.pricing, undefined, '默认没有单价 —— 不该凭空出现一个')
})

test('成本：pricing 写错 → 警告里指出是哪一项、值是多少', () => {
  const result = normalizeConfig({
    version: 1,
    model: { pricing: { inputPerMTok: -1, currency: 'dollars' } },
  })
  const warnings = result.warnings.join('\n')
  assert.match(warnings, /pricing\.inputPerMTok/)
  assert.match(warnings, /-1/)
  assert.match(warnings, /pricing\.currency/)
  assert.equal(result.config.model?.pricing, undefined, '全部非法时不该留下半份定价')
})

test('成本：providers 段里的单价也能被解析出来', () => {
  const result = normalizeConfig({
    version: 1,
    providers: { deepseek: { model: 'deepseek-chat', pricing: { inputPerMTok: 2, outputPerMTok: 8 } } },
    activeProvider: 'deepseek',
  })
  assert.deepEqual(result.config.providers?.deepseek?.pricing, {
    inputPerMTok: 2,
    outputPerMTok: 8,
  })
})
