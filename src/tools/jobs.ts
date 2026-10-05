/**
 * 后台作业注册表。
 *
 * ## 它存在的理由，以及它**做不到**的事
 *
 * 前台命令的模型是「起一个进程、等它结束、拿到退出码」。后台命令没有这个终点：
 * `npm run dev` 会一直跑。所以需要有人记住「谁在跑、输出在哪、怎么停它」。
 *
 * ⚠️ **它和恢复层之间有一个真实的缺口，必须说清楚，不能假装没有。**
 *
 * 恢复层的快照边界是「动作前 → 动作后」。后台命令在 after 快照取完之后**还在写文件**
 * —— 那些写入既不属于本次事务的 diff，又会被算进**下一个**事务。后果不是「撤销
 * 不太准」，而是很具体的一种事故：下一个工具调用提交的事务会把后台进程刚生成的
 * 构建产物算成「自己新增的」，于是撤销那一步会**删掉后台的产物**。
 * copilot-cli#1675 就是这一类（回滚函数执行 `git clean -fd`，删掉了约 1GB
 * agent 只「读过」的未跟踪产物）。
 *
 * 所以这里的策略是**承认边界、而不是假装覆盖**：
 *   - 后台作业本身**不产生可撤销事务**（`RecoveryGuard` 显式跳过）；
 *   - 只要有作业在跑，同一个工作区的文件改动**一律不产生撤销条目** ——
 *     因为那个时间窗里的归属根本无法确定。
 *
 * 「宁可不提供撤销，也不提供一个点了没用的撤销」是这个项目一贯的取舍。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { killTree } from './kill-tree.ts'
import type { JobRecord, JobRegistryLike, StartJobOptions } from './types.ts'

/** 读取输出时最多回多少字节。后台日志会无限增长，不能整份读进来 */
const TAIL_BYTES = 16 * 1024

export class JobRegistry implements JobRegistryLike {
  #dir: string
  #jobs = new Map<string, JobRecord>()
  #children = new Map<string, ChildProcess>()

  constructor(dir: string) {
    this.#dir = dir
  }

  get dir(): string {
    return this.#dir
  }

  async init(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
  }

  /**
   * 起一个后台作业。**立刻返回**，不等它结束。
   *
   * `detached` 在 POSIX 上是必需的：没有独立进程组，`killTree` 的整组信号就没得打，
   * 而守护进程退出时这些作业会变成孤儿继续跑。Windows 上不需要（taskkill /T 靠
   * 父子关系），开了反而会多一个控制台窗口。
   */
  async start(options: StartJobOptions): Promise<JobRecord> {
    await this.init()
    const id = `job-${randomUUID().slice(0, 8)}`
    const stdoutPath = path.join(this.#dir, `${id}.out`)
    const stderrPath = path.join(this.#dir, `${id}.err`)

    const outFd = await open(stdoutPath, 'w')
    const errFd = await open(stderrPath, 'w')

    let child: ChildProcess
    try {
      child = spawn(options.file, [...options.argv], {
        cwd: options.cwd,
        // fd 重定向，不是管道 —— 本环境里 pipe 会同步抛 EPERM
        stdio: ['ignore', outFd.fd, errFd.fd],
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
    } finally {
      // 子进程已经持有这两个 fd 的副本，父进程这边要关掉，
      // 否则文件句柄会一直挂在注册表上（Windows 上还会挡住删除）
      await outFd.close()
      await errFd.close()
    }

    const record: JobRecord = {
      id,
      command: options.label,
      cwd: options.cwd,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      stdoutPath,
      stderrPath,
      exit: null,
      killed: false,
    }
    this.#jobs.set(id, record)
    this.#children.set(id, child)

    child.on('close', (code, signal) => {
      record.exit = { code, signal: signal ?? null }
      this.#children.delete(id)
    })
    // 起不来（找不到可执行文件等）也要落定，否则它会永远显示「运行中」
    child.on('error', () => {
      record.exit = { code: null, signal: null }
      this.#children.delete(id)
    })

    return record
  }

  list(): JobRecord[] {
    // 新的在前 —— 和事务列表同一个理由：人关心的是刚发生的
    return [...this.#jobs.values()].reverse()
  }

  get(id: string): JobRecord | undefined {
    return this.#jobs.get(id)
  }

  /** 有作业还在跑。恢复层用它决定「这个时间窗的归属是否可信」 */
  hasRunning(): boolean {
    for (const job of this.#jobs.values()) {
      if (job.exit === null) return true
    }
    return false
  }

  /**
   * 停掉一个作业。
   *
   * 返回 false 表示「这个 id 不存在」或「它已经结束了」—— 调用方要能把这两件事
   * 和「停成功了」分开，否则界面会显示「已停止」而进程还在跑。
   */
  kill(id: string): boolean {
    const job = this.#jobs.get(id)
    if (job === undefined) return false
    if (job.exit !== null) return false

    const child = this.#children.get(id)
    if (child !== undefined) {
      killTree(child)
    } else if (job.pid !== null) {
      // 进程对象没了但记录说还在跑（比如重启过注册表）：按 pid 再试一次整树
      killTree({ pid: job.pid, kill: () => false })
    }
    job.killed = true
    return true
  }

  /** 某个作业的尾部输出。日志会无限增长，所以只回最后一段 */
  async output(id: string): Promise<{ stdout: string; stderr: string } | undefined> {
    const job = this.#jobs.get(id)
    if (job === undefined) return undefined
    return { stdout: await tail(job.stdoutPath), stderr: await tail(job.stderrPath) }
  }

  /**
   * 收摊：把所有还在跑的作业杀掉。
   *
   * ⚠️ 必须做。后台作业是 **detached** 的，守护进程退出**不会**带走它们 ——
   * 不杀就等于每关一次界面就在用户机器上留一堆跑着的构建/服务进程，
   * 而且它们还在往工作区里写文件。
   */
  async dispose(): Promise<void> {
    for (const id of [...this.#children.keys()]) this.kill(id)
    // 给整树信号一点时间落地，再删日志目录
    await new Promise((resolve) => setTimeout(resolve, 200))
    await rm(this.#dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(
      () => undefined,
    )
    this.#jobs.clear()
    this.#children.clear()
  }
}

/** 读文件尾部。文件不存在（还没写出任何东西）时当空处理，不是错误 */
async function tail(file: string): Promise<string> {
  try {
    const info = await stat(file)
    if (info.size === 0) return ''
    const handle = await open(file, 'r')
    try {
      const start = Math.max(0, info.size - TAIL_BYTES)
      const length = info.size - start
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      const text = buffer.toString('utf8')
      return info.size > TAIL_BYTES ? `…（只显示最后 ${TAIL_BYTES} 字节）\n${text}` : text
    } finally {
      await handle.close()
    }
  } catch {
    return ''
  }
}

/** 供测试与清理使用：直接读整个文件（小文件场景） */
export async function readWhole(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}
