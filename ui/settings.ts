/**
 * 界面设置：**只影响这台浏览器**，写在 localStorage 里，不碰 daemon。
 *
 * ## 为什么是一个模块级 store，而不是 context
 *
 * 这些值要被"跟对话有关"和"跟设置页有关"的组件同时读到，而且**改动要立刻生效**。
 * 用 context 就得保证它在整棵树外面、且所有消费者都在 Provider 内；而这里只需要
 * 一个"谁都能读、改了就通知"的东西。`useSyncExternalStore` 正好是这个形状，
 * 顺带把"外部状态"这件事在类型上写清楚。
 *
 * ## 存进来的东西**必须校验**
 *
 * localStorage 里的内容是**上一个版本的自己**写的，也可能是人手改的。直接
 * `{...默认值, ...JSON.parse(raw)}` 会让一个 `fontSize: "big"` 一路传进样式里，
 * 变成静默的怪现象。所以每个字段都过一遍 `coerce`：不认识就用默认值。
 *
 * ⚠️ **这一层永远不写 daemon 的配置。** 模型、密钥、权限那些属于 daemon，
 * 有自己的配置文件与打码规则（尤其：**密钥的掩码绝不能被写回**）。这里只管
 * "这台浏览器怎么看"。
 */

import { useSyncExternalStore } from 'react'

export type ThemeChoice = 'auto' | 'light' | 'dark'
export type FollowMode = 'bottom' | 'always' | 'never'
export type ImagePolicy = 'click' | 'always' | 'never'

export interface Settings {
  theme: ThemeChoice
  /** 正文字号（px） */
  fontSize: number
  /** 什么时候自动跟到底部 */
  follow: FollowMode
  /** 代码高亮 */
  highlight: boolean
  /** 公式渲染 */
  math: boolean
  /** 左下角的抖动读数 */
  jitter: boolean
  /** 图片：点击加载（默认，隐私）/ 总是加载 / 不加载 */
  images: ImagePolicy
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  fontSize: 15,
  follow: 'bottom',
  highlight: true,
  math: true,
  jitter: false,
  images: 'click',
}

export const FONT_SIZE_RANGE = { min: 12, max: 20 } as const

const KEY = 'mvs.settings'

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

/** 把任意输入收敛成一个合法的 Settings。**不认识的取值一律回默认** */
export function coerceSettings(raw: unknown): Settings {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const size =
    typeof source['fontSize'] === 'number' && Number.isFinite(source['fontSize'])
      ? source['fontSize']
      : DEFAULT_SETTINGS.fontSize

  return {
    theme: oneOf(source['theme'], ['auto', 'light', 'dark'] as const, DEFAULT_SETTINGS.theme),
    fontSize: Math.min(FONT_SIZE_RANGE.max, Math.max(FONT_SIZE_RANGE.min, Math.round(size))),
    follow: oneOf(source['follow'], ['bottom', 'always', 'never'] as const, DEFAULT_SETTINGS.follow),
    highlight:
      typeof source['highlight'] === 'boolean' ? source['highlight'] : DEFAULT_SETTINGS.highlight,
    math: typeof source['math'] === 'boolean' ? source['math'] : DEFAULT_SETTINGS.math,
    jitter: typeof source['jitter'] === 'boolean' ? source['jitter'] : DEFAULT_SETTINGS.jitter,
    images: oneOf(source['images'], ['click', 'always', 'never'] as const, DEFAULT_SETTINGS.images),
  }
}

function read(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    return raw === null ? DEFAULT_SETTINGS : coerceSettings(JSON.parse(raw) as unknown)
  } catch {
    /* 隐私模式下 localStorage 会抛；内容坏了也一样 —— 两种都退回默认值 */
    return DEFAULT_SETTINGS
  }
}

let current: Settings = read()
const listeners = new Set<() => void>()

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

/**
 * 把设置里"影响全局的那几项"写到 DOM 上。
 *
 * 主题分两处：`data-theme` 供 CSS 选色，`color-scheme` 由 CSS 里的
 * `:root[data-theme=…]` 一并切换（否则滚动条还是另一套色）。
 */
function apply(): void {
  const resolved = current.theme === 'auto' ? (systemDark.matches ? 'dark' : 'light') : current.theme
  document.documentElement.dataset['theme'] = resolved
  document.documentElement.style.setProperty('--font-size', `${current.fontSize}px`)
}

/* 选了"跟随系统"时，系统换了主题要跟着走 —— 不监听就只在刷新时才对 */
systemDark.addEventListener('change', () => {
  if (current.theme === 'auto') apply()
})

export function getSettings(): Settings {
  return current
}

export function updateSettings(patch: Partial<Settings>): void {
  current = coerceSettings({ ...current, ...patch })
  try {
    localStorage.setItem(KEY, JSON.stringify(current))
  } catch {
    /* 记不住就算了：这次会话里仍然生效 */
  }
  apply()
  for (const listener of listeners) listener()
}

export function resetSettings(): void {
  updateSettings(DEFAULT_SETTINGS)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings)
}

/* 模块加载时先把 DOM 调好 —— 否则首帧会闪一下默认主题 */
apply()
