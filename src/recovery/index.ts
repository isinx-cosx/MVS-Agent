/**
 * 恢复层组装点。
 *
 * 与工具层同样的边界纪律：**这条路径不接给模型。** 只有人工调用入口和
 * 以后的执行循环能用。
 */

import { createHash } from 'node:crypto'
import path from 'node:path'
import { defaultHomeDir } from '../config/store.ts'
import { RecoveryGuard } from './guard.ts'
import { RecoveryManager } from './manager.ts'
import { RecoveryStore, copyFileWithClone } from './store.ts'
import { DEFAULT_EXCLUDES, changeCount } from './types.ts'
import type { RecoverableSnapshotOptions } from './types.ts'

/**
 * 每个工作区一个存储目录，**默认放在工作区之外**。
 *
 * 放在外面的理由：一旦将来有了写围栏，agent 就碰不到恢复数据。
 * ⚠️ 但它仍在同一块磁盘上，**所以这不是备份** —— 见文档里的边界说明。
 *
 * ## 为什么这里必须用 `defaultHomeDir()`，而不是 `os.homedir()`
 *
 * 原来这里直接拼 `os.homedir()` —— 于是 `MVS_HOME`（那个"覆盖整个状态根目录、
 * 测试和便携部署都用得上"的开关）**在这一层被绕过了**：
 *
 *   · 测试把它指到临时目录，恢复层照样往真实家目录里写
 *   · 于是在受限沙箱下**整片测试失败**（`EPERM: mkdir '~/.mvs-agent/recovery/…'`）
 *   · 而不受限时它会**动真实数据** —— 一个"隔离开关"只隔了一半，比没有更坏
 *
 * 状态目录只有一个来源：`defaultHomeDir()`。`MVS_RECOVERY_DIR` 仍然是更细的
 * 一层覆盖（它优先）。
 */
export function defaultRecoveryDir(workspaceRoot: string): string {
  const base = process.env.MVS_RECOVERY_DIR ?? path.join(defaultHomeDir(), 'recovery')
  const id = createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 16)
  return path.join(base, id)
}

export function createRecovery(
  options: { root: string; storeDir?: string } & Partial<RecoverableSnapshotOptions>,
): RecoveryManager {
  const root = path.resolve(options.root)
  return new RecoveryManager({
    root,
    storeDir: options.storeDir ?? defaultRecoveryDir(root),
    excludes: options.excludes,
    maxFileBytes: options.maxFileBytes,
    maxTransactions: options.maxTransactions,
  })
}

export { RecoveryGuard, RecoveryManager, RecoveryStore, copyFileWithClone }
export { changeCount, DEFAULT_EXCLUDES }
export { diffSnapshots, hashFile, walkTree } from './snapshot.ts'
export type { JournalEntry } from './store.ts'
export type {
  ChangeSet,
  RecoverableSnapshotOptions,
  RestoreReport,
  SkipReason,
  Snapshot,
  SnapshotCoverage,
  SnapshotEntry,
  Transaction,
} from './types.ts'
export type { GuardedExecution } from './guard.ts'
export type { PendingTransaction, RecoveryStatus } from './manager.ts'
