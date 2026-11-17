/**
 * 审核状态的**持久化**。
 *
 * ## 为什么必须落盘
 *
 * 分片读取计数和解码窗口本来是会话内存里的 `Map`。后果很直接：
 *
 *     读 4 次（不够阈值）→ 重启 daemon → 再读 4 次
 *
 * 计数从零开始，阈值永远到不了。**一个能靠重启绕过的检测，等于没有。**
 *
 * ## 存什么
 *
 * ```
 * .mvs/review-state.json
 * {
 *   "slices":  { "src/a.ts": { "calls": 6, "covered": 120, "total": 200, "updatedAt": "…" } },
 *   "windows": { "grep:src/a.ts": { "pieces": ["…"], "updatedAt": "…" } }
 * }
 * ```
 *
 * ## 过期策略
 *
 * 分片计数保留 24 小时，窗口保留 1 小时 —— 昨天读过的文件不该让今天正常读一次就降级。
 * 过期在**加载时**清理（不写回，写出交给下一次记录）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface SliceEntry {
  calls: number
  covered: number
  total: number
  updatedAt: string
}

export interface WindowEntry {
  pieces: string[]
  updatedAt: string
}

interface StateFile {
  slices: Record<string, SliceEntry>
  windows: Record<string, WindowEntry>
}

/** 分片计数保留 24 小时 */
const SLICE_TTL_MS = 24 * 60 * 60 * 1000
/** 分段窗口保留 1 小时（跨小时的片段拼接没有意义） */
const WINDOW_TTL_MS = 60 * 60 * 1000
/** 条目上限：防止长期会话把状态文件撑大（卫生，不是安全阈值） */
const MAX_SLICES = 500
const MAX_WINDOWS = 200

export class ReviewStateStore {
  #file: string
  #slices = new Map<string, SliceEntry>()
  #windows = new Map<string, WindowEntry>()
  #loaded = false

  constructor(file: string) {
    this.#file = file
  }

  static forWorkspace(root: string): ReviewStateStore {
    return new ReviewStateStore(path.join(root, '.mvs', 'review-state.json'))
  }

  /** 读盘并清理过期条目。文件不存在不算错误 —— 第一次跑就该是空的 */
  async load(now = Date.now()): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    let parsed: Partial<StateFile> = {}
    try {
      parsed = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<StateFile>
    } catch {
      return
    }
    for (const [key, entry] of Object.entries(parsed.slices ?? {})) {
      if (now - Date.parse(entry.updatedAt) > SLICE_TTL_MS) continue
      this.#slices.set(key, entry)
    }
    for (const [key, entry] of Object.entries(parsed.windows ?? {})) {
      if (now - Date.parse(entry.updatedAt) > WINDOW_TTL_MS) continue
      this.#windows.set(key, entry)
    }
  }

  slices(): Map<string, SliceEntry> {
    return this.#slices
  }

  windows(): Map<string, WindowEntry> {
    return this.#windows
  }

  /** 记一次读取，返回更新后的条目（调用方用它判断阈值） */
  async recordSlice(rel: string, returned: number, total: number, now = Date.now()): Promise<SliceEntry> {
    const previous = this.#slices.get(rel)
    const entry: SliceEntry = {
      calls: (previous?.calls ?? 0) + 1,
      covered: (previous?.covered ?? 0) + Math.min(returned, total),
      total,
      updatedAt: new Date(now).toISOString(),
    }
    this.#slices.set(rel, entry)
    await this.#persist()
    return entry
  }

  async recordWindow(key: string, pieces: string[], now = Date.now()): Promise<void> {
    this.#windows.set(key, { pieces, updatedAt: new Date(now).toISOString() })
    await this.#persist()
  }

  async clear(rel: string): Promise<void> {
    this.#slices.delete(rel)
    this.#windows.delete(rel)
    await this.#persist()
  }

  async #persist(): Promise<void> {
    /*
     * 写之前先裁掉过期的、再按"最近更新时间"封顶。
     *
     * 不裁的话，一个长期运行的会话会让这个文件无限长：每个读过的路径都留一条，
     * 最后读文件本身都要几十毫秒。上限不是安全阈值，只是**卫生**。
     */
    prune(this.#slices, SLICE_TTL_MS, MAX_SLICES)
    prune(this.#windows, WINDOW_TTL_MS, MAX_WINDOWS)

    const payload: StateFile = {
      slices: Object.fromEntries(this.#slices),
      windows: Object.fromEntries(this.#windows),
    }
    const target = this.#file
    const temp = `${target}.tmp`
    try {
      await mkdir(path.dirname(target), { recursive: true })
      /*
       * 先写临时文件再 rename：直接覆写的话，进程在写到一半时被杀会留下**半个 JSON**，
       * 下次启动 parse 失败 —— 状态静默清零，而"清零"正好是检测想避免的。
       */
      await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(temp, target)
    } catch {
      /* 写不进去不该让工具调用失败：状态是"加固"，不是"功能" */
    }
  }
}

/** 删过期条目；仍超过上限时按 updatedAt 保留最近的 */
function prune<T extends { updatedAt: string }>(map: Map<string, T>, ttlMs: number, max: number): void {
  const now = Date.now()
  for (const [key, entry] of map) {
    if (now - Date.parse(entry.updatedAt) > ttlMs) map.delete(key)
  }
  if (map.size <= max) return
  const ordered = [...map.entries()].sort(
    (left, right) => Date.parse(right[1].updatedAt) - Date.parse(left[1].updatedAt),
  )
  for (const [key] of ordered.slice(max)) map.delete(key)
}
