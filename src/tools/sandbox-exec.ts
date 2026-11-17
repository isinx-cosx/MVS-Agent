import { mkdir } from 'node:fs/promises'
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
  /**
   * 显式选择执行器。
   *
   * 为什么不是只读环境变量：测试是**同一个进程里并发跑**的（`--test-isolation=none`），
   * 一个用例设 `MVS_SANDBOX` 会让别的用例也跟着进沙箱 —— 那是污染，不是覆盖。
   * 显式传参就没有这个问题；不传时才回落到环境变量。
   */
  mode?: 'offline' | 'job'
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  maxProcesses?: number
  maxMemoryMb?: number
  /* 写盘字节上限（MB）：超过就杀整棵树 —— 写盘填满的正面防线 */
  maxWriteMb?: number
  cpuSeconds?: number
}

export interface SandboxRunOutput {
  ok: boolean
  /** 拿不到 worker 结果时只有这个字段有意义 */
  error?: string
  exitCode?: number
  /** 执行器报的网络状态：blocked = AppContainer 断网 */
  network?: 'blocked' | 'allowed'
  /** 沙箱工作的证据（job 是否挂上、授权是否成功），用于诊断 */
  job?: string
  granted?: string
  timedOut?: boolean
  writeBytes?: number
  stdout?: string
  stderr?: string
}

/** 找 worker：源码树里跑和打包后跑，路径不同 */
/**
 * 挑哪一个执行器。
 *
 * 两个 worker 的分工是**实测逼出来的**，不是设计选择：
 *
 *   `sandbox-net-run.mjs`  AppContainer 断网（DNS 级拒绝），但不挂 Job
 *   `sandbox-run.mjs`      Job 四道上限齐全，但能联网
 *
 * 把 AppContainer 属性塞进带 Job 的那个属性列表里，node 会崩在
 * `InitializeOncePerProcess`（exit 134，试过六种组合）。所以按"要不要断网"二选一：
 * 默认断网（安全优先），`MVS_SANDBOX_NET=1` 时用带 Job 上限的那个。
 */
function workerPath(mode?: 'offline' | 'job'): string {
  const resolved = mode ?? (process.env['MVS_SANDBOX_NET'] === '1' ? 'job' : 'offline')
  const script = resolved === 'job' ? 'sandbox-run.mjs' : 'sandbox-net-run.mjs'
  const candidates = [
    path.join(process.cwd(), 'tools', script),
    path.join(import.meta.dirname ?? '.', '..', '..', 'tools', script),
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
    workerPath(input.mode),
    '--cwd',
    input.cwd,
    '--timeout-ms',
    String(input.timeoutMs),
    ...(input.maxProcesses === undefined ? [] : ['--max-processes', String(input.maxProcesses)]),
    ...(input.maxMemoryMb === undefined ? [] : ['--max-memory-mb', String(input.maxMemoryMb)]),
    ...(input.maxWriteMb === undefined ? [] : ['--max-write-mb', String(input.maxWriteMb)]),
    ...(input.cpuSeconds === undefined ? [] : ['--cpu-seconds', String(input.cpuSeconds)]),
    '--',
    input.command,
    ...input.args,
  ]

  /*
   * 把 TMP/TEMP 指到**工作区里**的临时目录。
   *
   * 之前是把整个 `%TEMP%` 授权给 AppContainer（`sandbox:grant` 里的 `tmpdir()`），
   * 等于"只写工作区"这句话是假的 —— 系统临时目录也能写，而那里常被 AV 和备份排除。
   *
   * 改成：给子进程设 `TMP`/`TEMP` 指向 `<cwd>/.mvs/tmp`（工作区内的路径，本来就有授权），
   * 于是写入范围回到"只有工作区"。命令显式写 `%TEMP%` 绝对路径仍然会被拒 —— 这是期望行为。
   */
  const scopedTemp = path.join(input.cwd, '.mvs', 'tmp')
  try {
    await mkdir(scopedTemp, { recursive: true })
  } catch {
    /* 建不出来就让子进程用自己的临时目录，不因此让命令失败 */
  }
  const env = { ...process.env, TMP: scopedTemp, TEMP: scopedTemp }

  const raw = await new Promise<string>((resolve, reject) => {
    /* ffmpeg 那条教训：stdio 必须 ignore 之外的那一路才拿得到输出，这里要 pipe */
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
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
