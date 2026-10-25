/**
 * 恢复管理器。
 *
 * 事务模型：**每次变更型工具调用 = 一个事务**（动作前快照 → 动作 → 动作后快照 → 求差）。
 *
 * 两条从调研里直接搬来的规矩：
 *
 * - **没有变化就不产生可撤销条目。** Claude Code 的 issue #34368 是反面教材：
 *   rewind 会提供「撤销文件删除」选项，点了什么也不做。
 *   「看起来能救、实际救不了」比没有更危险，所以从源头不产生这种条目。
 * - **冲突时拒绝，而不是覆盖。** 目标文件在这次动作之后被改过 → 跳过并说明原因。
 *   Aider 的 `/undo` 在五种情况下主动拒绝，文档里那句评价是：「这些拒绝是特性——
 *   它们防止 undo 吃掉无关的工作。」
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { diffText, type FileDiff } from './diff.ts'
import { diffSnapshots, walkTree } from './snapshot.ts'
import { RecoveryStore, copyFileWithClone, type JournalEntry } from './store.ts'
import {
  DEFAULT_EXCLUDES,
  changeCount,
  type RecoverableSnapshotOptions,
  type RestoreReport,
  type SkipReason,
  type Snapshot,
  type Transaction,
} from './types.ts'

const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
const DEFAULT_MAX_TRANSACTIONS = 100

export interface PendingTransaction {
  id: string
  startedAt: string
  tool: string
  summary: string
  before: Snapshot
  /**
   * 这次事务只看这些路径（相对工作区）。`undefined` = 全树。
   *
   * ⚠️ **begin 与 commit 必须用同一份范围**，否则 diff 会比两棵大小不同的树：
   * commit 走全树时，before 里缺的那些文件会全被算成「新增」—— 撤销就会删掉
   * 一堆本来没动过的东西。
   */
  only?: string[]
}

export interface RecoveryStatus {
  root: string
  storeDir: string
  transactions: number
  storeBytes: number
  maxTransactions: number
  excludes: string[]
  /** 日志里损坏、被跳过的行数。>0 说明存储被动过，必须让用户看到 */
  malformedJournalLines: number
}

export class RecoveryManager {
  #store: RecoveryStore
  #root: string
  #excludes: Set<string>
  #maxFileBytes: number
  #maxTransactions: number
  #last: Snapshot | undefined

  constructor(options: RecoverableSnapshotOptions) {
    this.#root = path.resolve(options.root)
    this.#store = new RecoveryStore(path.resolve(options.storeDir))
    this.#excludes = new Set(options.excludes ?? DEFAULT_EXCLUDES)
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.#maxTransactions = options.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS
  }

  get root(): string {
    return this.#root
  }

  get storeDir(): string {
    return this.#store.dir
  }

  async init(): Promise<void> {
    await this.#store.init()
  }

  // -------------------------------------------------------------------------
  // 事务
  // -------------------------------------------------------------------------

  async begin(meta: {
    tool: string
    summary?: string
    /**
     * 只看这些相对路径。四个文件工具能给出**确切的目标路径**，
     * 所以它们不必扫全树；`run_command` 给不出（副作用无法从参数推出），
     * 传 `undefined` 走全树。
     */
    only?: string[]
  }): Promise<PendingTransaction> {
    const before = await this.#takeSnapshot(meta.only)
    return {
      id: `txn-${randomUUID()}`,
      startedAt: new Date().toISOString(),
      tool: meta.tool,
      summary: meta.summary ?? meta.tool,
      before,
      ...(meta.only === undefined ? {} : { only: meta.only }),
    }
  }

  /**
   * 结束事务。
   *
   * 返回 `null` 表示**没有任何文件变化** —— 此时不写日志，因为没有可撤销的东西。
   */
  async commit(pending: PendingTransaction): Promise<Transaction | null> {
    /* ⚠️ 必须与 begin 用同一个范围 —— 见 `PendingTransaction.only` 的注释 */
    const after = await this.#takeSnapshot(pending.only)
    const changes = diffSnapshots(pending.before, after)

    if (changeCount(changes) === 0) {
      await this.prune()
      return null
    }

    const transaction: Transaction = {
      id: pending.id,
      startedAt: pending.startedAt,
      finishedAt: new Date().toISOString(),
      tool: pending.tool,
      summary: pending.summary,
      before: pending.before.id,
      after: after.id,
      changes,
    }

    await this.#store.appendJournal({
      type: 'transaction',
      at: transaction.finishedAt,
      transaction,
    })
    await this.prune()
    return transaction
  }

  /**
   * 放弃事务（工具连参数都没通过校验，不可能有变化）。
   *
   * 不删快照：它仍是有用的增量基线，`prune()` 会回收没有任何事务引用的快照。
   */
  abort(_pending: PendingTransaction): void {
    // 故意为空：见上。
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  /**
   * 这条事务改了哪些文件（**只列清单，不算内容**）。
   *
   * 为什么清单不带逐行差异：一次事务可能改两百个文件，而界面首先要知道的是
   * "改了哪些" —— 内容按需再取（`fileDiff`）。这条和 `listTransactions` 里
   * "先给路径不给数组"是同一个取舍。
   */
  async changedFiles(
    transactionId: string,
  ): Promise<Array<{ path: string; change: FileDiff['change']; oldSize?: number; newSize?: number }> | null> {
    const target = (await this.list()).find((txn) => txn.id === transactionId)
    if (target === undefined) return null

    const before = await this.#store.loadSnapshot(target.before)
    const after = await this.#store.loadSnapshot(target.after)
    if (before === null || after === null) return null

    const sizeOf = (entries: Record<string, { size: number }>, rel: string): number | undefined =>
      entries[rel]?.size

    const out: Array<{ path: string; change: FileDiff['change']; oldSize?: number; newSize?: number }> = []
    for (const rel of [...target.changes.added].sort()) {
      out.push({ path: rel, change: 'added', newSize: sizeOf(after.entries, rel) })
    }
    for (const rel of [...target.changes.modified].sort()) {
      out.push({
        path: rel,
        change: 'modified',
        oldSize: sizeOf(before.entries, rel),
        newSize: sizeOf(after.entries, rel),
      })
    }
    for (const rel of [...target.changes.removed].sort()) {
      out.push({ path: rel, change: 'removed', oldSize: sizeOf(before.entries, rel) })
    }
    return out
  }

  /**
   * 单个文件的逐行差异。
   *
   * 三种"给不出逐行差异"必须分开说，不能都变成空结果：
   *   · 这条事务里没有这个文件 → `null`（调用方回 404）
   *   · 内容是二进制 → `binary: true`
   *   · 内容已经被回收 → `contentGone: true`
   */
  async fileDiff(
    transactionId: string,
    relPath: string,
    options: { maxBytes?: number; context?: number } = {},
  ): Promise<FileDiff | null> {
    const target = (await this.list()).find((txn) => txn.id === transactionId)
    if (target === undefined) return null

    const change: FileDiff['change'] | undefined = target.changes.added.includes(relPath)
      ? 'added'
      : target.changes.modified.includes(relPath)
        ? 'modified'
        : target.changes.removed.includes(relPath)
          ? 'removed'
          : undefined
    if (change === undefined) return null

    const before = await this.#store.loadSnapshot(target.before)
    const after = await this.#store.loadSnapshot(target.after)
    if (before === null || after === null) return null

    const beforeEntry = before.entries[relPath]
    const afterEntry = after.entries[relPath]
    const beforeBytes = await this.#readBlob(beforeEntry?.hash)
    const afterBytes = await this.#readBlob(afterEntry?.hash)

    const result = diffText(beforeBytes, afterBytes, options)
    const base: FileDiff = {
      path: relPath,
      change,
      ...(beforeEntry === undefined ? {} : { oldSize: beforeEntry.size }),
      ...(afterEntry === undefined ? {} : { newSize: afterEntry.size }),
    }

    if (result === null) {
      return { ...base, contentGone: true }
    }
    return {
      ...base,
      ...(result.binary ? { binary: true } : {}),
      ...(result.tooLarge ? { tooLarge: true } : {}),
      ...(result.binary || result.tooLarge
        ? {}
        : { hunks: result.hunks, added: result.added, removed: result.removed }),
    }
  }

  /** 读一个 blob。**读不到就返回 null**，由调用方区分"没内容"和"没差异" */
  async #readBlob(hash: string | undefined): Promise<Buffer | null> {
    if (hash === undefined) return null
    try {
      return await readFile(this.#store.blobPath(hash))
    } catch {
      return null
    }
  }

  async list(): Promise<Transaction[]> {
    const { entries } = await this.#store.readJournal()
    const out: Transaction[] = []
    for (const entry of entries) {
      if (entry.type === 'transaction') out.push(entry.transaction)
    }
    return out
  }

  async status(): Promise<RecoveryStatus> {
    const transactions = await this.list()
    const { malformed } = await this.#store.readJournal()
    return {
      root: this.#root,
      storeDir: this.#store.dir,
      transactions: transactions.length,
      storeBytes: await this.#store.sizeBytes(),
      maxTransactions: this.#maxTransactions,
      excludes: [...this.#excludes].sort(),
      malformedJournalLines: malformed,
    }
  }

  // -------------------------------------------------------------------------
  // 恢复
  // -------------------------------------------------------------------------

  async restore(
    transactionId: string,
    options: { force?: boolean } = {},
  ): Promise<RestoreReport> {
    const transactions = await this.list()
    const target = transactions.find((t) => t.id === transactionId)
    if (target === undefined) {
      return failure(transactionId, `找不到事务 ${transactionId}`)
    }

    const before = await this.#store.loadSnapshot(target.before)
    const after = await this.#store.loadSnapshot(target.after)
    if (before === null || after === null) {
      return failure(transactionId, '快照已被回收，无法恢复（存储上限或保留策略）')
    }

    // 先对**当前**状态拍快照 —— 恢复本身必须可恢复。
    // copilot-cli#1675 的教训：那个回滚函数执行 git clean -fd，
    // 删掉了约 1GB agent 只「读过」的未跟踪产物。
    const current = await this.#takeSnapshot()

    const conflicts = options.force === true
      ? new Set<string>()
      : findConflicts(target, before, after, current)

    const restored: string[] = []
    const deleted: string[] = []
    const skipped: Array<{ path: string; reason: SkipReason }> = []

    // 撤销「新增」= 删除
    for (const rel of target.changes.added) {
      if (conflicts.has(rel)) {
        skipped.push({ path: rel, reason: 'conflict' })
        continue
      }
      try {
        await rm(this.#abs(rel), { force: true })
        deleted.push(rel)
      } catch {
        skipped.push({ path: rel, reason: 'failed' })
      }
    }

    // 撤销「修改」与「删除」= 从 blob 还原
    for (const rel of [...target.changes.modified, ...target.changes.removed]) {
      if (conflicts.has(rel)) {
        skipped.push({ path: rel, reason: 'conflict' })
        continue
      }
      const entry = before.entries[rel]
      if (entry === undefined) {
        skipped.push({ path: rel, reason: 'missing-blob' })
        continue
      }
      const blob = this.#store.blobPath(entry.hash)
      if (!existsSync(blob)) {
        skipped.push({ path: rel, reason: 'missing-blob' })
        continue
      }
      try {
        const abs = this.#abs(rel)
        await mkdir(path.dirname(abs), { recursive: true })
        await copyFileWithClone(blob, abs)
        restored.push(rel)
      } catch {
        skipped.push({ path: rel, reason: 'failed' })
      }
    }

    // 恢复动作自身也是一个事务，因此可以再撤回去
    const afterRestore = await this.#takeSnapshot()
    const restoreTransaction: Transaction = {
      id: `txn-${randomUUID()}`,
      startedAt: current.createdAt,
      finishedAt: new Date().toISOString(),
      tool: 'recovery.restore',
      summary: `撤销：${target.summary}`,
      before: current.id,
      after: afterRestore.id,
      changes: diffSnapshots(current, afterRestore),
      restoredFrom: target.id,
    }

    const report: RestoreReport = {
      transactionId,
      restoreTransactionId: restoreTransaction.id,
      restored: restored.sort(),
      deleted: deleted.sort(),
      skipped,
      notCovered: describeGaps(before),
      ok: skipped.length === 0,
      message: buildMessage(restored, deleted, skipped),
    }

    if (changeCount(restoreTransaction.changes) > 0) {
      await this.#store.appendJournal({
        type: 'transaction',
        at: restoreTransaction.finishedAt,
        transaction: restoreTransaction,
      })
    }
    await this.#store.appendJournal({ type: 'restore', at: report.message, transactionId, report })
    await this.prune()

    return report
  }

  /** 撤销最近一次有变化的操作 */
  async restoreLast(options: { force?: boolean } = {}): Promise<RestoreReport | null> {
    const transactions = await this.list()
    const last = transactions.at(-1)
    if (last === undefined) return null
    return await this.restore(last.id, options)
  }

  // -------------------------------------------------------------------------
  // 保留与回收
  // -------------------------------------------------------------------------

  async prune(): Promise<{ removedSnapshots: string[]; removedBlobs: number }> {
    const transactions = await this.list()
    const keep = new Set<string>()
    for (const t of transactions.slice(-this.#maxTransactions)) {
      keep.add(t.before)
      keep.add(t.after)
    }
    if (this.#last !== undefined) keep.add(this.#last.id)

    const removedSnapshots: string[] = []
    for (const id of await this.#store.listSnapshotIds()) {
      if (keep.has(id)) continue
      await this.#store.deleteSnapshot(id)
      removedSnapshots.push(id)
    }

    // 只保留仍被引用快照指向的 blob
    const reachable = new Set<string>()
    for (const id of keep) {
      const snapshot = id === this.#last?.id ? this.#last : await this.#store.loadSnapshot(id)
      if (snapshot === null || snapshot === undefined) continue
      for (const entry of Object.values(snapshot.entries)) reachable.add(entry.hash)
    }

    let removedBlobs = 0
    const sweep = async (dir: string): Promise<void> => {
      let items
      try {
        items = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        const abs = path.join(dir, item.name)
        if (item.isDirectory()) {
          await sweep(abs)
          continue
        }
        const rel = path.relative(this.#store.blobsDir, abs).split(path.sep).join('/')
        const hash = rel.replace('/', '')
        if (hash.length < 8 || reachable.has(hash)) continue
        await rm(abs, { force: true })
        removedBlobs += 1
      }
    }
    await sweep(this.#store.blobsDir)

    if (removedSnapshots.length > 0 || removedBlobs > 0) {
      await this.#store.appendJournal({
        type: 'prune',
        at: new Date().toISOString(),
        removedSnapshots,
        removedBlobs,
      })
    }
    return { removedSnapshots, removedBlobs }
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  async #takeSnapshot(only?: string[]): Promise<Snapshot> {
    const seed = await this.#loadSeed()

    const { entries, coverage } = await walkTree({
      root: this.#root,
      excludes: this.#excludes,
      maxFileBytes: this.#maxFileBytes,
      previous: seed,
      ...(only === undefined ? {} : { only }),
    })

    const snapshot: Snapshot = {
      id: `snap-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      root: this.#root,
      entries,
      coverage,
    }

    // 只为「种子里没有的 hash」落盘 —— 内容寻址天然去重
    const known = new Set<string>()
    if (seed !== undefined) {
      for (const entry of Object.values(seed.entries)) known.add(entry.hash)
    }
    for (const entry of Object.values(entries)) {
      if (known.has(entry.hash)) continue
      const abs = this.#abs(entry.path)
      if (!existsSync(abs)) continue
      await this.#store.putBlob(abs, entry.hash)
    }

    await this.#store.saveSnapshot(snapshot)
    this.#last = snapshot
    return snapshot
  }

  async #loadSeed(): Promise<Snapshot | undefined> {
    if (this.#last !== undefined) return this.#last
    const transactions = await this.list()
    const last = transactions.at(-1)
    if (last === undefined) return undefined
    const snapshot = await this.#store.loadSnapshot(last.after)
    return snapshot ?? undefined
  }

  #abs(rel: string): string {
    return path.join(this.#root, ...rel.split('/'))
  }
}

// ---------------------------------------------------------------------------

function findConflicts(
  target: Transaction,
  _before: Snapshot,
  after: Snapshot,
  current: Snapshot,
): Set<string> {
  const conflicts = new Set<string>()
  const touched = [
    ...target.changes.added,
    ...target.changes.modified,
    ...target.changes.removed,
  ]
  for (const rel of touched) {
    const nowEntry = current.entries[rel]
    const thenEntry = after.entries[rel]
    // 与「动作之后」的状态一致 → 这段时间没人动过它，可以安全恢复
    if (nowEntry?.hash === thenEntry?.hash) continue
    // 双方都不存在 → 无需冲突
    if (nowEntry === undefined && thenEntry === undefined) continue
    conflicts.add(rel)
  }
  return conflicts
}

/** 把快照自身记录的盲区翻译成给用户看的话 —— 绝不假装完整 */
function describeGaps(snapshot: Snapshot): string[] {
  const gaps: string[] = []
  if (snapshot.coverage.excludedDirs.length > 0) {
    gaps.push(`被排除、不在保护范围内的目录：${snapshot.coverage.excludedDirs.join('、')}`)
  }
  if (snapshot.coverage.skippedLarge.length > 0) {
    const names = snapshot.coverage.skippedLarge.slice(0, 5).map((f) => f.path)
    gaps.push(
      `超过体积上限、未纳入保护的文件（${snapshot.coverage.skippedLarge.length} 个）：${names.join('、')}${
        snapshot.coverage.skippedLarge.length > 5 ? ' …' : ''
      }`,
    )
  }
  if (snapshot.coverage.skippedLinks.length > 0) {
    gaps.push(`符号链接未跟随（${snapshot.coverage.skippedLinks.length} 个）`)
  }
  if (snapshot.coverage.narrowedTo !== undefined && snapshot.coverage.narrowedTo.length > 0) {
    /*
     * ⚠️ 这条会出现在"本次恢复管不到"里，措辞要**准确**：
     * 收窄不是漏了，是这次事务从一开始就只声明这些路径。
     */
    gaps.push(
      `本次事务只覆盖这些路径（文件工具按目标路径收窄，其余路径不在本次范围内）：` +
        snapshot.coverage.narrowedTo.join('、'),
    )
  }
  if (snapshot.coverage.hardLinks.length > 0) {
    gaps.push(
      `硬链接文件（${snapshot.coverage.hardLinks.length} 个）：改动会同时影响外部别名，无法按路径隔离`,
    )
  }
  return gaps
}

function buildMessage(
  restored: string[],
  deleted: string[],
  skipped: Array<{ path: string; reason: SkipReason }>,
): string {
  const parts = [`已还原 ${restored.length} 个文件`, `已删除 ${deleted.length} 个新增文件`]
  if (skipped.length > 0) parts.push(`跳过 ${skipped.length} 个（冲突或失败）`)
  return parts.join('，')
}

function failure(transactionId: string, message: string): RestoreReport {
  return {
    transactionId,
    restoreTransactionId: null,
    restored: [],
    deleted: [],
    skipped: [],
    notCovered: [],
    ok: false,
    message,
  }
}

export type { JournalEntry }
