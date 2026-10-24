/**
 * 公式的识别与抽取。**纯逻辑，不依赖 DOM，也不依赖 KaTeX。**
 *
 * 抽出来单独放有两个原因：
 *   1. 它要能被测试单独调用（`test/.tmp-math/check.mjs` 直接 import 这里）；
 *   2. `markdown.tsx` 里只该剩下"渲染"，判断规则不该和渲染混在一起。
 *
 * ## 为什么要先抽出来（而不是让 Markdown 解析器顺手处理）
 *
 * `marked` 会按 Markdown 规则改写公式正文：`\[` `\(` 是转义会被吃掉、`\\` 会
 * 塌成一个 `\`、`_` `*` 会被当成强调。所以公式必须在 Markdown **之前**被挖走，
 * 正文只留 `@@MATH0@@` 这样的占位符。
 *
 * ## 单 `$` 行内公式：靠规则判准，而不是一刀切
 *
 * 单 `$` 有明显的误判风险（"花了 $5 和 $10"），但**模型平时恰恰这么写公式**，
 * 直接禁掉等于把日常用法砍了。所以这里用一组规则去判：
 *
 *   · 开 `$` 后面**不能是空白**，闭 `$` 前面**不能是空白** —— 挡住 "$5 和 $10"
 *     （第二个 `$` 前面是空格）这类货币写法；
 *   · 闭 `$` 后面**不能紧跟数字** —— 进一步挡住 "$5和$10元"；
 *   · 内容**不能跨行**（`[^\n$]`）—— 行内公式本来就不该跨行；
 *   · 内容必须含 **ASCII 字母或数学符号** —— 挡住 "$5和$10元"（内容是 `5和`，
 *     既没有字母也没有数学符号）；
 *   · 转义过的 `\$` 不算开分隔符。
 *
 * 这套规则下：`$u$` `$dv$` `$\sin x$` `$x^2$` `$2x+1$` 都渲染，
 * 而 `$5 和 $10` `$5和$10元` 保持原样。
 */

/** 公式分隔符。`$$` 与 `\[` 必须排在单 `$` **前面**，否则会被单 `$` 抢先匹配 */
export const MATH_PATTERN =
  /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$(?!\s)([^\n$]+?)(?<!\s)\$(?!\d)/g

/** 分段用：围栏代码块里的 `$$` 不该被当成公式 */
export const FENCE_PATTERN = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g

export interface MathSpan {
  /** 原文，渲染失败时原样显示 */
  raw: string
  /** 去掉分隔符之后的 LaTeX */
  tex: string
  display: boolean
}

/** 单 `$` 的内容够不够"像公式" */
export function looksLikeMath(tex: string): boolean {
  /* ASCII 字母，或常见数学符号。纯数字加中文一律判为"不是公式" */
  return /[A-Za-z\\^_=+\-*/{}()<>|,]/.test(tex)
}

export function stripDelimiters(match: string): { tex: string; display: boolean } {
  /* 分隔符长度不一样：`$$` 两个字符，单 `$` 一个 —— 切错就会多吃掉正文一个字 */
  if (match.startsWith('$$')) return { tex: match.slice(2, -2), display: true }
  if (match.startsWith('\\[')) return { tex: match.slice(2, -2), display: true }
  if (match.startsWith('\\(')) return { tex: match.slice(2, -2), display: false }
  return { tex: match.slice(1, -1), display: false }
}

/** 是不是单 `$…$` 这种行内写法 */
export function isSingleDollar(match: string): boolean {
  return match.startsWith('$') && !match.startsWith('$$')
}

/**
 * 把公式换成占位符。占位符只用字母数字与 `@` —— Markdown 不碰、消毒不删。
 *
 * ## 为什么是手写 exec 循环，而不是 `replace` 回调
 *
 * 这里踩过一个坑，症状很隐蔽：**被拒绝的候选会把正文吃掉。**
 *
 * `replace` 的回调里"返回原串"看起来是"不替换"，但正则**已经越过那一段了**。
 * 于是 `花了 $5 和 $10 元；$\sin x$ 是公式` 里，`$5 和 $` 被拒之后，
 * 它后面那个真正该渲染的 `$\sin x$` 再也匹配不到 —— 整句一个公式都不渲染。
 *
 * 所以改成自己控制 `lastIndex`：**拒绝时回退到开分隔符的后一位重新扫**。
 */
export function maskMath(text: string): { masked: string; spans: MathSpan[] } {
  const spans: MathSpan[] = []

  const maskChunk = (chunk: string): string => {
    const pattern = new RegExp(MATH_PATTERN.source, 'g')
    const accepted: { start: number; end: number; span: MathSpan }[] = []

    let match = pattern.exec(chunk)
    while (match !== null) {
      const raw = match[0]
      const { tex, display } = stripDelimiters(raw)
      const trimmed = tex.trim()

      if (isSingleDollar(raw) && !looksLikeMath(match[1] ?? trimmed)) {
        /* 拒绝：**从开分隔符后一位重新扫**，别把后面的正文一起吃掉 */
        pattern.lastIndex = match.index + 1
        match = pattern.exec(chunk)
        continue
      }

      accepted.push({ start: match.index, end: match.index + raw.length, span: { raw, tex: trimmed, display } })
      match = pattern.exec(chunk)
    }

    if (accepted.length === 0) return chunk

    let out = ''
    let cursor = 0
    for (const item of accepted) {
      out += chunk.slice(cursor, item.start) + `@@MATH${spans.length}@@`
      spans.push(item.span)
      cursor = item.end
    }
    return out + chunk.slice(cursor)
  }

  /* 偶数段是正文，奇数段是围栏代码 —— 只处理正文 */
  const masked = text
    .split(FENCE_PATTERN)
    .map((part, index) => (index % 2 === 0 ? maskChunk(part) : part))
    .join('')

  return { masked, spans }
}
