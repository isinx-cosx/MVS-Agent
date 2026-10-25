/**
 * 插件的命令行入口。
 *
 * 和 `skills.ts` 同一个理由：确认 / 停用 / 扫描原来只有 HTTP 命令一条路，
 * 而那条路要令牌、要拼 JSON。插件比技能还多一层 —— **确认的是清单的哈希**，
 * 所以「我看过这份清单了」这个动作必须在人能看见清单摘要的地方做得出来。
 *
 * 用法：
 *
 *     node src/cli/plugins.ts list             [--workspace <dir>]
 *     node src/cli/plugins.ts show <name>      [--workspace <dir>]   （清单摘要）
 *     node src/cli/plugins.ts approve <name>   [--workspace <dir>]
 *     node src/cli/plugins.ts enable  <name>   [--workspace <dir>]
 *     node src/cli/plugins.ts disable <name>   [--workspace <dir>]
 */

import path from 'node:path'
import process from 'node:process'
import { defaultHomeDir } from '../config/index.ts'
import { PluginLibrary, pluginsDir } from '../plugins/index.ts'

const USAGE = `用法：
  node src/cli/plugins.ts list             [--workspace <dir>]
  node src/cli/plugins.ts show <name>      [--workspace <dir>]
  node src/cli/plugins.ts approve <name>   [--workspace <dir>]
  node src/cli/plugins.ts enable  <name>   [--workspace <dir>]
  node src/cli/plugins.ts disable <name>   [--workspace <dir>]

装是**全局**的（<MVS_HOME>/plugins）；启用是**按工作区**的。
`

function parseArgs(argv: string[]): { command: string; name?: string; workspace: string } {
  let workspace = process.cwd()
  let command = 'list'
  let name: string | undefined

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--workspace') {
      i += 1
      workspace = argv[i] ?? workspace
      continue
    }
    if (arg.startsWith('--workspace=')) {
      workspace = arg.slice('--workspace='.length)
      continue
    }
    if (arg.startsWith('-')) continue
    if (command === 'list' && name === undefined) {
      command = arg
    } else if (name === undefined) {
      name = arg
    }
  }

  return { command, ...(name === undefined ? {} : { name }), workspace }
}

const STATUS_LABEL: Record<string, string> = {
  enabled: '已启用',
  pending: '待确认',
  disabled: '已停用',
  broken: '坏了',
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const workspace = path.resolve(args.workspace)
  const library = await PluginLibrary.open(workspace)
  const summaries = library.summaries()

  const fail = (message: string): void => {
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }

  if (args.command === 'list') {
    if (summaries.length === 0) {
      process.stdout.write('这个工作区里没有插件。\n')
      process.stdout.write(`把它们放在 ${pluginsDir(defaultHomeDir())}/<名字>/plugin.json\n`)
      return
    }
    process.stdout.write(`${summaries.length} 个插件（工作区 ${workspace}）：\n\n`)
    for (const plugin of summaries) {
      process.stdout.write(
        `  ${plugin.name}  ${plugin.version}  ${STATUS_LABEL[plugin.status] ?? plugin.status}  ${plugin.toolNames.length} 个工具\n`,
      )
      if (plugin.message !== undefined) process.stdout.write(`    ${plugin.message}\n`)
      for (const name of plugin.toolNames) {
        process.stdout.write(`    · ${name}\n`)
      }
    }
    return
  }

  if (args.name === undefined) {
    process.stderr.write(USAGE)
    process.exitCode = 2
    return
  }

  const target = summaries.find((plugin) => plugin.name === args.name)

  if (args.command === 'show') {
    if (target === undefined) return fail(`没有这个插件：${args.name}`)
    process.stdout.write(`${target.name}\n`)
    process.stdout.write(`  状态   ${STATUS_LABEL[target.status] ?? target.status}\n`)
    process.stdout.write(`  版本   ${target.version}\n`)
    process.stdout.write(`  说明   ${target.description}\n`)
    process.stdout.write(`  路径   ${target.path}\n`)
    /* 工具名是 `plugin__tool` 的完整形式 —— 那正是模型看到的那个名字 */
    for (const name of target.toolNames) {
      process.stdout.write(`  工具   ${name}\n`)
    }
    if (target.message !== undefined) process.stdout.write(`  提示   ${target.message}\n`)
    return
  }

  if (args.command === 'approve') {
    const result = await library.approve(args.name)
    if (!result.ok) return fail(result.message)
    process.stdout.write(`已确认：${args.name}（清单哈希已记下，内容变了要重新确认）\n`)
    return
  }

  if (args.command === 'enable' || args.command === 'disable') {
    const result = await library.setEnabled(args.name, args.command === 'enable')
    if (!result.ok) return fail(result.message)
    process.stdout.write(`${args.command === 'enable' ? '已启用' : '已停用'}：${args.name}\n`)
    return
  }

  process.stderr.write(`未知子命令：${args.command}\n\n${USAGE}`)
  process.exitCode = 2
}

await main()
