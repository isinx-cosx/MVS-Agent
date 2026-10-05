/**
 * 量化抖动。
 *
 * ## 为什么不自己定度量
 *
 * "看起来在抖"没法直接算，但浏览器有一个**专门为此设计**的 API：
 * `layout-shift` 性能条目（也就是 CLS，意外布局位移）。它由渲染引擎给出、
 * 不依赖我的主观判断，而且每条位移都带 **sources** —— 哪个元素动了。
 * 于是它同时回答问题："抖了多少" 与 "是什么在抖"。
 *
 * 注意它的口径：**用户输入后 500ms 内的位移不计**（浏览器认为那是预期内的）。
 * 这正是我们要的 —— 用户自己滚动引起的变化不该算作抖动。
 *
 * ## 第二个指标：内容回缩
 *
 * 流式输出期间容器高度只应该**单调增长**。若 `scrollHeight` 变小，说明刚画上去
 * 的东西又缩回去了（行盒重算、公式从原文变成结构、光标换行……），这是最实在的
 * 一个异常信号，而且一眼能懂。
 *
 * ## 用法
 *
 * 传进要观察的滚动容器与"是否正在生成"。每轮开始清零，结束时把小结打去控制台
 * （也在界面上显示，仅当 URL 带 `?debug`）。
 */

import { useEffect, useRef, useState, type RefObject } from 'react'

export interface JitterReport {
  /** 累计 CLS 得分（浏览器口径） */
  score: number
  /** 位移次数 */
  shifts: number
  /** 位移来源元素（可读标签，按出现次数从多到少） */
  sources: string[]
  /** scrollHeight 变小的次数 —— 流式期间不该发生 */
  shrinks: number
  /** 单次回缩的最大像素 */
  maxShrinkPx: number
}

const EMPTY: JitterReport = { score: 0, shifts: 0, sources: [], shrinks: 0, maxShrinkPx: 0 }

/** layout-shift 条目里我们真正用到的字段（TS 的 DOM 类型里不一定有） */
interface LayoutShiftEntry extends PerformanceEntry {
  value?: number
  hadRecentInput?: boolean
  sources?: { node?: Node | null }[]
}

function describe(node: Node | null | undefined): string {
  if (node === null || node === undefined) return '(未知)'
  if (!(node instanceof Element)) return node.nodeName
  const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : ''
  const id = node.id === '' ? '' : `#${node.id}`
  return `${node.tagName.toLowerCase()}${id}${cls === '' ? '' : `.${cls}`}`
}

export function useJitter(target: RefObject<HTMLElement | null>, active: boolean): JitterReport {
  const [report, setReport] = useState<JitterReport>(EMPTY)
  const reportRef = useRef<JitterReport>(EMPTY)

  /* ── 指标一：CLS ─────────────────────────────────────────────────────── */
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return

    let observer: PerformanceObserver
    try {
      observer = new PerformanceObserver((list) => {
        let changed = false
        const next = { ...reportRef.current, sources: [...reportRef.current.sources] }

        for (const entry of list.getEntries() as LayoutShiftEntry[]) {
          /* 用户输入后 500ms 内的位移是预期内的，不算抖动 */
          if (entry.hadRecentInput === true) continue
          const value = entry.value ?? 0
          if (value <= 0) continue

          next.score += value
          next.shifts += 1
          for (const source of entry.sources ?? []) {
            const label = describe(source.node)
            if (!next.sources.includes(label)) next.sources.push(label)
          }
          changed = true
        }

        if (changed) {
          reportRef.current = next
          setReport(next)
        }
      })
      observer.observe({ type: 'layout-shift', buffered: true })
    } catch {
      /* 浏览器不支持就静默降级：这个度量是诊断用的，不能因为它坏了页面 */
      return
    }

    return () => observer.disconnect()
  }, [])

  /* ── 指标二：内容回缩 ──────────────────────────────────────────────── */
  useEffect(() => {
    const el = target.current
    if (el === null || !active) return

    let previous = el.scrollHeight
    const timer = window.setInterval(() => {
      const now = el.scrollHeight
      if (now < previous) {
        const drop = previous - now
        const next = {
          ...reportRef.current,
          shrinks: reportRef.current.shrinks + 1,
          maxShrinkPx: Math.max(reportRef.current.maxShrinkPx, drop),
        }
        reportRef.current = next
        setReport(next)
      }
      previous = now
    }, 200)

    return () => window.clearInterval(timer)
  }, [target, active])

  /* ── 每轮开始清零、结束打小结 ──────────────────────────────────────── */
  const wasActive = useRef(false)
  useEffect(() => {
    if (active && !wasActive.current) {
      reportRef.current = EMPTY
      setReport(EMPTY)
    }
    if (!active && wasActive.current) {
      const r = reportRef.current
      if (r.shifts > 0 || r.shrinks > 0) {
        console.info(
          `[抖动] CLS ${r.score.toFixed(4)} · 位移 ${r.shifts} 次 · 回缩 ${r.shrinks} 次` +
            `(最大 ${r.maxShrinkPx}px) · 来源 ${r.sources.slice(0, 6).join(', ')}`,
        )
      }
    }
    wasActive.current = active
  }, [active])

  return report
}
