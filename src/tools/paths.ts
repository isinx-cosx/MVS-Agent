/**
 * 路径围栏。
 *
 * 所有文件工具的路径都必须经过这里。这不是「以后再加的安全策略」，
 * 而是工具本身如何解析路径的定义 —— 事后补要重写每个工具实现。
 *
 * 拦两类逃逸：
 *   1. 文本逃逸  —— `../..`、绝对路径、盘符切换
 *   2. 符号链接逃逸 —— 工作区内一个指向外部的软链
 *
 * 第 2 类容易被忽略：只做字符串前缀检查是不够的，必须对**已存在的最近祖先**
 * 做 realpath 再检查，因为路径的中间段可能还不存在（那时候谈不上软链）。
 */

import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

export type PathCheck = { ok: true; absolute: string } | { ok: false; message: string }

export function resolveInsideRoot(root: string, given: string): PathCheck {
  if (typeof given !== 'string' || given.trim() === '') {
    return { ok: false, message: '路径不能为空' }
  }
  if (given.includes('\0')) {
    return { ok: false, message: '路径包含非法字符' }
  }

  const realRoot = safeRealpath(path.resolve(root))
  const absolute = path.resolve(realRoot, given)

  if (!isInside(realRoot, absolute)) {
    return { ok: false, message: `路径越出工作区：${given}` }
  }

  const existing = nearestExisting(absolute)
  const realExisting = safeRealpath(existing)

  if (realExisting !== existing) {
    // 祖先是个软链，把剩余段接回去重新判断
    const remainder = path.relative(existing, absolute)
    const realTarget = remainder === '' ? realExisting : path.join(realExisting, remainder)
    if (!isInside(realRoot, realTarget)) {
      return { ok: false, message: `路径经符号链接后越出工作区：${given}` }
    }
  }

  return { ok: true, absolute }
}

/** p 是否等于 root 或位于 root 之下 */
export function isInside(root: string, p: string): boolean {
  const relative = path.relative(root, p)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** 从 p 向上找第一个真实存在的祖先（p 自身算第一个） */
function nearestExisting(p: string): string {
  let current = p
  while (!existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}
