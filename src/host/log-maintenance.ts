/**
 * 日志维护：**精简**与**启动清理**。
 *
 * ## 精简要撞一条不变量，所以必须留痕
 *
 * 事件日志是唯一事实来源；删内容 = 让"重放必须逐字一致"作废。所以这里的做法是：
 *
 *   · 只删 `<工具结果>` 的**正文**，保留 `ok` / `summary` / 计数
 *   · 改过的会话写一份 `trim-report.json`（哪些事件、删了多少字节、什么时候）
 *   · 只处理**会话没有在跑**的时候（调用方负责：这是离线的维护工具）
 *
 * 降级是**可见的**：重放之后那一格显示「输出已清理（原 58 KB）」，而不是消失。
 *
 * ## 为什么先做这个而不是索引
 *
 * 实测量级：1840 个会话、日志共 3.4 MB、最大一个 760 KB。真正会长的是
 * `tool_settled` 里存完整 content（一次 `grep -r` 60 KB）与后台作业的 stdout。
 * 在 3.4 MB 的量级上做索引是过度设计；先把"无界增长"掐掉。
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** 超过这个字节数的工具结果正文会被清理 */
const DEFAULT_MAX_BODY_BYTES = 8 * 1024

export interface TrimOptions {
  /** 正文上限。超过就换成占位符 */
  maxBodyBytes?: number
  /** 只处理这么多天以前的会话（0 = 全部） */
  olderThanDays?: number
}

export interface TrimReport {
  /** 改了哪些事件（seq） */
  trimmed: number[]
  /** 一共删掉多少字节 */
  bytesFreed: number
  /** 日志原始大小 */
  originalBytes: number
}

/**
 * 精简一个会话的日志。
 *
 * 返回 `null` 表示没有需要改的（**不改文件**：一次无操作的写入会让 mtime 变化，
 * 而 mtime 是别人判断"这个会话还活着吗"的依据）。
 */
export async function trimSessionLog(
  sessionDir: string,
  options: TrimOptions = {},
): Promise<TrimReport | null> {
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES
  const eventsPath = path.join(sessionDir, 'events.jsonl')

  let raw: string
  try {
    raw = await readFile(eventsPath, 'utf8')
  } catch {
    return null
  }

  const originalBytes = Buffer.byteLength(raw, 'utf8')
  const lines = raw.split('\n')
  const trimmed: number[] = []
  let bytesFreed = 0
  let changed = false

  const out = lines.map((line) => {
    if (line.trim() === '') return line
    let parsed: {
      seq?: number
      event?: { type?: string; content?: string; summary?: string }
    }
    try {
      parsed = JSON.parse(line)
    } catch {
      /* 坏行原样留着 —— 让"日志有损坏"这件事继续可见 */
      return line
    }
    const event = parsed.event
    if (event?.type !== 'tool_settled') return line
    const content = event.content
    if (typeof content !== 'string') return line
    const size = Buffer.byteLength(content, 'utf8')
    if (size <= maxBody) return line

    const placeholder = `〔输出已清理（原 ${(size / 1024).toFixed(1)} KB）—— 见 trim-report.json〕`
    event.content = placeholder
    /* summary 保留：它是"这一步干了什么"的一句话，比正文便宜得多也有用得多 */
    bytesFreed += size - Buffer.byteLength(placeholder, 'utf8')
    trimmed.push(parsed.seq ?? -1)
    changed = true
    return JSON.stringify(parsed)
  })

  if (!changed) return null

  await writeFile(eventsPath, out.join('\n').replace(/\n*$/, '\n'), 'utf8')
  const report: TrimReport = { trimmed, bytesFreed, originalBytes }
  await writeFile(path.join(sessionDir, 'trim-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

export interface MaintainOptions {
  /** 会话根目录（`MVS_HOME/sessions`） */
  sessionsDir: string
  trim?: TrimOptions
  /** 临时目录清理：删掉超过这么多小时的 `mvs-*` 目录 */
  tempDir?: string
  tempOlderThanHours?: number
}

export interface MaintainReport {
  sessionsScanned: number
  sessionsTrimmed: number
  bytesFreed: number
  tempDirsRemoved: string[]
  /** 精简了的会话（相对路径） */
  trimmed: string[]
}

async function listSessionDirs(sessionsDir: string): Promise<string[]> {
  const out: string[] = []
  let workspaces
  try {
    workspaces = await readdir(sessionsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const abs = path.join(sessionsDir, workspace.name)
    try {
      for (const session of await readdir(abs, { withFileTypes: true })) {
        if (session.isDirectory()) out.push(path.join(abs, session.name))
      }
    } catch {
      /* 单个坏目录跳过 */
    }
  }
  return out
}

/** 删掉 `%TEMP%` 下过期的 `mvs-*` 目录。daemon 崩了会留下它们 */
export async function cleanupTempDirs(
  tempDir: string,
  olderThanHours = 24,
): Promise<string[]> {
  const cutoff = Date.now() - olderThanHours * 3600_000
  const removed: string[] = []
  let items
  try {
    items = await readdir(tempDir, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const item of items) {
    if (!item.isDirectory() || !item.name.startsWith('mvs-')) continue
    const abs = path.join(tempDir, item.name)
    try {
      const info = await stat(abs)
      if (info.mtimeMs > cutoff) continue
      await rm(abs, { recursive: true, force: true })
      removed.push(item.name)
    } catch {
      /* 正在被用的目录删不掉 —— 下次再说 */
    }
  }
  return removed
}

export async function maintain(options: MaintainOptions): Promise<MaintainReport> {
  const sessions = await listSessionDirs(options.sessionsDir)
  const report: MaintainReport = {
    sessionsScanned: sessions.length,
    sessionsTrimmed: 0,
    bytesFreed: 0,
    tempDirsRemoved: [],
    trimmed: [],
  }

  if (options.trim !== undefined) {
    const cutoff =
      options.trim.olderThanDays === undefined || options.trim.olderThanDays <= 0
        ? 0
        : Date.now() - options.trim.olderThanDays * 86400_000

    for (const dir of sessions) {
      if (cutoff > 0) {
        const info = await stat(path.join(dir, 'events.jsonl')).catch(() => null)
        if (info === null || info.mtimeMs > cutoff) continue
      }
      const result = await trimSessionLog(dir, options.trim)
      if (result === null) continue
      report.sessionsTrimmed += 1
      report.bytesFreed += result.bytesFreed
      report.trimmed.push(path.relative(options.sessionsDir, dir))
    }
  }

  if (options.tempDir !== undefined) {
    report.tempDirsRemoved = await cleanupTempDirs(
      options.tempDir,
      options.tempOlderThanHours ?? 24,
    )
  }

  return report
}

/** 给 CLI 用：报告整理成人话 */
export function describeMaintain(report: MaintainReport): string {
  const lines = [
    `会话 ${report.sessionsScanned} 个，精简 ${report.sessionsTrimmed} 个，`
      + `释放 ${(report.bytesFreed / 1024).toFixed(1)} KB`,
  ]
  if (report.tempDirsRemoved.length > 0) {
    lines.push(`清理临时目录 ${report.tempDirsRemoved.length} 个：${report.tempDirsRemoved.join('、')}`)
  }
  return lines.join('\n')
}

/** 建一个目录（CLI 在 home 不存在时也要能跑） */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}
