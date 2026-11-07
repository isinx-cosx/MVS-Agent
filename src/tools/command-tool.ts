/**
 * 命令执行工具。
 *
 * 两个来自实测的关键决定：
 *
 * 1. **绝不用管道 stdio。**
 *    本环境下 `spawn(..., { stdio: 'pipe' })` 会**同步抛出 EPERM**（不是 error 事件）。
 *    所以输出直接重定向到临时文件（fd stdio），子进程退出后再读。
 *    附带好处：绕开了 shell 引号转义这一整类问题。
 *
 * 2. **沙箱拒绝与命令失败必须分开。**
 *    EPERM 意味着「这条路走不通」，重试同一个命令不会有任何不同结果。
 *    如果和「命令退出码非 0」混为一谈，模型会陷入无意义的重试循环。
 *    所以它们是两个不同的 error kind：sandbox / failed。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, createReadStream, openSync } from 'node:fs'
import { mkdtemp, rm, stat, statfs, truncate } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveInsideRoot } from './paths.ts'
import { killTreeOf as killTree } from './kill-tree.ts'
import { runInSandbox } from './sandbox-exec.ts'
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TIMEOUT_MS,
  failResult,
  okResult,
  type Tool,
  type ToolResult,
} from './types.ts'

/**
 * 单个流最多留这么多字节在磁盘上。
 *
 * 为什么需要它：`DEFAULT_MAX_OUTPUT_CHARS` 只限制**模型看到多少**，不限制我们
 * 写多少、读多少。一个 `yes` 跑 30 秒能写出 GB 级临时文件，然后被整个读进内存
 * —— 守护进程 OOM，会话全丢。这里封的是**磁盘与内存**，不是字符数。
 *
 * 超出的部分用 `truncate` 截掉：子进程继续往更大的偏移写，但那一段是稀疏空洞，
 * 不占实际空间；前 8 MB 保持完整，读回来的就是它。
 */
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024

/** 捕获文件的巡检间隔：每 250 ms 看一次大小与磁盘余量 */
const CAPTURE_WATCH_MS = 250

/**
 * 磁盘剩余空间的底线。低于它**不启动命令**。
 *
 * 理由：命令失败与"磁盘快满了"是两件事 —— 前者重试可能有用，后者重试一定没用，
 * 而且真跑起来会让恢复层连快照都写不进去（那正是最需要撤销的时候）。
 */
const DEFAULT_DISK_FLOOR_BYTES = 2 * 1024 * 1024 * 1024
/** 一个目录所在卷的剩余字节。拿不到就返回 null —— 不知道不等于零 */
async function freeBytesOf(dir: string): Promise<number | null> {
  if (typeof statfs !== 'function') return null
  try {
    const info = await statfs(dir)
    return info.bavail * info.bsize
  } catch {
    return null
  }
}

function diskFloorBytes(): number {
  const override = Number(process.env.MVS_DISK_FLOOR_MB ?? '')
  if (Number.isFinite(override) && override > 0) return override * 1024 * 1024
  return DEFAULT_DISK_FLOOR_BYTES
}

/** 把捕获文件截到上限。返回是否真的截过 */
async function capCaptureFile(file: string, cap: number): Promise<boolean> {
  try {
    const info = await stat(file)
    if (info.size <= cap) return false
    /*
     * 只截到 cap，**保留前 cap 字节**。
     *
     * 子进程的写偏移不会因为截断而回退，所以它接下来写在更大的偏移上 ——
     * 中间那段变成稀疏空洞（NTFS 不为其分配簇）。结果是：
     * 实际占盘 ≈ cap，而"前 cap 字节"永远完整可读。
     */
    await truncate(file, cap)
    return true
  } catch {
    /* 文件可能还没创建 / 已被删 —— 巡检本来就是尽力而为 */
    return false
  }
}
interface RunCommandArgs {
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
  /**
   * 后台运行：立刻返回，不等它结束。
   *
   * ⚠️ 把它当**另一个工具**看，而不是 `run_command` 的一个小选项 —— 它和前台执行
   * 的语义差别很大：
   *
   * - 没有退出码可等（`npm run dev` 永远不退出）；
   * - **不受恢复层保护**：它的文件改动发生在快照窗口之后，撤销覆盖不到它。
   *   见 `jobs.ts` 顶部那段说明。
   *
   * 也正因为后面这条，权限层把「后台」视为**必须确认**，即使命令本身可证明只读。
   */
  background?: boolean
}

export const runCommandTool: Tool<RunCommandArgs> = {
  name: 'run_command',
  description:
    '执行命令并返回退出码与输出。只给 command 时按平台 shell 解析（支持管道与重定向）；' +
    '同时给 args 时直接启动可执行文件、不经 shell（更可预测）。cwd 必须位于工作区内。' +
    'background=true 时立刻返回一个作业 id（用于 dev server / watch 这类不会退出的命令），' +
    '之后可以用 list_jobs / job_output / kill_job 管理它。',
  risk: 'execute',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        minLength: 1,
        description: '可执行文件名或命令行。给了 args 时视为可执行文件路径。',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: '参数数组。给出时不经 shell 直接启动，可避免引号解析问题。',
      },
      cwd: { type: 'string', description: '工作目录，相对工作区根目录，默认工作区根目录' },
      timeoutMs: {
        type: 'integer',
        minimum: 100,
        maximum: 600_000,
        description: `超时毫秒数，默认 ${DEFAULT_TIMEOUT_MS}。background=true 时忽略。`,
      },
      background: {
        type: 'boolean',
        description: '在后台运行并立刻返回作业 id。用于不会自己退出的命令。',
      },
    },
    required: ['command'],
    additionalProperties: false,
  },

  async run(args, ctx): Promise<ToolResult> {
    // --- 工作目录：同样受路径围栏约束 ---
    const cwdCheck =
      args.cwd === undefined
        ? ({ ok: true, absolute: ctx.root } as const)
        : resolveInsideRoot(ctx.root, args.cwd)
    if (!cwdCheck.ok) return failResult('outside_root', cwdCheck.message)

    const cwd = cwdCheck.absolute
    const cwdStats = await statOrNull(cwd)
    if (cwdStats === null) {
      return failResult('not_found', `工作目录不存在：${args.cwd ?? cwd}`)
    }
    if (!cwdStats.isDirectory()) {
      return failResult('not_a_directory', `工作目录不是目录：${args.cwd ?? cwd}`)
    }

    const timeoutMs = args.timeoutMs ?? ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxOutput = ctx.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS

    /*
     * ★ 沙箱分支：`MVS_SANDBOX=low-il` 时命令走 `tools/sandbox-run.mjs`。
     *
     * 打开的收益是四道**硬上限**（进程数 / 单进程内存 / 整树内存 / CPU 时间）
     * 加写字节度量，代价是每条命令多一次 node 启动（实测 ~120 ms）。
     *
     * 没打开时完全不改变原有行为 —— 这是刻意的：默认值不能悄悄变。
     *
     * ★ 后台作业**不走**沙箱：作业要活过这条命令，而 worker 的生命周期是这一条命令；
     * 把作业塞进 job 会随 worker 退出被 KILL_ON_JOB_CLOSE 一起收掉。
     */
    if (process.env.MVS_SANDBOX === 'low-il' && args.background !== true) {
      const sandboxed = await runInSandbox({
        command: args.command,
        args: args.args ?? (process.platform === 'win32' ? ['/c', args.command] : ['-c', args.command]),
        cwd,
        timeoutMs,
        ...(process.env.MVS_SANDBOX_MAX_PROCESSES === undefined
          ? {}
          : { maxProcesses: Number(process.env.MVS_SANDBOX_MAX_PROCESSES) }),
        ...(process.env.MVS_SANDBOX_MAX_MEMORY_MB === undefined
          ? {}
          : { maxMemoryMb: Number(process.env.MVS_SANDBOX_MAX_MEMORY_MB) }),
      })

      if (sandboxed.ok !== true) {
        /*
         * 沙箱起不来 ≠ 命令失败。这一种必须**报错**而不是"当作命令失败"，
         * 否则用户会以为是自己的命令有问题，而实际是这台机器用不了沙箱。
         */
        if (sandboxed.error !== undefined && sandboxed.exitCode === undefined) {
          return failResult('failed', `沙箱没能启动：${sandboxed.error}`)
        }
        const note = [
          `命令退出码 ${sandboxed.exitCode ?? '(未知)'}`,
          sandboxed.timedOut === true ? '（超时，整棵进程树已被终止）' : '',
          sandboxed.writeBytes === undefined ? '' : `写盘 ${sandboxed.writeBytes} 字节`,
        ].join(' ')
        return failResult('failed', note, {
          content: composeContent(
            sandboxed.exitCode ?? null,
            null,
            sandboxed.stdout ?? '',
            sandboxed.stderr ?? '',
            `沙箱：${note}`,
          ),
          data: { sandbox: sandboxed, cwd },
        })
      }

      const content = composeContent(
        sandboxed.exitCode ?? null,
        null,
        sandboxed.stdout ?? '',
        sandboxed.stderr ?? '',
        sandboxed.timedOut === true ? '命令超时，整棵进程树已被终止' : undefined,
      )
      /* 非零退出码必须是失败：沙箱自己工作正常，不等于命令成功 */
      if ((sandboxed.exitCode ?? 0) !== 0) {
        return failResult('failed', `命令退出码 ${sandboxed.exitCode}`, {
          content,
          data: { exitCode: sandboxed.exitCode, writeBytes: sandboxed.writeBytes, cwd, sandbox: 'low-il' },
        })
      }
      return okResult(content, {
        exitCode: sandboxed.exitCode,
        timedOut: sandboxed.timedOut ?? false,
        writeBytes: sandboxed.writeBytes,
        cwd,
        sandbox: 'low-il',
      })
    }

    // --- 确定启动方式 ---
    const direct = args.args !== undefined
    const shell = direct ? null : shellInvocation(args.command)
    const file = direct ? args.command : (shell?.[0] ?? args.command)
    const argv = direct ? (args.args ?? []) : (shell?.[1] ?? [])

    /*
     * 磁盘余量哨兵：**低于底线不启动**。
     *
     * 这一条挡不住"命令自己把盘写满"（那是运行中才发生的事，见下面的巡检），
     * 但它挡得住更常见的一种：磁盘本来就快满了，再跑一条会写文件的命令，
     * 于是恢复层连快照都写不进去 —— 恰好发生在最需要撤销的时候。
     */
    const freeBefore = await freeBytesOf(cwd)
    const floor = diskFloorBytes()
    if (freeBefore !== null && freeBefore < floor) {
      const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(0)} MB`
      return failResult(
        'insufficient_disk',
        `磁盘剩余 ${mb(freeBefore)}，低于底线 ${mb(floor)} —— 命令没有启动。先腾出空间再试。`,
      )
    }

    // --- 后台：交给作业注册表，立刻返回 ---
    //
    // 刻意**不共用**下面的等待/超时逻辑：后台命令没有退出码可等，把两套语义塞进
    // 一个函数只会让「等」和「不等」的分支互相污染。注册表那边负责 fd 重定向、
    // 独立进程组、以及退出后的状态落定。
    if (args.background === true) {
      if (ctx.jobs === undefined) {
        return failResult('failed',
          '这个环境没有后台作业注册表，无法后台运行。请改用前台执行（去掉 background）。',
        )
      }
      const job = await ctx.jobs.start({
        command: args.command,
        file,
        argv,
        cwd,
        label: direct ? `${args.command} ${argv.join(' ')}`.trim() : args.command,
      })
      return okResult(backgroundNote(job.id, job.pid, args.command, direct), {
        background: true,
        jobId: job.id,
        pid: job.pid,
        command: args.command,
        cwd,
        viaShell: !direct,
      })
    }

    // --- 输出走文件，不走管道 ---
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mvs-cmd-'))
    const outPath = path.join(tmpDir, 'stdout.txt')
    const errPath = path.join(tmpDir, 'stderr.txt')
    const outFd = openSync(outPath, 'w')
    const errFd = openSync(errPath, 'w')

    let child: ChildProcess | null = null
    let spawnError: unknown = null
    let outcome: Outcome | null = null
    /** 捕获文件被截过（yes 那种输出炸弹） */
    let capped = false
    /** 运行中磁盘跌破底线，命令被我们中止 */
    let diskLow = false

    try {
      try {
        child = spawn(file, argv, {
          cwd,
          stdio: ['ignore', outFd, errFd],
          windowsHide: true,
          // POSIX：给子进程单独开一个进程组，这样超时 / 取消时能整组一起杀
          // （`process.kill(-pid)`）。不开组就只能杀到直接子进程，它派出去的
          // 孙进程会活下来继续写文件 —— 见 killTree 的注释。
          //
          // Windows 上刻意**不**开：那里没有进程组信号，开 detached 只会多出
          // 一个控制台窗口，而真正管用的是 taskkill /T。
          detached: process.platform !== 'win32',
        })
      } catch (err) {
        // 实测：沙箱下的 EPERM 是同步抛出的，必须在这里接住
        spawnError = err
      }
      /*
       * 运行期巡检（250 ms 一次）：
       *   1. 把捕获文件截到 8 MB —— 否则 `yes` 能在 30 秒里写出 GB 级临时文件
       *   2. 磁盘余量跌破底线 → 杀树（挡住"命令自己把盘写满"）
       *
       * 巡检**不改变**命令的结果语义：它只在越界时动手，并留下一条说明。
       */
      const watcher =
        child === null
          ? null
          : setInterval(() => {
              void (async () => {
                for (const file of [outPath, errPath]) {
                  if (await capCaptureFile(file, MAX_CAPTURE_BYTES)) capped = true
                }
                const free = await freeBytesOf(cwd)
                if (free !== null && free < floor && !diskLow) {
                  diskLow = true
                  if (child !== null) killTree(child)
                }
              })()
            }, CAPTURE_WATCH_MS)

      try {
        if (child !== null) outcome = await waitFor(child, timeoutMs, ctx.signal)
      } finally {
        if (watcher !== null) clearInterval(watcher)
      }
    } finally {
      closeSync(outFd)
      closeSync(errFd)
    }

    try {
      if (spawnError !== null) return classifySpawnError(spawnError, args.command)

      const stdout = await readCapped(outPath, maxOutput)
      const stderr = await readCapped(errPath, maxOutput)
      const data = {
        command: args.command,
        args: args.args ?? null,
        cwd,
        viaShell: !direct,
        exitCode: outcome?.type === 'close' ? outcome.code : null,
        signal: outcome?.type === 'close' ? outcome.signal : null,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        /*
         * 原始字节数要如实给出：`truncated` 只说"被截过"，不说"原来多大"。
         * 用户看到「输出已截断」时第一个问题就是"有多少我没看到"。
         */
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
      }

      /*
       * 磁盘跌破底线被我们中止：这不是命令的错，也不是它的退出码，
       * 所以要单独回一个 kind，并在文案里说清"是我们停的"。
       */
      if (diskLow) {
        return failResult(
          'insufficient_disk',
          `命令运行期间磁盘剩余空间跌破底线（${(floor / 1024 / 1024).toFixed(0)} MB），已中止。`,
          { content: composeContent(null, 'SIGKILL', stdout.text, stderr.text), data },
        )
      }

      if (outcome?.type === 'timeout') {
        const note =
          `命令超过 ${timeoutMs}ms 未结束，已强制终止` +
          (outcome.wholeTree
            ? ''
            : '（只终止了直接子进程 —— 这个环境不允许杀整棵进程树，它派生的孙进程可能还在运行）')
        return failResult('timeout', note, {
          content: composeContent(null, 'SIGKILL', stdout.text, stderr.text, note),
          data,
        })
      }

      if (outcome?.type === 'aborted') {
        return failResult('aborted', '命令已被取消', {
          content: composeContent(null, 'SIGKILL', stdout.text, stderr.text, '命令已被取消'),
          data,
        })
      }

      if (outcome?.type === 'error') {
        return classifySpawnError(outcome.err, args.command)
      }

      const code = outcome?.type === 'close' ? outcome.code : null
      const signalName = outcome?.type === 'close' ? outcome.signal : null
      const capNote =
        stdout.truncated || stderr.truncated
          ? `输出被截断：stdout 原始 ${stdout.bytes} 字节、stderr 原始 ${stderr.bytes} 字节，只保留了前 ${MAX_CAPTURE_BYTES} 字节。要看细节请用更精确的命令（grep / 重定向到文件后再读）。`
          : null
      const content = capNote === null
        ? composeContent(code, signalName, stdout.text, stderr.text)
        : composeContent(code, signalName, stdout.text, stderr.text, capNote)

      if (code === 0) return okResult(content, data)
      return failResult('failed', `命令退出码 ${code ?? `(被信号 ${signalName} 终止)`}`, {
        content,
        data,
      })
    } finally {
      await rm(tmpDir, { recursive: true, force: true })
    }
  },
}

// ---------------------------------------------------------------------------

type Outcome =
  | { type: 'close'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'error'; err: unknown }
  /**
   * `wholeTree` = 连孙进程一起收掉了吗。
   *
   * 实测：`taskkill /T` 在受限环境里会被直接拒绝（返回 1），那时兜底只能收掉
   * 直接子进程 —— 孙进程可能还在写文件。所以「已强制终止」这句话必须带上
   * 这个结论，否则就是一句假话。
   */
  | { type: 'timeout'; wholeTree: boolean }
  | { type: 'aborted'; wholeTree: boolean }

/** 强制终止后等它真正退出的宽限期 */
const REAP_GRACE_MS = 2000

/**
 * 等子进程结束。
 *
 * 关键点：**超时 / 取消时不能立刻返回。** 必须等 `close` 真正到达，
 * 否则调用方拿到结果时子进程还活着 —— 它仍占着 cwd、仍持有文件句柄，
 * 而且我们读到的是残缺的输出。
 *
 * 这个 bug 是通过测试清理时偶发的 `EBUSY: resource busy or locked, rmdir`
 * 暴露出来的：被杀掉的命令还占着临时工作目录，导致该目录删不掉。
 */
function waitFor(
  child: ChildProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Outcome> {
  return new Promise((resolve) => {
    let settled = false
    /** 超时/取消时「打算」报告的结果；但要等进程真正退出才 resolve */
    let forced: Outcome | null = null
    let reapTimer: NodeJS.Timeout | undefined

    const cleanup = (): void => {
      clearTimeout(timer)
      if (reapTimer !== undefined) clearTimeout(reapTimer)
      signal?.removeEventListener('abort', onAbort)
    }

    const finish = (result: Outcome): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    /**
     * 终止。
     *
     * 收下 `killTree` 的结论再写进 `forced`：`taskkill` 被拒时兜底只能收掉
     * 直接子进程，那时"已强制终止"是半句真话，必须让上层看得见。
     */
    const terminate = (intent: { type: 'timeout' | 'aborted' }): void => {
      if (forced !== null) return
      const outcome = killTree(child)
      const result: Outcome = { ...intent, wholeTree: outcome.wholeTree }
      forced = result
      // 兜底：极端情况下 close 一直不来，也不能永远挂着
      reapTimer = setTimeout(() => finish(result), REAP_GRACE_MS)
    }

    const timer = setTimeout(() => terminate({ type: 'timeout' }), timeoutMs)
    const onAbort = (): void => terminate({ type: 'aborted' })

    child.on('error', (err) => finish(forced ?? { type: 'error', err }))
    child.on('close', (code, signalName) =>
      finish(forced ?? { type: 'close', code, signal: signalName }),
    )

    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}


/**
 * 后台启动之后回给模型的那段话。
 *
 * **必须把「不受恢复层保护」写进去。** 这不是免责声明，是模型做后续决策要用到的
 * 事实：它可能正打算「先跑构建、再撤销上一步」，而那条路在这里是走不通的。
 * 把限制说给模型听，比让它在几步之后撞上一个删掉了构建产物的「撤销」要好得多。
 */
function backgroundNote(jobId: string, pid: number | null, command: string, direct: boolean): string {
  const how = direct ? '直接启动（未经 shell）' : '经 shell 解析'
  return [
    `已在后台启动：${command}`,
    `作业 id：${jobId}${pid === null ? '' : ` · 进程 ${pid}`}`,
    `启动方式：${how}`,
    '它不会在这里返回退出码。用 list_jobs 看状态，用 job_output 看输出，用 kill_job 停掉它。',
    '',
    '⚠️ 这个作业**不受恢复层保护**：它的文件改动发生在快照边界之后，撤销覆盖不到它。',
    '   因此它不会产生可撤销条目 —— 这是刻意的，「撤销了但没效果」比「没有撤销」更危险。',
  ].join('\n')
}

/** 把沙箱拒绝和真正的执行失败分开 —— 这两者的正确处理方式完全不同 */
function classifySpawnError(err: unknown, command: string): ToolResult {  const code = (err as NodeJS.ErrnoException | null)?.code

  if (code === 'EPERM' || code === 'EACCES') {
    return failResult(
      'sandbox',
      `执行被沙箱拒绝（${code}）：${command}。这不是命令本身失败 —— 重试同一个命令不会有不同结果。`,
    )
  }
  if (code === 'ENOENT') {
    return failResult('not_found', `找不到可执行文件：${command}`)
  }
  return failResult('failed', `启动子进程失败（${code ?? '未知错误'}）：${messageOf(err)}`)
}

function composeContent(
  code: number | null,
  signalName: NodeJS.Signals | null,
  stdout: string,
  stderr: string,
  note?: string,
): string {
  const parts: string[] = []
  if (note) parts.push(note)
  parts.push(`退出码：${code ?? `(被信号 ${signalName} 终止)`}`)
  if (stdout.trim() !== '') parts.push(`--- stdout ---\n${stdout}`)
  if (stderr.trim() !== '') parts.push(`--- stderr ---\n${stderr}`)
  if (stdout.trim() === '' && stderr.trim() === '') parts.push('(没有输出)')
  return parts.join('\n')
}

/**
 * 读捕获文件，**流式、按字节封顶**。
 *
 * 原来是 `readFile` 整个读进来再截断 —— 那等于先把一个 GB 级文件塞进内存。
 * 现在只读到 `max * 4` 字节（UTF-8 最坏一个字符 4 字节），再按字符截断：
 * 内存占用有上界，而且和文件实际大小无关（截断过的文件可能是稀疏的）。
 */
async function readCapped(
  file: string,
  max: number,
): Promise<{ text: string; truncated: boolean; bytes: number }> {
  const info = await stat(file).catch(() => null)
  if (info === null) return { text: '', truncated: false, bytes: 0 }

  const bytes = info.size
  /* 空文件直接返回 —— 否则下面会算出 end = -1（createReadStream 会抛 RangeError） */
  if (bytes === 0) return { text: '', truncated: false, bytes: 0 }

  const want = Math.min(bytes, Math.max(1, max * 4))
  const chunks: Buffer[] = []

  await new Promise<void>((resolve) => {
    const stream = createReadStream(file, { start: 0, end: want - 1 })
    stream.on('data', (chunk) => chunks.push(chunk as Buffer))
    stream.on('error', () => resolve())
    stream.on('end', () => resolve())
    stream.on('close', () => resolve())
  })

  let text = Buffer.concat(chunks).toString('utf8')
  const droppedChars = text.length > max
  if (droppedChars) text = text.slice(0, max)

  const truncated = droppedChars || bytes > Buffer.byteLength(text, 'utf8')
  if (!truncated) return { text, truncated: false, bytes }

  return {
    text: `${text}\n…（输出已截断：只保留前 ${Math.min(bytes, MAX_CAPTURE_BYTES)} 字节，原始 ${bytes} 字节）`,
    truncated: true,
    bytes,
  }
}

function shellInvocation(command: string): readonly [string, string[]] {
  if (process.platform === 'win32') {
    return [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command]]
  }
  return ['/bin/sh', ['-c', command]]
}

async function statOrNull(p: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(p)
  } catch {
    return null
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
