/**
 * 输入框（悬浮、会随内容变高）与正文滚动位置之间的关系。
 *
 * ## 为什么这段要单独成模块
 *
 * 它原来是埋在 `App.tsx` 一个 effect 里的两行算术 —— 而那个 bug（"输入框挡住正文"）
 * 恰恰出在**这两行算术少了一半**上：只改了底部留白，没挪滚动位置。
 * 埋在 effect 里的算术测不到（这个项目没有 DOM 测试环境，也不打算为它引 jsdom），
 * 所以把**判据**抽出来，让它能被普通的单元测试盯住。
 *
 * 留在 `App.tsx` 那边的只剩"读元素、写样式"这种一次性的胶水。
 */

/**
 * 「算贴着底部」的阈值（像素）。
 *
 * 32 是个宽松值：用户滚到"几乎到底"时也该继续跟随，卡在 0 会让"差一点点"
 * 就停止跟随，看起来像跟随坏了。
 *
 * ⚠️ **这个值只有一处定义。** 判"要不要跟随"和判"要不要跟着挪"必须用同一个阈值 ——
 * 两处各写一个数，就会出现"它认为贴底、它认为没贴底"这种两边都自洽、合起来错的行为。
 */
export const STICK_THRESHOLD_PX = 32

/** 滚动位置的三个数（就是元素上那三个属性的样子） */
export interface ScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

/** 现在算不算"贴着底部" */
export function isAtBottom(metrics: ScrollMetrics): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < STICK_THRESHOLD_PX
}

/**
 * 输入框高度变了之后，正文该跟着滚多少像素。
 *
 * 返回 `0` 表示**一动不动** —— 这不只是"没有变化"的意思，它是那条保证：
 * **用户往上翻着读的时候，绝不把他拽走**。
 *
 * @param atBottom 判据要用**高度变化之前**的滚动位置算（变了之后再算，
 *                 会因为留白已经变大而误判成"没贴底"）
 */
export function stickDelta(input: {
  atBottom: boolean
  previousHeight: number
  height: number
}): number {
  const delta = input.height - input.previousHeight
  if (delta === 0) return 0
  return input.atBottom ? delta : 0
}
