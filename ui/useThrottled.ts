/**
 * 把高频变化压到固定节奏。
 *
 * ## 为什么需要它
 *
 * 模型每 ~40ms 推一块增量。若每块都重新解析 Markdown 并替换整棵 DOM，就是每秒
 * 25 次重排 —— 每次重排都可能让布局有一点点位移（行盒重算、代码块结构变化、
 * 公式从原文变成 KaTeX 结构）。频率越高，越容易被眼睛捕捉成"抖"。
 *
 * 压到固定节奏之后：文本仍然在往下填（约 8 次/秒，读起来是连续的），
 * 但重排次数少了三倍，抖动也随之变稀。
 *
 * ## 为什么不用 `useDeferredValue`
 *
 * 那个是"让给空闲时机"，节奏由 React 调度决定 —— 快的时候它照样每帧提交。
 * 这里要的是**上限**，所以自己管一个定时器：到点就把最新值刷出去，
 * 期间到达的变化自动合并（只保留最后一个）。
 */

import { useEffect, useRef, useState } from 'react'

export function useThrottled<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value)
  const latest = useRef(value)
  const timer = useRef<number | undefined>(undefined)
  const lastAt = useRef(0)

  useEffect(() => {
    latest.current = value
    /* 已经排好一次刷新了，就等它把最新值带出去 —— 这中间的变化自动合并 */
    if (timer.current !== undefined) return

    const wait = Math.max(0, intervalMs - (performance.now() - lastAt.current))
    timer.current = window.setTimeout(() => {
      timer.current = undefined
      lastAt.current = performance.now()
      setShown(latest.current)
    }, wait)
  }, [value, intervalMs])

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    },
    [],
  )

  return shown
}
