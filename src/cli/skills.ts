/**
 * 技能的命令行入口。
 *
 * ## 为什么需要它
 *
 * 技能的确认 / 停用 / 启用**只有 HTTP 命令一条路**（`approve_skill` /
 * `set_skill_enabled`），而 HTTP 那条路要令牌、要拼 JSON、还要先知道
 * 会话 id。于是在终端里想确认一份刚写的技能，得：
 *
 *     curl -X POST -H "Authorization: Bearer $(cat ~/.mvs-agent/host-token)" \
 *          -H 'content-type: application/json' -d '{"type":"approve_skill",...}' \
 *          http://127.0.0.1:3080/command
 *
 * 这不是「能用」，这是「只有作者能用」。
 *
 * ## 用法
 *
 *     node src/cli/skills.ts list                [--workspace <dir>]
 *     node src/cli/skills.ts approve <name>      [--workspace <dir>]
 *     node src/cli/skills.ts enable  <name>      [--workspace <dir>]
 *     node src/cli/skills.ts disable <name>      [--workspace <dir>]
 *
 * `--workspace` 缺省是当前目录 —— 技能是**按工作区**落的（`.mvs/skills`），
 * 和 `npm run serve` 在哪个目录起是一个道理。
 */

import path from 'node:path'
import process from 'node:process'
import { SkillLibrary } from '../skills/index.ts'

const USAGE = `用法：
  node src/cli/skills.ts list                [--workspace <dir>]
  node src/cli/skills.ts approve <name>      [--workspace <dir>]
  node src/cli/skills.ts enable  <name>      [--workspace <dir>]
  node src/cli/skills.ts disable <name>      [--workspace <dir>]

技能是**按工作区**的：同一份 .mvs/skills 在这个目录里确认过，才算确认过。
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
  approved: '已确认',
  pending: '待确认',
  disabled: '已停用',
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const workspace = path.resolve(args.workspace)
  const library = await SkillLibrary.open(workspace)
  const view = library.view()

  const fail = (message: string): void => {
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  }

  if (args.command === 'list') {
    if (view.skills.length === 0) {
      process.stdout.write(`这个工作区里没有技能。\n`)
      process.stdout.write(`把它们放在 ${path.join(workspace, '.mvs', 'skills')}/<名字>/SKILL.md\n`)
    } else {
      process.stdout.write(`${view.skills.length} 个技能（工作区 ${workspace}）：\n\n`)
      for (const skill of view.skills) {
        const status = !skill.enabled ? 'disabled' : skill.approved ? 'approved' : 'pending'
        const reason =
          status === 'pending'
            ? (view.problems.find((problem) => problem.name === skill.name)?.message ??
              '尚未确认（第一次发现）')
            : ''
        process.stdout.write(`  ${skill.name}  [${skill.category}]  ${STATUS_LABEL[status] ?? status}\n`)
        process.stdout.write(`    ${skill.description}\n`)
        process.stdout.write(`    ${skill.path}${reason === '' ? '' : `  ← ${reason}`}\n`)
      }
      const pending = view.skills.filter((skill) => skill.enabled && !skill.approved)
      if (pending.length > 0) {
        process.stdout.write(`\n要确认：node src/cli/skills.ts approve <名字>\n`)
      }
    }
    /* 没有名字的 problem 也要说 —— 坏掉的文件不能静默消失 */
    for (const problem of view.problems) {
      if (problem.name === null) process.stdout.write(`\n⚠ ${problem.message}\n`)
    }
    return
  }

  if (args.name === undefined) {
    process.stderr.write(USAGE)
    process.exitCode = 2
    return
  }

  if (args.command === 'approve') {
    const result = await library.approve(args.name)
    if (!result.ok) return fail(result.message)
    process.stdout.write(`已确认：${args.name}\n`)
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
