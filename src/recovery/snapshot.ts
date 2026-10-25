/**
 * 快照：走树、哈希、求差。
 *
 * 关键性能设计：**增量快照**。
 * 上一份快照的 `size + mtimeMs` 命中时直接复用它的 hash，不读文件内容。
 * 因此一次快照的成本 ≈ 一次目录遍历（O(文件数) 次 stat），而不是重新读全树。
 *
 * ⚠️ 已知边界：size+mtime 是**启发式**。若某文件在同一 mtime 粒度内被改成等长内容，
 * 会被判为未变。NTFS 的 mtime 粒度是 100ns，实际风险极低，
 * 但这是记录在案的边界而非疏漏。严格模式见 `verify: true`。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  ChangeSet,
  Snapshot,
  SnapshotCoverage,
  SnapshotEntry,
} from './types.ts'

export interface WalkOptions {
  root: string
  excludes: Set<string>
  maxFileBytes: number
  /** 上一份快照；命中 size+mtime 时复用其 hash */
  previous?: Snapshot | undefined
  /** true 时忽略 mtime 快路径，强制重算所有 hash */
  /**
   * 只看这些**相对路径**（文件或目录）。`undefined` = 走全树。
   *
   * 为什么允许收窄：`write_file` / `create_file` / `delete_file` / `edit` 的目标路径
   * 是**结构化给的**，不需要解析任何命令。而 `run_command` 的副作用无法从参数推出，
   * 它仍然走全树（不传这个字段）。
   *
   * ⚠️ 收窄只影响**扫哪些路径**，不影响"扫到的文件怎么算差异" —— 同一个文件在两种
   * 模式下必须得到相同的 hash 与 size，这条有对照测试。
   */
  only?: string[]
  verify?: boolean
}

export interface WalkResult {
  entries: Record<string, SnapshotEntry>
  coverage: SnapshotCoverage
}

export async function walkTree(options: WalkOptions): Promise<WalkResult> {
  const { root, excludes, maxFileBytes, previous, verify, only } = options

  const entries: Record<string, SnapshotEntry> = {}
  const coverage: SnapshotCoverage = {
    excludedDirs: [],
    skippedLarge: [],
    skippedLinks: [],
    hardLinks: [],
  }
  const excludedSeen = new Set<string>()

  /**
   * 记一个文件（stat + 可能算 hash）。
   *
   * 抽成独立函数是因为它现在有两个入口：**全树遍历**（`visit` 遇到文件时）和
   * **收窄模式**（直接对这些路径调用）。两处必须是同一份逻辑 —— 否则同一个文件
   * 在两种模式下得到的 hash / size 可能不一致，而事务的 diff 正建立在这两个数上。
   */
  async function recordFile(abs: string, rel: string): Promise<void> {
    let stats
    try {
      stats = await lstat(abs)
    } catch {
      return
    }

    if (stats.size > maxFileBytes) {
      coverage.skippedLarge.push({ path: rel, size: stats.size })
      return
    }

    if (stats.nlink > 1) {
      // 硬链接是**文件对象的别名**，不是路径的别名。
      // 还原文一个别名会同时改变另一个，所以这里只记录、不承诺。
      coverage.hardLinks.push(rel)
    }

    const cached = previous?.entries[rel]
    const reuse =
      verify !== true &&
      cached !== undefined &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs

    let hash: string
    if (reuse) {
      hash = cached.hash
    } else {
      try {
        hash = await hashFile(abs)
      } catch {
        return
      }
    }

    entries[rel] = {
      path: rel,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hash,
      mode: stats.mode,
    }
  }

  async function visit(dirAbs: string, relPrefix: string): Promise<void> {
    let dirents
    try {
      dirents = await readdir(dirAbs, { withFileTypes: true })
    } catch {
      // 目录在遍历过程中消失，或权限不足 —— 跳过，不中断整次快照
      return
    }

    // 稳定顺序，让快照可复现、让 diff 输出可读
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    for (const dirent of dirents) {
      const rel = relPrefix === '' ? dirent.name : `${relPrefix}/${dirent.name}`
      const abs = path.join(dirAbs, dirent.name)

      if (dirent.isSymbolicLink()) {
        // 不跟随符号链接：跟随会逃出工作区，而且还原一个软链本身也没意义
        if (coverage.skippedLinks.length < 1000) coverage.skippedLinks.push(rel)
        continue
      }

      if (dirent.isDirectory()) {
        if (excludes.has(dirent.name)) {
          excludedSeen.add(dirent.name)
          continue
        }
        await visit(abs, rel)
        continue
      }

      if (!dirent.isFile()) continue

      await recordFile(abs, rel)
    }
  }

  if (only !== undefined) {
    /*
     * 把收窄范围记进 coverage —— 它不是实现细节：`describeGaps` 要据此告诉用户
     * 「这次事务只看了这些路径」。收窄而不说，等于把"撤销能覆盖全部变化"这个
     * 承诺偷偷改小。
     */
    coverage.narrowedTo = [...only]
    /*
     * 收窄模式：只碰这些路径。
     *
     * 每个条目要么是文件（记一条），要么是目录（递归它）。**不存在的路径直接跳过**
     * —— 删除的场景由"after 里没有它"体现，diff 会算成 removed。
     */
    for (const rel of only) {
      const normalized = rel.split(path.sep).join("/").replace(/^\.\/+/, "")
      if (normalized === "" || normalized.startsWith("..")) continue
      /*
       * 排除规则在收窄模式下**同样生效**：目标落在 `node_modules` / `.git` 里的
       * 文件不该因为"它被点名了"就进快照 —— 那些目录被排除的理由（体积、噪音、
       * 版本库自身的元数据）和扫描方式无关。
       */
      const segments = normalized.split("/")
      const excluded = segments.find((segment) => excludes.has(segment))
      if (excluded !== undefined) {
        excludedSeen.add(excluded)
        continue
      }
      const abs = path.join(root, normalized)
      let info
      try { info = await lstat(abs) } catch { continue }
      if (info.isDirectory()) {
        await visit(abs, normalized)
      } else if (info.isFile()) {
        await recordFile(abs, normalized)
      }
    }
  } else {
    await visit(root, '')
  }

  coverage.excludedDirs = [...excludedSeen].sort()
  coverage.skippedLarge.sort((a, b) => (a.path < b.path ? -1 : 1))
  coverage.hardLinks.sort()
  coverage.skippedLinks.sort()

  return { entries, coverage }
}

export async function hashFile(abs: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(abs)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/** 求差：把 a → b 的变化归类成 新增 / 修改 / 删除 */
export function diffSnapshots(a: Snapshot, b: Snapshot): ChangeSet {
  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []

  for (const [rel, entry] of Object.entries(b.entries)) {
    const before = a.entries[rel]
    if (before === undefined) added.push(rel)
    else if (before.hash !== entry.hash) modified.push(rel)
  }
  for (const rel of Object.keys(a.entries)) {
    if (b.entries[rel] === undefined) removed.push(rel)
  }

  added.sort()
  modified.sort()
  removed.sort()
  return { added, modified, removed }
}
