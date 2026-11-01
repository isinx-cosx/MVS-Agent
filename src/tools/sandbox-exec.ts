/**
 * 沙箱执行：把一条命令交给 `tools/sandbox-run.mjs`（受限令牌 + 低完整性 + Job 上限）。
 *
 * ## 为什么是"调一个子进程"而不是"在进程内降权"
 *
 * 降权令牌是**进程级**的东西：`CreateProcessAsUser` 只能决定"新进程用什么令牌"，
 * 改不了自己。所以要么每条命令起一个 worker，要么整个守护进程降权 ——
 * 后者会让守护进程连自己的工作区都写不了。前者的代价是每条命令多一次 `node` 启动
 * （实测 ~120 ms），换来的是"命令在 Job 里、杀得干净、写字节可度量"。
 *
 * ## 两个必须传准的东西
 *
 * - **cwd**：Low 完整性下能写哪里完全由目录标签决定，cwd 传错就等于什么都没保护
 * - **timeoutMs**：worker 自己等，`WaitForSingleObject` 超时后 `TerminateJobObject`
 *   —— 整棵树一起收，不留孤儿
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface SandboxRunInput {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  maxProcesses?: number
  maxMemoryMb?: number
  cpuSeconds?: number
}

export interface SandboxRunOutput {
  ok: boolean
  /** 拿不到 worker 结果时只有这个字段有意义 */
  error?: string
  exitCode?: number
  timedOut?: boolean
  writeBytes?: number
  stdout?: string
  stderr?: string
}

/** 找 worker：源码树里跑和打包后跑，路径不同 */
function workerPath(): string {
  const candidates = [
    path.join(process.cwd(), 'tools', 'sandbox-run.mjs'),
    path.join(import.meta.dirname ?? '.', '..', '..', 'tools', 'sandbox-run.mjs'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

/**
 * 跑一次沙箱命令。
 *
 * 返回 `{ ok: false, error }` 表示**沙箱本身没起来** —— 这一种必须和"命令失败"
 * 区分开：前者是配置/环境问题，后者是命令自己的事。
 */
export async function runInSandbox(input: SandboxRunInput): Promise<SandboxRunOutput> {
  const args = [
    workerPath(),
    '--cwd',
    input.cwd,
    '--timeout-ms',
    String(input.timeoutMs),
    ...(input.maxProcesses === undefined ? [] : ['--max-processes', String(input.maxProcesses)]),
    ...(input.maxMemoryMb === undefined ? [] : ['--max-memory-mb', String(input.maxMemoryMb)]),
    ...(input.cpuSeconds === undefined ? [] : ['--cpu-seconds', String(input.cpuSeconds)]),
    '--',
    input.command,
    ...input.args,
  ]

  const raw = await new Promise<string>((resolve, reject) => {
    /* ffmpeg 那条教训：stdio 必须 ignore 之外的那一路才拿得到输出，这里要 pipe */
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', () => {
      resolve(out.trim() === '' ? err.trim() : out.trim())
    })
  })

  const line = raw.split('\n').filter((item) => item.trim().startsWith('{')).at(-1)
  if (line === undefined) {
    return { ok: false, error: `沙箱没有返回结果：${raw.slice(0, 200)}` }
  }
  try {
    const parsed = JSON.parse(line) as SandboxRunOutput
    return parsed
  } catch {
    return { ok: false, error: `沙箱结果不是 JSON：${line.slice(0, 200)}` }
  }
}
