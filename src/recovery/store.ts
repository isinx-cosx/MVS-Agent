/**
 * 存储层：内容寻址的 blob 库 + 快照索引 + append-only 日志。
 *
 * 不依赖 git（stepback/turnback 用影子 git，可移植但要哈希并存储大量二进制），
 * 也不依赖 CoW（Windows 上基本不存在）。纯文件复制，用 COPYFILE_FICLONE
 * 在支持的文件系统上自动降级为近乎零成本的克隆。
 *
 * ⚠️ 存储目录**不是备份**：它在同一块磁盘上，会被同样的灾难影响。
 */

import { constants, existsSync } from 'node:fs'
import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import type { RestoreReport, Snapshot, Transaction } from './types.ts'

export type JournalEntry =
  | { type: 'transaction'; at: string; transaction: Transaction }
  | { type: 'restore'; at: string; transactionId: string; report: RestoreReport }
  | { type: 'prune'; at: string; removedSnapshots: string[]; removedBlobs: number }

export class RecoveryStore {
  #dir: string

  constructor(dir: string) {
    this.#dir = dir
  }

  get dir(): string {
    return this.#dir
  }

  get snapshotsDir(): string {
    return path.join(this.#dir, 'snapshots')
  }

  get blobsDir(): string {
    return path.join(this.#dir, 'blobs')
  }

  get journalPath(): string {
    return path.join(this.#dir, 'journal.jsonl')
  }

  async init(): Promise<void> {
    await mkdir(this.snapshotsDir, { recursive: true })
    await mkdir(this.blobsDir, { recursive: true })
  }

  blobPath(hash: string): string {
    return path.join(this.blobsDir, hash.slice(0, 2), hash.slice(2))
  }

  hasBlob(hash: string): boolean {
    return existsSync(this.blobPath(hash))
  }

  /** 把源文件的内容存进 blob 库（已存在则跳过，天然去重） */
  async putBlob(sourceAbs: string, hash: string): Promise<void> {
    const dest = this.blobPath(hash)
    if (existsSync(dest)) return
    await mkdir(path.dirname(dest), { recursive: true })
    await copyFileWithClone(sourceAbs, dest)
  }

  async saveSnapshot(snapshot: Snapshot): Promise<void> {
    await mkdir(this.snapshotsDir, { recursive: true })
    await writeFile(
      path.join(this.snapshotsDir, `${snapshot.id}.json`),
      JSON.stringify(snapshot),
      'utf8',
    )
  }

  async loadSnapshot(id: string): Promise<Snapshot | null> {
    try {
      const raw = await readFile(path.join(this.snapshotsDir, `${id}.json`), 'utf8')
      return JSON.parse(raw) as Snapshot
    } catch {
      return null
    }
  }

  async listSnapshotIds(): Promise<string[]> {
    try {
      const files = await readdir(this.snapshotsDir)
      return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    } catch {
      return []
    }
  }

  async deleteSnapshot(id: string): Promise<void> {
    await rm(path.join(this.snapshotsDir, `${id}.json`), { force: true })
  }

  async appendJournal(entry: JournalEntry): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    await appendFile(this.journalPath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  /**
   * 读日志。
   *
   * 损坏的行会被跳过，但**计数并返回** —— 静默忽略数据损坏，正是调研里
   * 反复出现的那个失败模式（"看起来配了、实际没生效"）。
   */
  async readJournal(): Promise<{ entries: JournalEntry[]; malformed: number }> {
    let raw: string
    try {
      raw = await readFile(this.journalPath, 'utf8')
    } catch {
      return { entries: [], malformed: 0 }
    }

    const entries: JournalEntry[] = []
    let malformed = 0
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        entries.push(JSON.parse(trimmed) as JournalEntry)
      } catch {
        malformed += 1
      }
    }
    return { entries, malformed }
  }

  async sizeBytes(): Promise<number> {
    let total = 0
    const walk = async (dir: string): Promise<void> => {
      let items
      try {
        items = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        const abs = path.join(dir, item.name)
        if (item.isDirectory()) {
          await walk(abs)
        } else if (item.isFile()) {
          try {
            total += (await stat(abs)).size
          } catch {
            // 忽略
          }
        }
      }
    }
    await walk(this.#dir)
    return total
  }
}

/**
 * 复制文件，优先用写时复制。
 *
 * COPYFILE_FICLONE = 「尝试克隆，失败则普通复制」。
 * 在 APFS / Btrfs / XFS / ZFS / ReFS 上近乎零成本；在 NTFS 上自动降级为普通复制。
 * 一个标志就拿到了跨平台的代价优化，不需要为 CoW 写另一条代码路径。
 */
export async function copyFileWithClone(source: string, dest: string): Promise<void> {
  try {
    await copyFile(source, dest, constants.COPYFILE_FICLONE)
  } catch {
    await copyFile(source, dest)
  }
}

export { copyFileWithClone as copyWithClone }
