/**
 * 配置的人工入口。UI 的设置面板做同一件事，只是更好看。
 *
 * 用法：
 *   node src/cli/config.ts show
 *   node src/cli/config.ts path
 *   node src/cli/config.ts set model.model deepseek-chat
 *   node src/cli/config.ts set model.baseUrl https://api.deepseek.com/v1
 *   node src/cli/config.ts set model.apiKeyEnv DEEPSEEK_API_KEY
 *   node src/cli/config.ts set permissions.defaultMode read-only
 *   node src/cli/config.ts unset model.apiKey
 */

import process from 'node:process'
import { ConfigStore, maskResolved, resolveConfig } from '../config/index.ts'
import type { AppConfig } from '../config/types.ts'
import { dim, bold, green, red, yellow } from './style.ts'

const KEY_SOURCE_LABEL: Record<string, string> = {
  'command-line': '命令行参数',
  environment: '环境变量',
  'config-plaintext': '配置文件里的明文',
  none: '没有密钥',
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? 'show'
  const store = new ConfigStore()
  const { config, warnings, created } = await store.load()

  if (command === 'path') {
    process.stdout.write(`${store.configPath}\n`)
    return
  }

  if (command === 'show') {
    const resolved = resolveConfig({ config, overrides: {} })
    const masked = maskResolved(resolved)

    process.stdout.write(`${bold('配置文件')}  ${store.configPath}\n`)
    if (created) process.stdout.write(dim('  （首次运行，已生成默认配置）\n'))
    process.stdout.write('\n')

    process.stdout.write(`${bold('模型')}\n`)
    process.stdout.write(`  端点      ${masked.model.baseUrl}\n`)
    process.stdout.write(`  模型      ${masked.model.model}\n`)
    process.stdout.write(`  密钥      ${masked.model.apiKey || dim('（无）')}\n`)
    process.stdout.write(
      `  来源      ${KEY_SOURCE_LABEL[resolved.apiKeySource] ?? resolved.apiKeySource}` +
        // 光说「环境变量」不够：用户要知道**是哪一个**，否则没法排查
        `${resolved.apiKeySourceVar === undefined ? '' : `（${resolved.apiKeySourceVar}）`}\n`,
    )
    if (masked.model.apiKeyIsPlaintext) {
      process.stdout.write(
        yellow('            ⚠ 密钥是明文存在配置文件里的。更稳的做法是写 apiKeyEnv\n'),
      )
    }
    process.stdout.write(
      `  窗口      ${masked.model.contextWindow ?? dim('未声明（启动时探测，探不到用保守默认）')}\n`,
    )
    process.stdout.write(`  usage     ${masked.model.includeUsage ? '请求' : '不请求'}\n`)

    process.stdout.write(`\n${bold('服务')}\n`)
    process.stdout.write(`  端口      ${masked.server.port}\n`)

    process.stdout.write(`\n${bold('权限')}\n`)
    process.stdout.write(`  新会话默认模式  ${masked.permissions.defaultMode}\n`)
    process.stdout.write(dim('  已存在会话的模式由它自己的检查点决定，不在这里改\n'))

    process.stdout.write(`\n${bold('上下文压缩')}\n`)
    process.stdout.write(`  触发线    ${masked.context.triggerRatio * 100}% 的可用预算\n`)
    process.stdout.write(`  输出预留  ${masked.context.outputReserveTokens} token\n`)
    process.stdout.write(`  保留轮次  ${masked.context.keepRecentTurns}\n`)
    process.stdout.write(
      `  工具裁剪  ${masked.context.toolResultThresholdChars} 字符（头 ${masked.context.toolResultHeadChars} / 尾 ${masked.context.toolResultTailChars}）\n`,
    )

    for (const warning of [...warnings, ...resolved.warnings]) {
      process.stdout.write(yellow(`\n  ⚠ ${warning}\n`))
    }
    return
  }

  if (command === 'set' || command === 'unset') {
    const keyPath = argv[1]
    if (keyPath === undefined) {
      process.stderr.write(red(`用法：${command} <字段路径> [值]\n`))
      process.exitCode = 1
      return
    }

    const next = structuredClone(config) as AppConfig & Record<string, unknown>
    const segments = keyPath.split('.')

    if (command === 'unset') {
      const parent = descend(next, segments.slice(0, -1))
      const last = segments[segments.length - 1]
      if (parent !== null && last !== undefined) delete parent[last]
    } else {
      const raw = argv[2]
      if (raw === undefined) {
        process.stderr.write(red(`用法：set ${keyPath} <值>\n`))
        process.exitCode = 1
        return
      }
      const parent = descend(next, segments.slice(0, -1), true)
      const last = segments[segments.length - 1]
      if (parent === null || last === undefined) {
        process.stderr.write(red(`无法识别的字段路径：${keyPath}\n`))
        process.exitCode = 1
        return
      }
      parent[last] = coerce(raw)
    }

    const result = await store.save(next)
    process.stdout.write(green(`已保存 ${keyPath} 到 ${store.configPath}\n`))
    for (const warning of result.warnings) process.stdout.write(yellow(`  ⚠ ${warning}\n`))
    return
  }

  process.stderr.write(red(`未知命令：${command}\n可用：show | path | set | unset\n`))
  process.exitCode = 1
}

function descend(
  root: Record<string, unknown>,
  segments: string[],
  create = false,
): Record<string, unknown> | null {
  let current: Record<string, unknown> = root
  for (const segment of segments) {
    const existing = current[segment]
    if (isRecord(existing)) {
      current = existing
      continue
    }
    if (!create) {
      // 路径不存在时不要凭空造出父对象 —— 否则 unset 会写进一个空壳
      if (existing === undefined) return null
      return null
    }
    const created: Record<string, unknown> = {}
    current[segment] = created
    current = created
  }
  return current
}

/** 尽量把命令行字符串还原成合适的类型。数字/布尔/其他都当字符串 */
function coerce(raw: string): unknown {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  return raw
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

await main()
