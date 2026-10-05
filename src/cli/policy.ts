/**
 * 权限层的人工调用入口。
 *
 * 和工具层、恢复层同样的边界：**模型拿不到它。**
 *
 * 用法：
 *   node src/cli/policy.ts modes
 *   node src/cli/policy.ts rules
 *   node src/cli/policy.ts check --mode workspace-write write_file '{"path":"a.txt","content":"x"}'
 *   node src/cli/policy.ts check --mode workspace-write run_command '{"command":"rm -rf /"}'
 *   node src/cli/policy.ts check --mode full-access run_command '{"command":"git push"}'
 *   node src/cli/policy.ts check --mode workspace-write --headless run_command '{"command":"npm test"}'
 */

import process from 'node:process'
import { describeMode, Policy } from '../policy/index.ts'
import { MODES } from '../policy/types.ts'
import type { Decision, PermissionMode } from '../policy/types.ts'
import { createDefaultRegistry } from '../tools/index.ts'
import { dim, bold, green, red, yellow } from './style.ts'

const MODE_NAMES: PermissionMode[] = ['read-only', 'workspace-write', 'full-access']

interface Options {
  command: string
  mode: PermissionMode
  root: string
  headless: boolean
  tool?: string
  argsJson?: string
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    command: 'modes',
    mode: 'workspace-write',
    root: process.cwd(),
    headless: false,
  }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--mode') {
      const value = argv[++i]
      if (value !== undefined && (MODE_NAMES as string[]).includes(value)) {
        options.mode = value as PermissionMode
      }
      continue
    }
    if (arg === '--root') {
      options.root = argv[++i] ?? options.root
      continue
    }
    if (arg === '--headless') {
      options.headless = true
      continue
    }
    positional.push(arg)
  }

  options.command = positional[0] ?? 'modes'
  options.tool = positional[1]
  options.argsJson = positional[2]
  return options
}

function paintDecision(decision: Decision): string {
  if (decision === 'allow') return green('allow')
  if (decision === 'deny') return red('deny')
  return yellow('ask')
}

/** PowerShell 会吞掉参数里的双引号，管道是唯一跨 shell 都可靠的方式 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  // PowerShell 往管道里写 UTF-8 时会带 BOM
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))

  if (options.command === 'modes') {
    process.stdout.write(`${bold('权限模式')}\n\n`)
    for (const name of MODE_NAMES) {
      process.stdout.write(`  ${bold(name)}\n    ${describeMode(name)}\n`)
    }
    process.stdout.write(
      dim(
        '\n  命令执行刻意只有两档：调研结论是「执行大部分命令」在技术上不可定义，\n' +
          '  中间那一档不存在。所以要么不允许，要么允许。\n',
      ),
    )
    return
  }

  const policy = new Policy({ mode: options.mode, interactive: !options.headless })

  if (options.command === 'rules') {
    process.stdout.write(`${bold('已加载的规则')}（deny > ask > allow，具体程度不改变顺序）\n\n`)
    for (const rule of policy.rules()) {
      const color =
        rule.decision === 'deny' ? red : rule.decision === 'ask' ? yellow : green
      process.stdout.write(
        `  ${color(rule.decision.padEnd(5, ' '))} ${rule.pattern}${
          rule.note !== undefined ? dim(`  # ${rule.note}`) : ''
        }\n`,
      )
    }
    process.stdout.write(
      dim(
        '\n  默认允许列表是**空的** —— Cursor 官方示例里的 `npm` 一条就覆盖了\n' +
          '  `npm install`、`npm publish` 和所有 postinstall 脚本。\n',
      ),
    )
    return
  }

  if (options.command === 'check') {
    if (options.tool === undefined) {
      process.stderr.write(red('用法：check <工具名> [参数 JSON]\n'))
      process.exitCode = 1
      return
    }

    const registry = createDefaultRegistry()
    const tool = registry.get(options.tool)
    if (tool === undefined) {
      process.stderr.write(red(`没有名为 ${options.tool} 的工具\n`))
      process.exitCode = 1
      return
    }

    let args: unknown = {}
    if (options.argsJson === '-') {
      try {
        args = JSON.parse(await readStdin())
      } catch (err) {
        process.stderr.write(red(`stdin 里的参数不是合法 JSON：${(err as Error).message}\n`))
        process.exitCode = 1
        return
      }
    } else if (options.argsJson !== undefined) {
      try {
        args = JSON.parse(options.argsJson)
      } catch (err) {
        process.stderr.write(red(`参数不是合法 JSON：${(err as Error).message}\n`))
        process.stderr.write(dim('提示：PowerShell 会吞掉参数里的双引号。改用管道最稳：\n'))
        process.stderr.write(
          dim(`  '{"path":"a.txt"}' | node src/cli/policy.ts check --mode ... ${options.tool} -\n`),
        )
        process.exitCode = 1
        return
      }
    }

    const verdict = policy.evaluate(
      { tool: tool.name, risk: tool.risk, args },
      { root: options.root, interactive: !options.headless },
    )

    process.stdout.write(`${bold('判定')}  ${paintDecision(verdict.decision)}\n`)
    process.stdout.write(`  原因      ${verdict.reason}\n`)
    process.stdout.write(`  说明      ${verdict.message}\n`)
    if (verdict.rule !== undefined) process.stdout.write(`  命中规则  ${verdict.rule}\n`)
    if (verdict.breakerDetail !== undefined) {
      process.stdout.write(`  熔断对象  ${verdict.breakerDetail}\n`)
    }
    if (verdict.allowSuppressed === true) {
      process.stdout.write(yellow('  ⚠ 熔断器剥夺了 allow 规则的批准权\n'))
    }
    if (verdict.downgradedFromAsk === true) {
      process.stdout.write(yellow('  ⚠ 无人可应答，已按拒绝处理\n'))
    }
    return
  }

  if (options.command === 'modes-info') {
    for (const name of MODE_NAMES) {
      process.stdout.write(`${name}: ${JSON.stringify(MODES[name])}\n`)
    }
    return
  }

  process.stderr.write(red(`未知命令：${options.command}\n可用：modes | rules | check\n`))
  process.exitCode = 1
}

await main()
