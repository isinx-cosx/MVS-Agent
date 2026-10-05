/**
 * 公式识别测试。
 *
 * ## 为什么值得单独一组
 *
 * 这条链出过两次故障，**都不是数学渲染器的问题**，而是被上一道工序改坏了：
 *
 *   1. `\[` `\(` 是 Markdown 转义、`\\` 会塌成 `\`、`_` `*` 会变强调 ——
 *      公式还没送到 KaTeX 就已经不是原来的公式了；
 *   2. "拒绝一个候选"的写法（`replace` 回调返回原串）**会把后面真正的公式一起吞掉**，
 *      于是"花了 $5 和 $10 元，然后 $\sin x$ 才是公式"整句一个都不渲染。
 *
 * 两类都只能靠**具体样例**挡住 —— 读代码看不出来。所以这里既验"抽出几个"，
 * 也验"抽出来的东西真的能被 KaTeX 渲染"，后者才是用户看到的结果。
 *
 * 测试直接 import `ui/math.ts`（产品代码那一段），不在这儿重抄规则：
 * 抄一遍就会漂移，漂移了测试就是假的。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import katex from 'katex'

import { looksLikeMath, maskMath, stripDelimiters } from '../ui/math.ts'

/* 用 String.raw：普通字符串字面量会把 `\b` `\\` 这类吃掉，而那正是要验的东西 */

/** 用户报过的第 1 条：块级 aligned，含换行 `\\` 与细空格 `\,` */
const ALIGNED = String.raw`$$
\begin{aligned}
\int x \sin x \, dx &= x(-\cos x) - \int (-\cos x) \, dx \\
&= -x \cos x + \int \cos x \, dx
\end{aligned}
$$`

/** 用户报过的第 2 条：中文段落里夹单 `$` 行内公式 */
const INLINE_CHINESE = String.raw`选取 $u$ 和 $dv$：
根据"LIATE"法则，代数函数 $x$ 优先于三角函数 $\sin x$ 被设为 $u$。
令 $u = x$，则 $du = dx$
令 $dv = \sin x \, dx$，则 $v = \int \sin x \, dx = -\cos x$`

/** 用 KaTeX 真渲染一遍；抛错就是失败 */
function render(tex: string, display: boolean): string {
  return katex.renderToString(tex, {
    displayMode: display,
    throwOnError: true,
    strict: 'ignore',
    trust: false,
  })
}

test('块级 aligned：公式先于 Markdown 被抽出，换行与细空格原样保留', () => {
  const { spans } = maskMath(ALIGNED)

  assert.equal(spans.length, 1)
  const span = spans[0]
  assert.ok(span !== undefined)
  assert.equal(span.display, true)
  assert.match(span.tex, /\\begin\{aligned\}/)
  /* 这一条是核心：`\\`（换行）必须还是两个反斜杠，塌成一个就不是合法 LaTeX 了 */
  assert.ok(span.tex.includes('\\\\'), 'latex 换行符不能被 Markdown 吃掉')
  assert.ok(span.tex.includes('\\,'), '细空格不能被 Markdown 吃掉')
})

test('中文段落里的单 $ 行内公式：全部抽出，且都能渲染', () => {
  const { spans } = maskMath(INLINE_CHINESE)

  assert.equal(spans.length, 9)
  for (const span of spans) {
    assert.equal(span.display, false)
    assert.ok(render(span.tex, span.display).includes('katex'))
  }
  /* 抽出的原文顺序应当与正文顺序一致 */
  assert.deepEqual(
    spans.map((s) => s.tex),
    ['u', 'dv', 'x', '\\sin x', 'u', 'u = x', 'du = dx', 'dv = \\sin x \\, dx', 'v = \\int \\sin x \\, dx = -\\cos x'],
  )
})

test('货币不误判：$5 和 $10 不是公式', () => {
  const { spans } = maskMath(
    String.raw`这个东西花了 $5 和 $10 元；另外 $5和$10元 也是钱，$\sin x$ 才是公式。`,
  )

  assert.equal(spans.length, 1)
  assert.equal(spans[0]?.tex, '\\sin x')
})

test('被拒绝的候选不能吞掉后面的公式（拒绝后要重新扫）', () => {
  const { spans } = maskMath(String.raw`花了 $5 和 $10 元，然后 $\sin x$ 才是公式，最后 $x^2$ 也是。`)

  assert.equal(spans.length, 2)
  assert.deepEqual(
    spans.map((s) => s.tex),
    ['\\sin x', 'x^2'],
  )
})

test('反斜杠分隔符：\\( 是行内，\\[ 是块级', () => {
  const { spans } = maskMath(String.raw`行内 \(a^2 + b^2 = c^2\)，块级：\[E = mc^2\]`)

  assert.equal(spans.length, 2)
  assert.equal(spans[0]?.display, false)
  assert.equal(spans[1]?.display, true)
})

test('转义的 \\$ 不开公式', () => {
  const { spans } = maskMath(String.raw`价格是 \$5，而 $x$ 是变量。`)

  assert.equal(spans.length, 1)
  assert.equal(spans[0]?.tex, 'x')
})

test('围栏代码块里的 $ 原样保留', () => {
  const source = '代码：\n\n```sh\necho "$HOME"\n```\n\n正文里 $x$ 要渲染。\n'
  const { masked, spans } = maskMath(source)

  assert.equal(spans.length, 1)
  assert.equal(spans[0]?.tex, 'x')
  assert.ok(masked.includes('echo "$HOME"'), '代码块内容不该被改写')
})

test('分隔符切分：$$ \\[ \\( $ 四种长度都正确', () => {
  const cases: Array<[string, string, boolean]> = [
    ['$$x$$', 'x', true],
    ['\\[x\\]', 'x', true],
    ['\\(x\\)', 'x', false],
    ['$x$', 'x', false],
  ]
  for (const [match, tex, display] of cases) {
    const result = stripDelimiters(match)
    assert.equal(result.tex, tex, `切分 ${match}`)
    assert.equal(result.display, display, `块级判定 ${match}`)
  }
})

test('单 $ 的"像不像公式"判据', () => {
  /* 该认的 */
  for (const tex of ['u', 'x', '\\sin x', 'x^2', '2x+1', 'a_1']) {
    assert.equal(looksLikeMath(tex), true, `${tex} 应当算公式`)
  }
  /* 不该认的：纯数字与中文 */
  for (const tex of ['5和', '10元', '5']) {
    assert.equal(looksLikeMath(tex), false, `${tex} 不该算公式`)
  }
})

test('所有抽出的公式都能被 KaTeX 渲染（这是用户真正看到的一步）', () => {
  const sources = [
    ALIGNED,
    INLINE_CHINESE,
    String.raw`行内 \(a^2 + b^2 = c^2\)，块级：\[E = mc^2\]`,
    String.raw`$\frac{1}{2}$、$\sum_{i=1}^{n} i$、$\sqrt{x}$`,
  ]

  let rendered = 0
  for (const source of sources) {
    for (const span of maskMath(source).spans) {
      const html = render(span.tex, span.display)
      assert.ok(html.includes('katex'), `渲染结果里应当有 katex 结构：${span.tex}`)
      rendered += 1
    }
  }
  assert.ok(rendered >= 12, `至少应渲染 12 个公式，实际 ${rendered}`)
})
