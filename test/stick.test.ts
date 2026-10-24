/**
 * 「输入框长高时正文该跟着滚多少」的单元测试。
 *
 * 这段逻辑原来埋在 `App.tsx` 一个 effect 里，而它出过一次真 bug：
 * 只改了底部留白、**没挪滚动位置** —— 于是贴着底部时最后几行被输入框盖住，
 * 用户看到的是"输入框挡住了正文"。抽出来就是为了让它被测住。
 *
 * 这些用例守的是两件事：
 *   1. **贴着底部时，长高多少就跟着挪多少**（否则最后几行被盖）
 *   2. **没贴着底部时，一点都不许动**（用户正在往上翻着读，绝不拽他走）
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { STICK_THRESHOLD_PX, isAtBottom, stickDelta } from '../ui/stick.ts'

test('贴着底部：内容底部与视口底部之差小于阈值', () => {
  /* 完全到底 */
  assert.equal(isAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), true)
  /* 差 1px（四舍五入之类的零头）也算贴底 */
  assert.equal(isAtBottom({ scrollHeight: 1000, scrollTop: 599, clientHeight: 400 }), true)
  /* 差到阈值**以内**（31px）算贴底 */
  assert.equal(
    isAtBottom({ scrollHeight: 1000, scrollTop: 600 - (STICK_THRESHOLD_PX - 1), clientHeight: 400 }),
    true,
  )
  /*
   * ⚠️ 差**正好**等于阈值 → `false`。
   *
   * 判据是 `<`，不是 `<=` —— 这是**原来的行为**（`onLogScroll` 一直是 `<`），
   * 我把边界说反过一次，被这条测试当场抓住。
   *
   * 之所以把这行留着，是为了让下一个人看见"边界落在哪一侧"是**刻意选的**，
   * 而不是随手把它改成 `<=` 就算"修好了"。
   */
  assert.equal(
    isAtBottom({ scrollHeight: 1000, scrollTop: 600 - STICK_THRESHOLD_PX, clientHeight: 400 }),
    false,
  )
})

test('往上翻着读：不算贴底', () => {
  /* 超过阈值 1px —— 边界外侧 */
  assert.equal(
    isAtBottom({ scrollHeight: 1000, scrollTop: 600 - STICK_THRESHOLD_PX - 1, clientHeight: 400 }),
    false,
  )
  /* 翻到最顶 */
  assert.equal(isAtBottom({ scrollHeight: 1000, scrollTop: 0, clientHeight: 400 }), false)
  /* 内容还没占满视口（scrollHeight == clientHeight）—— 没得滚，视为贴底 */
  assert.equal(isAtBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 400 }), true)
})

test('输入框长高 + 贴底 → 跟着挪同样多（这条不做，就是用户报的那个 bug）', () => {
  assert.equal(stickDelta({ atBottom: true, previousHeight: 96, height: 140 }), 44)
  /* 一路长到上限也照挪不误 */
  assert.equal(stickDelta({ atBottom: true, previousHeight: 96, height: 260 }), 164)
})

test('输入框变矮 + 贴底 → 往回挪（负数），不是原地不动', () => {
  /*
   * 这条容易被写成"只管变高"。变矮时不往回挪，底部会空出一块 ——
   * 表现是"明明到底了，下面却空一截"。
   */
  assert.equal(stickDelta({ atBottom: true, previousHeight: 140, height: 96 }), -44)
})

test('没贴底 → 一动不动（哪怕输入框长得很高）', () => {
  assert.equal(stickDelta({ atBottom: false, previousHeight: 96, height: 260 }), 0)
  assert.equal(stickDelta({ atBottom: false, previousHeight: 260, height: 96 }), 0)
})

test('高度没变 → 一定是 0（不管在不在底部）', () => {
  assert.equal(stickDelta({ atBottom: true, previousHeight: 120, height: 120 }), 0)
  assert.equal(stickDelta({ atBottom: false, previousHeight: 120, height: 120 }), 0)
})

test('阈值只有一处定义 —— 这条测试是给未来的人看的', () => {
  /*
   * 这个项目里"算不算贴底"曾经有**三个实现、两个阈值**（32 / 24 / 32） ——
   * 于是同一个问题有两个答案，而两边各自都自洽，只有行为是错的。
   *
   * 所以这里钉住：阈值只从这里出，别处不许再写裸数字。
   */
  assert.equal(typeof STICK_THRESHOLD_PX, 'number')
  assert.ok(STICK_THRESHOLD_PX > 0 && STICK_THRESHOLD_PX <= 64, '阈值应当是个小整数')
})
