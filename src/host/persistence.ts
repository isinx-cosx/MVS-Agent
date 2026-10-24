/**
 * 会话持久化：追加事件日志 + 原子重写检查点。
 *
 * 两个文件是**两种不同的写入模式**，不能合成一个：
 *
 *   events.jsonl    只追加，线性增长
 *   checkpoint.json 每步原子重写，大小恒定
 *
 * 合并的代价是 O(n²)：每步都全量重写对话历史。100 步、100KB 历史还行；
 * 1000 步、1MB 历史就是 1GB 写入 —— 而且这个坑只在长任务上暴露，也就是在用户那里。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from '../config/atomic.ts'
import {
  CHECKPOINT_VERSION,
  EPHEMERAL_EVENTS,
  type Checkpoint,
  type CheckpointFile,
  type Envelope,
  type HostEvent,
} from '../protocol/types.ts'

export interface ReadResult<T> {
  items: T[]
  /** 损坏、被跳过的行数。**>0 必须让用户看到**，不要静默吞掉 */
  malformed: number
}

export class SessionStore {
  #dir: string
  #sessionId: string
  #seq = 0

  /**
   * @param sessionId 打进每一条信封。多会话之后这是必需的 ——
   *   客户端收到一个 `model_text_delta` 时必须知道是谁在说话。
   */
  constructor(dir: string, sessionId: string) {
    this.#dir = path.resolve(dir)
    this.#sessionId = sessionId
  }

  get sessionId(): string {
    return this.#sessionId
  }

  get dir(): string {
    return this.#dir
  }

  get eventsPath(): string {
    return path.join(this.#dir, 'events.jsonl')
  }

  get checkpointPath(): string {
    return path.join(this.#dir, 'checkpoint.json')
  }

  /** 已落盘的事件条数。流式增量不落盘，所以不增加它 */
  get currentSeq(): number {
    return this.#seq
  }

  async init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    const { items } = await this.readEvents()
    this.#seq = items.at(-1)?.seq ?? 0
  }

  /**
   * 追加一条事件。
   *
   * 流式增量（token）**不落盘** —— 一天下来能把日志撑到几个 GB，
   * 而它们在恢复时一点用都没有（最终消息已经完整存在 `assistant_message` 里）。
   */
  async append(event: HostEvent): Promise<Envelope | null> {
    if (EPHEMERAL_EVENTS.has(event.type)) return null

    this.#seq += 1
    const envelope: Envelope = {
      sessionId: this.#sessionId,
      seq: this.#seq,
      at: new Date().toISOString(),
      event,
    }
    await appendFile(this.eventsPath, `${JSON.stringify(envelope)}\n`, 'utf8')
    return envelope
  }

  async readEvents(): Promise<ReadResult<Envelope>> {
    let raw: string
    try {
      raw = await readFile(this.eventsPath, 'utf8')
    } catch {
      return { items: [], malformed: 0 }
    }

    const items: Envelope[] = []
    let malformed = 0
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        items.push(JSON.parse(trimmed) as Envelope)
      } catch {
        malformed += 1
      }
    }
    return { items, malformed }
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const file: CheckpointFile = { version: CHECKPOINT_VERSION, ...checkpoint }
    await writeFileAtomic(this.checkpointPath, `${JSON.stringify(file, null, 2)}\n`)
  }

  async readCheckpoint(): Promise<CheckpointFile | null> {
    return (await this.readCheckpointDetailed()).checkpoint
  }

  /**
   * 读检查点，并把「为什么没读到」带出来。
   *
   * 原来的写法是版本不符就 `return null` —— **完全静默**。后果用户看得见：
   * 会话的 turn / step / status 全部归零（它们是检查点给的），而重放虽然能重建
   * 消息，那几个显示值会从头开始。用户看到「昨天还在跑的那个会话今天变成未开始」，
   * 日志里却一条解释都没有。
   *
   * 「失败要可见」这条规矩在别处都守住了，这里没有。
   */
  async readCheckpointDetailed(): Promise<{
    checkpoint: CheckpointFile | null
    warning?: string
  }> {
    let raw: string
    try {
      raw = await readFile(this.checkpointPath, 'utf8')
    } catch {
      /* 没有检查点是最常见的情况（新会话），不是错误 */
      return { checkpoint: null }
    }
    try {
      const parsed = JSON.parse(raw) as CheckpointFile
      if (parsed.version !== CHECKPOINT_VERSION) {
        return {
          checkpoint: null,
          warning:
            `检查点版本是 ${String(parsed.version)}，当前支持 ${CHECKPOINT_VERSION}，已忽略。` +
            '消息会从事件日志重放重建，但轮次 / 步数 / 状态会从头开始。',
        }
      }
      return { checkpoint: parsed }
    } catch {
      /*
       * 半个 JSON：上一轮的原子写没来得及 rename 就被杀了。
       * 这**不代表状态损坏** —— 日志是完整的，可以从日志重建。
       * 但同样要说一句，否则用户只会看到数字归零。
       */
      return {
        checkpoint: null,
        warning: '检查点文件只写了一半（写入过程中被中断），已忽略，从事件日志重建。',
      }
    }
  }
}

/**
 * 原子写已挪到 `src/config/atomic.ts`。
 *
 * 挪走的理由：配置层和会话层都要用它，而**重复实现 fsync 顺序正是最容易
 * 各自漂移的那类代码**。这里保留再导出，免得既有调用点全要改。
 *
 * ⚠️ 已知边界：fsync 的是**文件内容**。严格来说 rename 之后还需要 fsync
 * 父目录，否则极端断电下目录项可能没落盘。Node 没有可移植的目录 fsync
 * （POSIX 可以 open 目录再 fsync，Windows 不行）。断电场景靠文件系统日志兜底。
 */
export { writeFileAtomic }
