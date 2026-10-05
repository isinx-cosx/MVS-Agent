/**
 * 恢复层的契约。
 *
 * 四条设计约束，全部来自对现有产品的调研（见 docs/sandbox-platform-matrix.md）：
 *
 * 1. **快照边界必须在工具分发「之下」。** Claude Code、华为 CodeArts、Kiro 三家
 *    文档记录着同一个洞：工具级 checkpoint 漏掉 shell 通道（`rm`/`mv`/`sed -i`）。
 *    这里不做工具级记录，而是在**每次变更型工具调用前后**对整棵树做基线快照，
 *    因此天然覆盖 shell、代码生成、以及用户自己的编辑。
 *
 * 2. **不依赖 CoW。** Windows 上基本不存在（doover 明确不支持原生 Windows，
 *    EvoX 写「Windows: ❌ 回落到完整复制」）。纯文件复制 + COPYFILE_FICLONE
 *    尝试，三平台行为一致。
 *
 * 3. **必须记录「没覆盖到什么」。** 排除项、超大文件、符号链接、硬链接都要
 *    显式记下来。doover 的做法是：无法处理就记录覆盖为尽力而为，绝不假装完整。
 *
 * 4. **恢复本身必须可恢复。** copilot-cli#1675 的教训：回滚函数执行
 *    `git clean -fd` 删掉了约 1GB agent 只「读过」的未跟踪产物——
 *    **恢复操作本身是一条 shell 命令，而没有任何东西在给 shell 做快照。**
 *    所以这里恢复本身也是一个事务，且冲突时优先拒绝。
 */

export interface SnapshotEntry {
  /** 相对 root 的路径，统一用 POSIX 分隔符 */
  path: string
  size: number
  mtimeMs: number
  /** sha256 十六进制 */
  hash: string
  /** 保留可执行位（POSIX 有意义，Windows 上无意义） */
  mode: number
}

/**
 * 快照**没覆盖到**的东西。
 *
 * 这个结构是刻意存在的：一份不记录自身盲区的快照，会让人误以为「都能撤」。
 */
export interface SnapshotCoverage {
  /** 被排除规则跳过的目录名（去重后） */
  excludedDirs: string[]
  /** 超过体积上限、未纳入保护的文件 */
  skippedLarge: Array<{ path: string; size: number }>
  /** 符号链接（不跟随——跟随会逃出工作区） */
  skippedLinks: string[]
  /** 硬链接（多链接文件；改动会同时影响外部别名，无法按路径隔离） */
  hardLinks: string[]
}

export interface Snapshot {
  id: string
  createdAt: string
  root: string
  entries: Record<string, SnapshotEntry>
  coverage: SnapshotCoverage
}

export interface ChangeSet {
  /** 新增：撤销时删除 */
  added: string[]
  /** 修改：撤销时从 blob 还原 */
  modified: string[]
  /** 删除：撤销时从 blob 还原 */
  removed: string[]
}

export function changeCount(changes: ChangeSet): number {
  return changes.added.length + changes.modified.length + changes.removed.length
}

export interface Transaction {
  id: string
  startedAt: string
  finishedAt: string
  /** 触发这次变更的工具名 */
  tool: string
  /** 一行人类可读的描述 */
  summary: string
  before: string
  after: string
  changes: ChangeSet
  /** 若这次事务本身是一次恢复操作，指向被恢复的事务 */
  restoredFrom?: string
}

export type SkipReason =
  /** 目标文件在这次动作之后被改过 —— 拒绝，而不是覆盖掉别人的工作 */
  | 'conflict'
  /** blob 缺失（存储被破坏或已回收） */
  | 'missing-blob'
  /** 文件系统操作失败（权限、占用等） */
  | 'failed'

export interface RestoreReport {
  /** 被恢复的事务 */
  transactionId: string
  /** 恢复动作自身也是一个事务，可用它再撤回去 */
  restoreTransactionId: string | null
  restored: string[]
  deleted: string[]
  skipped: Array<{ path: string; reason: SkipReason }>
  /** 这次恢复**管不到**的类别（来自快照的 coverage 盲区），必须显示给用户 */
  notCovered: string[]
  ok: boolean
  message: string
}

export interface RecoverableSnapshotOptions {
  /** 工作区根目录（绝对路径） */
  root: string
  /**
   * 快照存储目录。**默认放在工作区之外**（如 ~/.mvs-agent/recovery），
   * 这样一旦将来有了写围栏，agent 也碰不到它。
   * 注意：它仍在同一块磁盘上，所以不是备份。
   */
  storeDir: string
  /** 按目录名排除（任意层级匹配）。默认见 DEFAULT_EXCLUDES */
  excludes?: string[]
  /** 单文件体积上限，超过则不纳入保护（默认 20 MiB） */
  maxFileBytes?: number
  /** 保留多少个事务的快照（默认 100） */
  maxTransactions?: number
}

/**
 * 默认排除项。
 *
 * ⚠️ **刻意不尊重 .gitignore。**
 * stepback / safesandbox 尊重 .gitignore，因此漏掉 `.env`、本地数据库、测试数据——
 * 而 Agent 恰好最容易毁掉这些。这里反过来：只排除确定的构建产物和依赖目录。
 */
export const DEFAULT_EXCLUDES = [
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.turbo',
  'coverage',
  '.cache',
]
