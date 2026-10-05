/**
 * token 估算的自我校准。
 *
 * ## 为什么这比「拿到上下文长度」更有用
 *
 * 上下文窗口只是**分母**，而我们真正需要的是**分子准不准**。
 * 估算要是偏了 2 倍，任何窗口大小下你的判断都是错的——
 * 要么过早压缩（无谓地丢历史），要么过晚（直接爆）。窗口值你至少可以声明，
 * 而估算的误差没有任何配置项能修。
 *
 * ## 好消息：真实值每次调用都有
 *
 * OpenAI 兼容端点的 `usage.prompt_tokens` 就是**这次请求真实的输入 token 数**。
 * 拿它去除我们自己的估算，得到一个系数；把这个系数乘回后续的估算上，
 * 估算就会**收敛到那家模型真实的分词器**——不需要分词器本身。
 *
 * ## 为什么要有钳制
 *
 * 单次观测可能不可靠：
 * - 有的端点把 reasoning token 也算进 prompt
 * - 有的端点返回 0 或缺失
 * - 首次请求可能包含一次性的前缀
 *
 * 所以：**样本要么被拒收（actual <= 0），要么被钳制在 [0.4, 3] 内**，
 * 并且第一次直接采用、之后走指数滑动平均。宁可慢一点收敛，也不要被一个野点带跑。
 */

/** 单次观测允许的比值范围。超出说明这次观测不可信，钳到边界 */
const MIN_RATIO = 0.4
const MAX_RATIO = 3

/** 指数滑动平均的权重。越大越信新样本 */
const ALPHA = 0.3

export interface CalibrationSnapshot {
  /** 乘在估算上的系数。1 = 尚未校准 */
  factor: number
  samples: number
  lastEstimated: number
  lastActual: number
  /** 是否已经用真实数据校准过 */
  calibrated: boolean
}

export class TokenCalibration {
  #factor = 1
  #samples = 0
  #lastEstimated = 0
  #lastActual = 0

  /**
   * 记录一次「估算 vs 真实」。
   *
   * @returns 这次观测是否被采纳
   */
  observe(estimated: number, actual: number): boolean {
    // 端点没给 usage，或给了 0 —— 拒绝，不要污染系数
    if (!Number.isFinite(actual) || actual <= 0) return false
    if (!Number.isFinite(estimated) || estimated <= 0) return false

    const raw = actual / estimated
    const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, raw))

    this.#factor = this.#samples === 0 ? ratio : this.#factor * (1 - ALPHA) + ratio * ALPHA
    this.#samples += 1
    this.#lastEstimated = estimated
    this.#lastActual = actual
    return true
  }

  /** 把估算换算成校准后的值 */
  apply(estimate: number): number {
    if (this.#samples === 0) return estimate
    return Math.ceil(estimate * this.#factor)
  }

  get factor(): number {
    return this.#factor
  }

  get samples(): number {
    return this.#samples
  }

  get calibrated(): boolean {
    return this.#samples > 0
  }

  snapshot(): CalibrationSnapshot {
    return {
      factor: Number(this.#factor.toFixed(3)),
      samples: this.#samples,
      lastEstimated: this.#lastEstimated,
      lastActual: this.#lastActual,
      calibrated: this.calibrated,
    }
  }

  reset(): void {
    this.#factor = 1
    this.#samples = 0
    this.#lastEstimated = 0
    this.#lastActual = 0
  }
}
