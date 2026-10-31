/**
 * 行为评估的命令行入口。
 *
 * ## 用法
 *
 *     node src/cli/eval.ts                          # 跑 eval/scenarios 下全部场景
 *     node src/cli/eval.ts --only write-file        # 只跑一个
 *     node src/cli/eval.ts --profile ollama         # 指定模型档案
 *     node src/cli/eval.ts --scripted               # 脚本化模型（自检，不给结论）
 *     node src/cli/eval.ts --out report.json        # 另存报告
 *
 * ## 模型从哪儿来
 *
 * 走 `Runtime` 的 `modelFactory` 注入点 —— 那正是会话拿模型的那条缝。
 * 默认工厂就是 `OpenAICompatibleClient`，这里照同一份映射再建一个，
 * 于是"评估时用的模型"和"产品里用的模型"是**同一条构造路径**，不会漂移。
 *
 * ## 为什么有 `--scripted`
 *
 * 没有可用模型的时候（比如本机没起 Ollama），这个工具**仍然要能证明自己是活的**。
 * 但那份报告 `meta.scripted` 为 true，汇总行也会明说「这是自检」——
 * 一份被误读的评估报告比没有更糟。
 */

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { loadScenarios, runScenarios } from '../eval/run.ts'
import { createScriptedModel } from '../eval/scripted.ts'
import type { Scenario, ScenarioResult } from '../eval/types.ts'
import { OpenAICompatibleClient } from '../model/openai-compatible.ts'
import type { ModelClient } from '../model/types.ts'
import type { ResolvedConfig } from '../config/resolve.ts'

const DEFAULT_SCENARIOS = 'eval/scenarios'

function argOf(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

function printResult(result: ScenarioResult): void {
  const status = result.ok ? '通过' : '失败'
  process.stdout.write(`  ${result.id}  [${status}]  ${result.observations.ms} ms\n`)
  process.stdout.write(
    `    工具：${result.observations.tools.map((tool) => tool.name).join(' / ') || '（没调用）'}` +
      `　审批 ${result.observations.approvals} 次　事务 ${result.observations.transactions} 个\n`,
  )
  for (const failure of result.failures) {
    const tag = failure.kind === 'invariant' ? '产品' : '模型'
    process.stdout.write(`    [${tag}] ${failure.message}\n`)
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const scenarioDir = argOf(argv, '--scenarios') ?? DEFAULT_SCENARIOS
  const only = argOf(argv, '--only')
  const profile = argOf(argv, '--profile')
  const outPath = argOf(argv, '--out')
  const scripted = flag(argv, '--scripted')
  const timeoutRaw = Number(argOf(argv, '--timeout') ?? '')

  let scenarios: Scenario[]
  try {
    scenarios = await loadScenarios(path.resolve(scenarioDir))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
    return
  }

  if (scenarios.length === 0) {
    process.stderr.write(`没有场景：${path.resolve(scenarioDir)} 下没有 *.json\n`)
    process.exitCode = 2
    return
  }

  const modelFactory: (resolved: ResolvedConfig) => ModelClient = scripted
    ? () => createScriptedModel()
    : (resolved) =>
        new OpenAICompatibleClient({
          baseUrl: resolved.baseUrl,
          model: resolved.model,
          ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
          includeUsage: resolved.includeUsage,
        })

  process.stdout.write(`场景：${scenarios.length} 个（${path.resolve(scenarioDir)}）\n`)
  if (scripted) {
    process.stdout.write('模型：脚本化（自检）\n')
    process.stdout.write('⚠ 这是自检：脚本化模型按固定脚本回答，它的结果**不是**对模型的评估。\n')
  } else {
    process.stdout.write(`模型：配置解析出的那个${profile === undefined ? '' : `（--profile ${profile}）`}\n`)
  }
  process.stdout.write('\n')

  const report = await runScenarios({
    scenarios,
    modelFactory,
    modelLabel: scripted ? '脚本化模型' : '按配置解析',
    profile: profile ?? (scripted ? 'scripted' : 'config'),
    scripted,
    ...(Number.isInteger(timeoutRaw) && timeoutRaw > 0 ? { timeoutMs: timeoutRaw } : {}),
    ...(only === undefined ? {} : { only: [only] }),
    onProgress: ({ result }) => {
      if (result !== undefined) printResult(result)
    },
  })

  const { summary, meta } = report
  process.stdout.write(
    `\n合计 ${summary.total} 个：通过 ${summary.passed}，失败 ${summary.failed}` +
      `（其中产品层面的失败 ${summary.invariantFailures} 个）　用时 ${summary.ms} ms\n`,
  )
  if (meta.scripted) {
    process.stdout.write('⚠ 自检报告：只证明这套工具是活的，不构成对模型行为的任何结论。\n')
  }

  if (outPath !== undefined) {
    await writeFile(path.resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(`报告已写入 ${path.resolve(outPath)}\n`)
  }

  /* 有失败就退出码 1 —— 否则没人会去看 */
  process.exitCode = summary.failed > 0 ? 1 : 0
}

await main()
