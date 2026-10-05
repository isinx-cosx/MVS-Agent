/**
 * 人工调用工具的入口。
 *
 * 这是「先做出来，但先不让 AI 用」的落地方式：工具能力可用、可验证，
 * 但调用者是**你**，不是模型。
 *
 * 用法：
 *   node src/cli/tool.ts list
 *   node src/cli/tool.ts read_file '{"path":"README.md"}'
 *   node src/cli/tool.ts write_file '{"path":"tmp/a.txt","content":"你好"}'
 *   node src/cli/tool.ts run_command '{"command":"node","args":["-v"]}'
 *   node src/cli/tool.ts --root C:\some\dir read_file '{"path":"x.txt"}'
 */

import process from 'node:process'
import { createDefaultRegistry } from '../tools/index.ts'
import { dim, bold, green, red, yellow } from './style.ts'

function printHelp(): void {
  const registry = createDefaultRegistry()
  const lines = [
    `${bold('MVS Agent · 工具层（人工调用）')}`,
    '',
    '用法：node src/cli/tool.ts [--root <目录>] <工具名> [参数 JSON]',
    '      <参数 JSON> 写成 - 表示从 stdin 读取（PowerShell 下更可靠）',
    '      node src/cli/tool.ts list',
    '',
    bold('可用工具：'),
  ]
  for (const tool of registry.list()) {
    lines.push(`  ${bold(tool.name)} ${dim(`[${tool.risk}]`)}`)
    lines.push(`      ${tool.description}`)
    lines.push(`      ${dim(JSON.stringify(tool.parameters))}`)
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  let root = process.cwd()
  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      printHelp()
      return
    }
    if (arg === '--root') {
      const value = argv[i + 1]
      if (value === undefined) {
        process.stderr.write(red('--root 缺少参数值\n'))
        process.exitCode = 1
        return
      }
      root = value
      i += 1
      continue
    }
    positional.push(arg)
  }

  const [name, rawArgs] = positional

  if (name === undefined || name === 'list') {
    printHelp()
    return
  }

  let parsedArgs: unknown = {}
  if (rawArgs === '-') {
    // 从 stdin 读参数。PowerShell 在把参数传给原生程序时会吞掉双引号，
    // 管道是唯一跨 shell 都可靠的方式。
    try {
      parsedArgs = JSON.parse(await readStdin())
    } catch (err) {
      process.stderr.write(red(`stdin 里的参数不是合法 JSON：${(err as Error).message}\n`))
      process.exitCode = 1
      return
    }
  } else if (rawArgs !== undefined) {
    try {
      parsedArgs = JSON.parse(rawArgs)
    } catch (err) {
      process.stderr.write(red(`参数不是合法 JSON：${(err as Error).message}\n`))
      process.stderr.write(
        dim('提示：PowerShell 会吞掉参数里的双引号。改用管道最稳：\n') ,
      )
      process.stderr.write(
        dim(`  '{"path":"a.txt"}' | node src/cli/tool.ts ${name} -\n`),
      )
      process.exitCode = 1
      return
    }
  }

  const registry = createDefaultRegistry()
  process.stdout.write(dim(`工具 ${name} · 工作区 ${root}\n\n`))

  const result = await registry.execute(name, parsedArgs, { root })

  const status = result.ok ? green('✔ 成功') : red(`✘ 失败 (${result.error?.kind})`)
  process.stdout.write(`${status}\n`)
  if (!result.ok && result.error) {
    process.stdout.write(yellow(`${result.error.message}\n`))
  }
  // failResult 默认把 message 同时当 content，避免这里重复打印一遍
  if (result.content !== result.error?.message) {
    process.stdout.write(`${result.content}\n`)
  }
  if (result.data !== undefined) {
    process.stdout.write(dim(`\ndata: ${JSON.stringify(result.data, null, 2)}\n`))
  }

  if (!result.ok) process.exitCode = 1
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  // PowerShell 往管道里写 UTF-8 时会带上 BOM，JSON.parse 会因此失败。
  // BOM 还会从各种编辑器/重定向里冒出来，所以统一剥掉。
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
}

await main()
