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
  verify?: boolean
}

export interface WalkResult {
  entries: Record<string, SnapshotEntry>
  coverage: SnapshotCoverage
}

export async function walkTree(options: WalkOptions): Promise<WalkResult> {
  const { root, excludes, maxFileBytes, previous, verify } = options

  const entries: Record<string, SnapshotEntry> = {}
  const coverage: SnapshotCoverage = {
    excludedDirs: [],
    skippedLarge: [],
    skippedLinks: [],
    hardLinks: [],
  }
  const excludedSeen = new Set<string>()

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

      let stats
      try {
        stats = await lstat(abs)
      } catch {
        continue
      }

      if (stats.size > maxFileBytes) {
        coverage.skippedLarge.push({ path: rel, size: stats.size })
        continue
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
          continue
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
  }

  await visit(root, '')

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
