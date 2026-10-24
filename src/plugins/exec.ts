/**
 * 跑一条插件命令。
 *
 * ## 为什么不复用 `run_command` 的实现
 *
 * 三处实质不同，硬套会让那边多出三个它会误用的参数：
 *
 *   1. **环境变量**：插件默认拿不到任何业务变量，只有声明过的才注入；
 *      `run_command` 用的是继承环境
 *   2. **没有 shell**：这里永远 `shell: false`
 *   3. **没有后台模式**：插件的调用就是一次同步等待
 *
 * 相同的是那些坑：**不用管道 stdio**（本环境下 `stdio: 'pipe'` 会同步抛 EPERM）、
 * 输出走临时文件、超时杀整棵进程树。这三条照抄 `command-tool.ts`，
 * 并在下面注释里标出来源，免得以后有人"顺手"改成管道。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { killTreeOf } from '../tools/kill-tree.ts'

export interface ExecRequest {
  file: string
  argv: string[]
  cwd: string
  /** 只放声明过的变量 + 最小系统变量，**不继承** process.env */
  env: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  maxOutputChars: number
  /** 有值时写到子进程的 stdin（用临时文件 + fd，不用管道） */
  stdinText?: string
}

export interface ExecResult {
  code: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  stdout: string
  stderr: string
  truncated: boolean
  /** 启动就失败（命令不存在、权限不足…）。此时 code 一定是 null */
  spawnError?: string
}

/** 强制终止后等它真正退出的宽限期（和 command-tool 一致） */
const REAP_GRACE_MS = 2_000

export async function execCaptured(request: ExecRequest): Promise<ExecResult> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'mvs-plugin-'))
  const outPath = path.join(tmpDir, 'stdout.txt')
  const errPath = path.join(tmpDir, 'stderr.txt')
  const inPath = path.join(tmpDir, 'stdin.txt')

  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let inFd: number | null = null

  if (request.stdinText !== undefined) {
    await writeFile(inPath, request.stdinText, 'utf8')
    inFd = openSync(inPath, 'r')
  }

  let child: ChildProcess | null = null
  let spawnError: string | undefined
  let timedOut = false
  let aborted = false

  try {
    try {
      child = spawn(request.file, request.argv, {
        cwd: request.cwd,
        stdio: [inFd === null ? 'ignore' : inFd, outFd, errFd],
        windowsHide: true,
        /*
         * POSIX：单独开进程组，这样超时能整组一起杀（`process.kill(-pid)`）。
         * 不开的话它派出去的孙进程会活下来继续写文件 —— 见 `kill-tree.ts`。
         * Windows 上刻意不开：那里没有进程组信号，起作用的是 taskkill /T。
         */
        detached: process.platform !== 'win32',
        env: request.env,
      })
    } catch (err) {
      /* 实测：沙箱限制下的 EPERM 是**同步抛出**的，必须在这里接 */
      spawnError = messageOf(err)
    }

    if (child !== null) {
      const outcome = await waitFor(child, request)
      timedOut = outcome.timedOut
      aborted = outcome.aborted
    }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
    if (inFd !== null) closeSync(inFd)
  }

  try {
    const stdout = readCapped(outPath, request.maxOutputChars)
    const stderr = readCapped(errPath, request.maxOutputChars)

    return {
      code: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
      timedOut,
      aborted,
      stdout: stdout.text,
      stderr: stderr.text,
      truncated: stdout.truncated || stderr.truncated,
      ...(spawnError === undefined ? {} : { spawnError }),
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {
      /* 临时目录删不掉不影响结果，安静跳过 */
    })
  }
}

interface WaitOutcome {
  timedOut: boolean
  aborted: boolean
}

function waitFor(child: ChildProcess, request: ExecRequest): Promise<WaitOutcome> {
  return new Promise<WaitOutcome>((resolve) => {
    let settled = false
    let timedOut = false
    let aborted = false

    const finish = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ timedOut, aborted })
    }

    /*
     * 超时 / 取消时的做法：
     *   1. 先杀整棵树
     *   2. 等 `close`（有宽限期）
     *   3. 宽限期到还没关就**直接返回**，不再等 —— 输出已经写在文件里，
     *      读得到；而"等一个死不了的进程"会让整轮对话卡死
     */
    const terminate = (why: 'timeout' | 'abort'): void => {
      if (why === 'timeout') timedOut = true
      else aborted = true
      killTreeOf(child)
      setTimeout(() => {
        finish()
      }, REAP_GRACE_MS).unref?.()
    }

    const timer = setTimeout(() => terminate('timeout'), request.timeoutMs)
    const onAbort = (): void => terminate('abort')
    request.signal?.addEventListener('abort', onAbort, { once: true })

    function cleanup(): void {
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
    }

    child.on('close', finish)
    child.on('error', () => {
      /* 启动失败由 spawnError 或 exitCode 反映，这里只负责解除等待 */
      finish()
    })

    if (request.signal?.aborted === true) terminate('abort')
  })
}

/** 读文件并截断到上限。返回是否被截断 —— 截断必须能被上层说出来 */
function readCapped(file: string, limit: number): { text: string; truncated: boolean } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { text: '', truncated: false }
  }
  if (raw.length <= limit) return { text: raw, truncated: false }
  return {
    text: `${raw.slice(0, limit)}\n…（输出被截断到 ${limit} 字符，原文 ${raw.length} 字符）`,
    truncated: true,
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 清理用（测试与调试时手动删临时目录） */
export function removeDirQuietly(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}
