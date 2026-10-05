/**
 * Markdown / 代码高亮 / 数学公式。三者都在这一层收口。
 *
 * ## 顺序是刻意的
 *
 * ```
 * 文本 → 抽出公式换成占位符 → marked(GFM) → DOMPurify 消毒
 *      → 放进 DOM → 高亮 → 占位符换回 KaTeX 渲染结果
 * ```
 *
 * 抽公式的规则与实现都在 `math.ts`（纯逻辑、可单独测试）；这里只管"渲染"。
 *
 * ## 为什么公式必须**先于** Markdown 被抽出来
 *
 * `marked` 会按 Markdown 规则改写公式正文：`\[` `\(` 是转义会被吃成 `[` `(`；
 * `\\`（aligned 换行）会塌成一个 `\`；`_` `*` 会被当成强调，下标就散了。
 * 所以在 Markdown 之前挖走，正文只留 `@@MATH0@@`。
 *
 * ## 为什么数学在消毒**之后**
 *
 * KaTeX 输出含 MathML 与大量内联 `style`，先渲染再消毒会被剥光；要保住它就得
 * 放开 `style`，那才是真把门打开。所以先消毒，之后注入的是**KaTeX 自己的输出**
 * （可信库产物），而不是模型给的 HTML —— 两者性质不同。KaTeX 默认 `trust: false`，
 * `\href{javascript:…}` 这类本来就不生效。
 *
 * ## 流式期间就渲染
 *
 * 每次 html 变了 React 都会重设 `innerHTML`，之前挂的高亮与公式会被一起抹掉，
 * 所以每次提交后都要重做。代价靠三件事压住：`useDeferredValue` 合并同一帧内的
 * 多个增量、effect 只依赖变化了的 html、超大代码块跳过高亮。
 *
 * ## 图片：点击后才加载
 *
 * 放行 `<img>` 意味着模型能塞远程地址，浏览器就会主动发请求（可当信标）。
 * 所以地址只留在 `data-src`，渲染成占位块，点一下才真正加载。
 */

import 'katex/dist/katex.css'
import 'highlight.js/styles/github.css'

import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import cmake from 'highlight.js/lib/languages/cmake'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import nginx from 'highlight.js/lib/languages/nginx'
import powershell from 'highlight.js/lib/languages/powershell'
import katex from 'katex'
import { marked } from 'marked'
import { memo, useLayoutEffect, useMemo, useRef, type MouseEvent } from 'react'
import { maskMath, type MathSpan } from './math.ts'
import type { ImagePolicy } from './settings.ts'
import { useThrottled } from './useThrottled.ts'

/*
 * `lib/common` 自带约 35 种常用语言；下面这几个是它没有、而本项目大概率会遇到的。
 * 再加语言就是一行 import 加一行 register。
 */
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('nginx', nginx)
hljs.registerLanguage('powershell', powershell)
hljs.registerLanguage('cmake', cmake)

marked.use({
  gfm: true,
  /* 单个换行也当换行 —— 模型输出里很常见，按标准 Markdown 会被吃掉 */
  breaks: true,
})

/** 超过这个长度就不上色 —— 每帧重排的代价不值得 */
const MAX_HIGHLIGHT_CHARS = 20_000

export function renderMarkdown(
  text: string,
  /** 图片策略（设置页里可改）。默认"点击加载"—— 见文件头那段隐私说明 */
  images: ImagePolicy = 'click',
): { html: string; spans: MathSpan[] } {
  /*
   * ★ **先去掉结尾空白。**
   *
   * 流式期间文本经常以换行结尾，而 `breaks: true` 会把那个换行渲染成一个 `<br>`
   * —— 于是末尾多出一行空白；下一个增量到齐后又少掉一行。每帧差一行高度，
   * 表现就是**整页小幅上下抖**（用户的原话）。
   *
   * 结尾空白在最终消息里本来也没有意义，所以这里统一裁掉，不需要区分流式与否。
   */
  const trimmed = text.replace(/\s+$/, '')
  const { masked, spans } = maskMath(trimmed)
  const raw = marked.parse(masked, { async: false })
  const clean = DOMPurify.sanitize(raw, {
    /* 只放行这几种协议；`javascript:` / `data:` 直接拦掉 */
    ALLOWED_URI_REGEXP: /^(?:https?|mailto|tel):/i,
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'script', 'object', 'embed'],
    FORBID_ATTR: ['style', 'srcset'],
  })

  const template = document.createElement('template')
  template.innerHTML = clean

  /* 外链新开标签页并断开 opener */
  for (const anchor of template.content.querySelectorAll('a')) {
    anchor.setAttribute('target', '_blank')
    anchor.setAttribute('rel', 'noreferrer noopener')
  }

  /*
   * 图片按设置处理，三选一：
   *
   *   click（默认）→ 换成占位块，地址留在 `data-src`，**此刻不发任何请求**
   *   always       → 保留 `<img>`；加 `referrerpolicy` 至少别把来源页带出去
   *   never        → 直接换成一句说明
   *
   * 地址是消毒过的（否则这个 `img` 早被 DOMPurify 删掉了），点击时用 DOM API
   * 赋给真实 `<img>` —— 不拼 HTML 字符串，不给注入留缝。
   */
  for (const img of [...template.content.querySelectorAll('img')]) {
    const src = img.getAttribute('src') ?? ''
    const alt = img.getAttribute('alt') ?? ''

    if (images === 'always') {
      img.setAttribute('referrerpolicy', 'no-referrer')
      img.setAttribute('loading', 'lazy')
      continue
    }

    if (images === 'never') {
      const hidden = document.createElement('span')
      hidden.className = 'md-img-hidden'
      hidden.textContent = `[图片已隐藏${alt === '' ? '' : `：${alt}`}]`
      img.replaceWith(hidden)
      continue
    }

    const box = document.createElement('button')
    box.type = 'button'
    box.className = 'md-img'
    box.dataset['src'] = src
    box.dataset['alt'] = alt
    box.textContent = `图片（点击加载）：${alt === '' ? src : alt}`
    img.replaceWith(box)
  }

  return { html: template.innerHTML, spans }
}

/** 把 DOM 里残留的占位符换成 KaTeX 的渲染结果 */
function injectMath(root: HTMLElement, spans: MathSpan[]): void {
  if (spans.length === 0) return

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.data.includes('@@MATH')) targets.push(node)
  }

  for (const node of targets) {
    const parts = node.data.split(/@@MATH(\d+)@@/g)
    const fragment = document.createDocumentFragment()

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i] ?? ''
      /* 偶数下标是普通文本；奇数下标是公式编号 */
      if (i % 2 === 0) {
        if (part !== '') fragment.appendChild(document.createTextNode(part))
        continue
      }
      const span = spans[Number(part)]
      const holder = document.createElement('span')
      if (span === undefined) continue
      try {
        /* 注入的是 **KaTeX 自己的输出**，不是模型给的 HTML */
        holder.innerHTML = katex.renderToString(span.tex, {
          displayMode: span.display,
          throwOnError: true,
          strict: 'ignore',
          trust: false,
        })
      } catch {
        /* 语法错就原样显示并标出来 —— 别让一个公式把整条消息弄没 */
        holder.className = 'math-error'
        holder.textContent = span.raw
      }
      fragment.appendChild(holder)
    }

    node.replaceWith(fragment)
  }
}

export const Markdown = memo(function Markdown({
  text,
  highlight = true,
  math = true,
  images = 'click',
}: {
  text: string
  /** 代码高亮（设置页可关：少一次重排，长回答更顺） */
  highlight?: boolean
  /** 公式渲染（设置页可关） */
  math?: boolean
  /** 图片策略（设置页可改） */
  images?: ImagePolicy
}) {
  /*
   * 流式期间每 ~40ms 来一块；这里压到约 8 次/秒再解析。
   *
   * 已落盘的消息文本不再变化，节流对它没有任何影响（值不变就不会重排）。
   */
  const throttled = useThrottled(text, 120)
  const { html, spans } = useMemo(() => renderMarkdown(throttled, images), [throttled, images])
  const container = useRef<HTMLDivElement>(null)

  /*
   * ⚠️ **必须是 `useLayoutEffect`，不能是 `useEffect`。**
   *
   * 这个 effect 会**改 DOM**（把代码块上色、把占位符换成 KaTeX 的结构）。而
   * `useEffect` 跑在浏览器**绘制之后** —— 于是每一帧都会画出两次：先是没有高亮、
   * 公式还是原文的样子，紧接着才是加工后的样子。流式期间每 40ms 一帧，正文一长
   * 就是持续闪动（用户的原话是"整页在抖"）。
   *
   * `useLayoutEffect` 跑在**提交之后、绘制之前**，加工完才画第一遍，闪动就没了。
   * 代价是它同步阻塞绘制 —— 对这个体量的内容可以接受，也正因如此才有
   * `MAX_HIGHLIGHT_CHARS` 那道上限。
   */
  useLayoutEffect(() => {
    const el = container.current
    if (el === null) return

    if (highlight) {
      for (const block of el.querySelectorAll('pre code')) {
        const source = block.textContent ?? ''
        if (source.length > MAX_HIGHLIGHT_CHARS) continue
        hljs.highlightElement(block as HTMLElement)
      }
    }

    if (math) injectMath(el, spans)
  }, [html, spans, highlight, math])

  const onClick = (event: MouseEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement | null
    const box = target?.closest('.md-img')
    if (!(box instanceof HTMLElement)) return
    const src = box.dataset['src']
    if (src === undefined || src === '') return

    const img = document.createElement('img')
    img.src = src
    img.alt = box.dataset['alt'] ?? ''
    box.replaceWith(img)
  }

  return (
    <div className="md" ref={container} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  )
})
