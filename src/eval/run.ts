/**
 * 跑场景。
 *
 * ## 为什么要起一个**真的 Runtime**
 *
 * 这一步整个 eval 的价值都在这里：断言的对象是**产品真实跑起来之后的事实**
 * （投影、事件日志、恢复层的事务），不是某个函数的返回值。用假对象拼一份
 * 结果很快，但那种报告证明不了任何东西。
 *
 * ## 每个场景一个临时家目录 + 一个临时工作区
 *
 * 场景之间不能互相污染：上一条留下的 `state.json`、恢复层里的事务、会话日志
 * 都会影响下一条的观察结果（尤其是"可撤销事务数"）。
 *
 * ## 审批自动同意
 *
 * 默认同意，是为了让场景能跑完；**该不该问人**用 `expect.approvalAsked` /
 * `expect.noApproval` 断言，而不是靠人坐在那里点。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ConfigStore } from '../config/index.ts'
import { StateStore } from '../config/state.ts'
import { Runtime, type RuntimeOptions } from '../host/runtime.ts'
import type { ModelClient } from '../model/types.ts'
import { checkAll } from './assert.ts'
import { createScriptedModel } from './scripted.ts'
import type {
  EvalReport,
  Failure,
  Observations,
  Scenario,
  ScenarioResult,
} from './types.ts'

export interface RunOptions {
  scenarios: Scenario[]
  /** 真实模型：由调用方按配置构造 */
  modelFactory: RuntimeOptions['modelFactory']
  /** 报告里写的模型名与 profile */
  modelLabel: string
  profile: string
  /**
   * true = 用脚本化模型（自检）。
   *
   * ⚠️ 必须是**每个场景一份新实例**：脚本化模型靠"第几次被调用"决定返回
   * 工具调用还是收尾正文。跨场景共用一份，第二个场景会从"收尾"开始，
   * 于是自检报告会莫名其妙全失败 —— 而那与产品无关。
   */
  scripted: boolean
  /** 单个场景的默认超时 */
  timeoutMs?: number
  /** 跑哪几个（空 = 全部） */
  only?: string[]
  /** 进度回调（CLI 用来打点） */
  onProgress?: (event: { index: number; total: number; scenario: Scenario; result?: ScenarioResult }) => void
}

const DEFAULT_TIMEOUT = 120_000

async function readIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 把 MVS_HOME / 会话目录 / 恢复目录临时指到本次运行的家目录。
 *
 * 这三个都是通过**环境变量**读的（见 `defaultSessionDir` / `defaultRecoveryDir`），
 * 所以只能这样隔离。返回一个还原函数，`finally` 里一定要调。
 */
function isolate(home: string): () => void {
  const keys = ['MVS_HOME', 'MVS_SESSION_DIR', 'MVS_RECOVERY_DIR'] as const
  const saved = new Map<string, string | undefined>()
  for (const key of keys) saved.set(key, process.env[key])

  process.env.MVS_HOME = home
  process.env.MVS_SESSION_DIR = path.join(home, 'sessions')
  process.env.MVS_RECOVERY_DIR = path.join(home, 'recovery')

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function runOne(
  scenario: Scenario,
  options: RunOptions,
  base: string,
): Promise<ScenarioResult> {
  const home = path.join(base, `${scenario.id}-home`)
  const workspace = path.join(base, `${scenario.id}-ws`)
  await mkdir(home, { recursive: true })
  await mkdir(workspace, { recursive: true })

  for (const [rel, content] of Object.entries(scenario.files ?? {})) {
    const abs = path.join(workspace, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, content, 'utf8')
  }

  const restore = isolate(home)
  const startedAt = Date.now()
  let timedOut = false
  let approvals = 0

  let runtime: Runtime | undefined
  try {
    const modelFactory: RunOptions['modelFactory'] = options.scripted
      ? (() => {
          const client = createScriptedModel()
          return () => client
        })()
      : options.modelFactory

    runtime = new Runtime({
      config: new ConfigStore(home),
      state: new StateStore(home),
      probe: false,
      modelFactory,
    })
    await runtime.init()
    await runtime.openWorkspace(workspace)

    const summary = await runtime.createSession(workspace, scenario.id)
    const session = await runtime.ensureSession(summary.sessionId)
    if (session === undefined) throw new Error('会话建不起来')

    if (scenario.mode !== undefined) await session.setMode(scenario.mode)

    /* 审批：订阅事件，遇到就按 autoApprove 回答（并数出来） */
    const unsubscribe = session.subscribe((envelope) => {
      if (envelope.event.type !== 'approval_requested') return
      approvals += 1
      session.resolveApproval(envelope.event.approvalId, scenario.autoApprove !== false)
    })

    const timeoutMs = scenario.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT
    type Race = { kind: 'done' } | { kind: 'timeout' }
    const raced = await Promise.race<Race>([
      session.sendUserMessage(scenario.prompt).then(() => ({ kind: 'done' }) as Race),
      new Promise<Race>((resolve) => {
        const timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
        /* 不让这个定时器把进程拖住 */
        timer.unref?.()
      }),
    ])

    if (raced.kind === 'timeout') {
      timedOut = true
      session.abort()
    }

    unsubscribe()

    const projection = session.projection()
    const tools = projection.toolCalls.map((call) => ({
      name: call.tool,
      ok: call.ok === true,

    }))

    const lastAssistant = [...projection.messages].reverse().find((message) => message.role === 'assistant')
    const finalText =
      lastAssistant === undefined
        ? ''
        : typeof lastAssistant.content === 'string'
          ? lastAssistant.content
          : JSON.stringify(lastAssistant.content)

    const wanted = new Set<string>([
      ...Object.keys(scenario.files ?? {}),
      ...Object.keys(scenario.expect?.fileContains ?? {}),
      ...(scenario.expect?.fileMissing ?? []),
    ])
    const files: Record<string, string> = {}
    for (const rel of wanted) {
      const content = await readIfExists(path.join(workspace, rel))
      if (content !== undefined) files[rel] = content
    }

    const transactions = (await runtime.listTransactions(summary.sessionId, false))?.length ?? 0

    const observations: Observations = {
      finalText,
      tools,
      steps: tools.length,
      status: projection.status,
      approvals,
      files,
      transactions,
      malformed: projection.malformedEvents ?? 0,
      unsettledCall: projection.interruptedCall !== null,
      pendingApproval: projection.pendingApproval !== null,
      ms: Date.now() - startedAt,
      ...(timedOut ? { timedOut: true } : {}),
    }

    const failures = checkAll(scenario, observations)
    return {
      id: scenario.id,
      description: scenario.description,
      ok: failures.length === 0,
      observations,
      failures,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failures: Failure[] = [{ kind: 'invariant', message: `场景跑不下去：${message}` }]
    return {
      id: scenario.id,
      description: scenario.description,
      ok: false,
      observations: {
        finalText: '',
        tools: [],
        steps: 0,
        status: 'error',
        approvals,
        files: {},
        transactions: 0,
        malformed: 0,
        unsettledCall: false,
        pendingApproval: false,
        ms: Date.now() - startedAt,
      },
      failures,
    }
  } finally {
    if (runtime !== undefined) await runtime.dispose?.().catch(() => undefined)
    restore()
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function runScenarios(options: RunOptions): Promise<EvalReport> {
  const startedAt = new Date().toISOString()
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-eval-'))
  const selected = options.only === undefined || options.only.length === 0
    ? options.scenarios
    : options.scenarios.filter((scenario) => options.only!.includes(scenario.id))

  const results: ScenarioResult[] = []
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const scenario = selected[index]!
      options.onProgress?.({ index, total: selected.length, scenario })
      const result = await runOne(scenario, options, base)
      results.push(result)
      options.onProgress?.({ index, total: selected.length, scenario, result })
    }
  } finally {
    await rm(base, { recursive: true, force: true }).catch(() => undefined)
  }

  const finishedAt = new Date().toISOString()
  return {
    meta: {
      startedAt,
      finishedAt,
      model: options.modelLabel,
      profile: options.profile,
      scripted: options.scripted,
    },
    results,
    summary: {
      total: results.length,
      passed: results.filter((result) => result.ok).length,
      failed: results.filter((result) => !result.ok).length,
      invariantFailures: results.filter((result) =>
        result.failures.some((failure) => failure.kind === 'invariant'),
      ).length,
      ms: Date.parse(finishedAt) - Date.parse(startedAt),
    },
  }
}

/** 读一个场景目录里的 `*.json`。坏文件要**说出文件名**，不能静默跳过 */
export async function loadScenarios(dir: string): Promise<Scenario[]> {
  const { readdir } = await import('node:fs/promises')
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  const scenarios: Scenario[] = []

  for (const name of names) {
    const raw = await readFile(path.join(dir, name), 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error(`场景文件不是合法 JSON：${name} —— ${error instanceof Error ? error.message : String(error)}`)
    }
    const scenario = parsed as Scenario
    if (typeof scenario.id !== 'string' || typeof scenario.prompt !== 'string') {
      throw new Error(`场景缺少 id 或 prompt：${name}`)
    }
    scenarios.push(scenario)
  }

  return scenarios
}
