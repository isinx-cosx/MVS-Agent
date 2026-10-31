/**
 * 输出审核的闸门与 taint 记录。
 *
 * ## 位置
 *
 * 唯一调用点是会话里「工具结果变成消息**之前**」那一步。放这里的理由：一旦内容
 * 进了 `events.jsonl`，它就已经在投影里、在界面上、在重放结果里了 —— 之后再打码
 * 只是掩耳盗铃。
 *
 * ## 打码也要 taint（这是最容易漏的一条）
 *
 * 模型看到 `apiKey: 'sk-…8f3a'` 之后，很可能觉得"这行没变"，把整段原样写回文件
 * —— 真密钥就被打码串**永久替换**了。所以：
 *
 *   · 被扣留过的路径 → 不许改（`tainted_path`）
 *   · 只是被打码的？也记 taint，因为模型看到的不是原文
 *
 * ## 出口
 *
 * 任何阻塞态都要配一个解除动作。这里是 `clear()`：UI 上的"解除限制"、
 * CLI 的 `npm run taint -- clear <path>`，都走它。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { SecretCategory, SecretHit } from './scan.ts'

export interface TaintRecord {
  /** 相对工作区根的路径 */
  path: string
  category: SecretCategory
  /** 那次命中的简要说明（不含具体值） */
  note: string
  at: string
}

export interface ReviewOutcome {
  /** 打码之后的正文（没有命中时原样返回） */
  content: string
  hits: SecretHit[]
  /** 被记录成 taint 的路径（相对） */
  tainted: string[]
}

/**
 * taint 表。**按工作区一份**，落在 `.mvs/taint.json`。
 *
 * 为什么落盘：'这个文件的内容被扣留过' 是一个跨会话的事实 —— 重启之后模型
 * 仍然没看过它，所以仍然不该让它盲改。
 */
export class TaintStore {
  #file: string
  #records = new Map<string, TaintRecord>()
  #loaded = false

  constructor(file: string) {
    this.#file = path.resolve(file)
  }

  static forWorkspace(root: string): TaintStore {
    return new TaintStore(path.join(root, '.mvs', 'taint.json'))
  }

  get file(): string {
    return this.#file
  }

  async #load(): Promise<void> {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const raw = await readFile(this.#file, 'utf8')
      const parsed = JSON.parse(raw) as { paths?: TaintRecord[] }
      for (const record of parsed.paths ?? []) {
        if (typeof record.path === 'string') this.#records.set(record.path, record)
      }
    } catch {
      /* 没有 taint 表是最常见的状态；坏文件也按空处理（它不承载安全结论，只承载"别盲改"） */
    }
  }

  async has(rel: string): Promise<TaintRecord | undefined> {
    await this.#load()
    return this.#records.get(normalize(rel))
  }

  async list(): Promise<TaintRecord[]> {
    await this.#load()
    return [...this.#records.values()].sort((a, b) => (a.path < b.path ? -1 : 1))
  }

  async add(rel: string, category: SecretCategory, note: string): Promise<void> {
    await this.#load()
    const key = normalize(rel)
    /* 同一路径只留第一条：后面的是"又遇到一次"，不改变结论 */
    if (this.#records.has(key)) return
    this.#records.set(key, { path: key, category, note, at: new Date().toISOString() })
    await this.#save()
  }

  async clear(rel: string): Promise<boolean> {
    await this.#load()
    const removed = this.#records.delete(normalize(rel))
    if (removed) await this.#save()
    return removed
  }

  async #save(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true })
    await writeFile(
      this.#file,
      `${JSON.stringify({ version: 1, paths: [...this.#records.values()] }, null, 2)}\n`,
      'utf8',
    )
  }
}

function normalize(rel: string): string {
  return rel.split('\\').join('/').replace(/^\.\/+/, '')
}

/**
 * 从一个工具调用里取出它**要改**的路径。
 *
 * 只有这些工具会被 taint 拦住：其它工具改不了文件，拦它们只是噪音。
 */
export function writtenPaths(tool: string, args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return []
  const bag = args as Record<string, unknown>

  const single = (key: string): string[] =>
    typeof bag[key] === 'string' && bag[key] !== '' ? [bag[key] as string] : []

  switch (tool) {
    case 'write_file':
    case 'create_file':
    case 'edit':
    case 'delete_file':
      return single('path')
    case 'delete_paths':
      return Array.isArray(bag['paths'])
        ? (bag['paths'] as unknown[]).filter((item): item is string => typeof item === 'string')
        : []
    case 'move_path':
      return [...single('from'), ...single('to')]
    default:
      return []
  }
}

/** 这个工具的输出要不要扫。读类、命令、网络、作业输出都要；写类不必（内容由我们自己写） */
export function shouldScanOutput(tool: string): boolean {
  return (
    tool === 'read_file' ||
    tool === 'grep' ||
    tool === 'glob' ||
    tool === 'run_command' ||
    tool === 'job_output' ||
    tool === 'web_fetch' ||
    tool === 'web_search' ||
    tool === 'use_skill'
  )
}
