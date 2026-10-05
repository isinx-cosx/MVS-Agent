/**
 * 流式 REPL。
 *
 * 这个文件是「流式是原语」的证明：它直接消费 stream()，边到边渲染，
 * **不走 collect()**。collect 只服务那些真的需要完整结果的场景。
 *
 * 用法：
 *   node src/cli/chat.ts --profile ollama
 *   node src/cli/chat.ts --profile deepseek "用一句话解释什么是事件溯源"
 */

import process from 'node:process'
import readline from 'node:readline'
import { OpenAICompatibleClient } from '../model/openai-compatible.ts'
import type {
  FinishReason,
  Message,
  ModelClient,
  ModelError,
  Notice,
  ToolSchema,
  Usage,
} from '../model/types.ts'
import {
  ConfigStore,
  PROFILES,
  resolveConfig as resolveStoredConfig,
  type ConfigOverrides,
  type ResolvedConfig,
} from '../config/index.ts'
import { dim, bold, red, cyan } from './style.ts'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/*
 * ⚠️ 这里原来有一份**自己的** `PROFILES`（只有 `ollama` 和 `deepseek` 两个）
 * 和一份自己的 `resolveConfig`，而后者**完全不读配置文件**。
 *
 * 后果很具体，而且看起来像别的问题：
 *
 *   守护进程（`serve`）老实读 `~/.mvs-agent/config.json`，所以在界面上把模型
 *   配成 DeepSeek 之后一切正常。而同一份配置对 `npm run chat` **完全无效** ——
 *   它永远连 Ollama 的 `127.0.0.1:11434`，报一句 `fetch failed`。
 *   那句话看起来像"Ollama 没启动"，真相是它**压根没看你配的那个供应商**。
 *
 * 两套解析器就是两个答案，而其中一个必然是错的。现在只剩一套：
 * `src/config/resolve.ts`。连预设也只有那一处（原来这份还少了 `llama`/`fake`）。
 *
 * 优先级也照那一层的契约：命令行 > 环境变量 > 配置文件 > profile 预设。
 * 比原来手写的那份**多了一层配置文件** —— 这正是它坏掉的原因。
 */

interface CliOptions {
  profile?: string
  baseUrl?: string
  model?: string
  apiKey?: string
  system?: string
  prompt?: string
  /**
   * 输出上限（token）——**默认不设，一个上限都不加**。
   *
   * 不传这个参数时，请求体里**不会出现 `max_tokens`**，模型想到哪就到哪；
   * 这是刻意的：要观察它真实的思考长度、什么时候自己停，就不能先给它套个圈。
   *
   * ⚠️ 代价你要知道：本地模型在"用一句话解释"这种提示上会**打转**（反复自我纠正、
   * 给自己写备注），没有上限时会一路生成下去 —— 实测见过一次吐到 10 万 token
   * 还没停，把推理进程唯一的槽位占死，谁都发不出消息。所以这个参数是**留给你的
   * 刹车**，需要时自己踩，不要默认踩。
   */
  maxTokens?: number
  /** 采样温度。调低常常能让"打转"缓和一些，值得你自己对比 */
  temperature?: number
  help: boolean
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = (): string => {
      i += 1
      const next = argv[i]
      if (next === undefined) throw new Error(`${arg} 缺少参数值`)
      return next
    }

    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '--profile':
        options.profile = value()
        break
      case '--base-url':
        options.baseUrl = value()
        break
      case '--model':
        options.model = value()
        break
      case '--api-key':
        options.apiKey = value()
        break
      case '-s':
      case '--system':
        options.system = value()
        break
      case '--max-tokens': {
        const raw = value()
        const parsed = Number.parseInt(raw, 10)
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new Error(`--max-tokens 需要一个正整数，收到：${raw}`)
        }
        options.maxTokens = parsed
        break
      }
      case '--temperature': {
        const raw = value()
        const parsed = Number.parseFloat(raw)
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
          throw new Error(`--temperature 需要在 0 到 2 之间，收到：${raw}`)
        }
        options.temperature = parsed
        break
      }
      default:
        if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`)
        positional.push(arg)
    }
  }

  if (positional.length > 0) options.prompt = positional.join(' ')
  return options
}

type ResolveResult =
  | { ok: true; config: ResolvedConfig }
  | { ok: false; error: string }

/**
 * CLI 的配置解析 —— **委托给配置层，不再自己算一遍**（原因见文件上方那段）。
 *
 * 它只做一件事：把命令行参数翻译成 `ConfigOverrides`。至于「配置文件里写了
 * 什么、有没有供应商覆盖掉它、环境变量有没有插一嘴」，全部由
 * `src/config/resolve.ts` 决定 —— 和守护进程走的是**同一个函数**，
 * 所以两边的答案不可能再不一样。
 */
async function resolveConfig(options: CliOptions): Promise<ResolveResult> {
  const overrides: ConfigOverrides = {}
  if (options.profile !== undefined) overrides.profile = options.profile
  if (options.baseUrl !== undefined) overrides.baseUrl = options.baseUrl
  if (options.model !== undefined) overrides.model = options.model
  if (options.apiKey !== undefined) overrides.apiKey = options.apiKey

  const loaded = await new ConfigStore().load()
  /*
   * `loaded.warnings` 刻意**不在这里打印**：那些话（「哪个字段被忽略了、
   * 为什么」）在设置面板里比在这个 REPL 的启动横幅里有用得多。
   * 但也不该让它们凭空消失 —— 留给以后一个 `--verbose` 出口。
   */
  return {
    ok: true,
    config: resolveStoredConfig({ config: loaded.config, overrides, env: process.env }),
  }
}

function printHelp(): void {
  process.stdout.write(`${bold('MVS Agent · v0 模型层')}

用法：
  node src/cli/chat.ts [选项] [一次性提问]

选项：
  --profile <名字>    预设端点：${Object.keys(PROFILES).join(' | ')}
  --base-url <URL>    OpenAI 兼容端点，例：https://api.deepseek.com/v1
  --model <名字>      模型名
  --api-key <key>     API Key
  --max-tokens <n>    输出上限（不传则**没有上限**，本地模型打转时会一路生成）
  --temperature <t>   采样温度（0~2）
  -s, --system <文本> 系统提示词
  -h, --help          显示帮助

环境变量（优先级低于命令行）：
  MVS_PROFILE  MVS_BASE_URL  MVS_MODEL  MVS_API_KEY  DEEPSEEK_API_KEY

示例：
  node src/cli/chat.ts --profile ollama
  node src/cli/chat.ts --profile deepseek "用一句话解释事件溯源"
  node src/cli/chat.ts --max-tokens 512 "用一句话解释什么是编译器"
`)
}

// ---------------------------------------------------------------------------
// 一轮对话
// ---------------------------------------------------------------------------

interface TurnResult {
  text: string
  aborted: boolean
  error?: ModelError
}

/** 一块到达的记账。**到达时刻在这里取**，不靠下游推算 */
function noteChunk(stats: TurnStats): void {
  const now = Date.now()
  if (stats.firstDeltaAt === undefined) stats.firstDeltaAt = now
  if (stats.lastAt !== undefined) stats.gaps.push(now - stats.lastAt)
  stats.lastAt = now
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function printTurnStats(stats: TurnStats, startedAt: number): void {
  if (stats.reasoningChunks + stats.textChunks === 0) return
  const first = stats.firstDeltaAt === undefined ? 0 : stats.firstDeltaAt - startedAt
  const gapRange =
    stats.gaps.length === 0 ? '无' : `${Math.min(...stats.gaps)}~${Math.max(...stats.gaps)}`
  process.stdout.write(
    dim(
      `[统计 思考 ${stats.reasoningChunks} 块/${stats.reasoningChars} 字 · ` +
        `正文 ${stats.textChunks} 块/${stats.textChars} 字 · ` +
        `首块 ${first}ms · 块间隔 中位 ${median(stats.gaps)}ms（${gapRange}）]\n`,
    ),
  )
}

/** 一轮的请求参数。只带「这次调用怎么发」，不带任何界面状态 */
interface TurnOptions {
  maxTokens?: number
  temperature?: number
}

/** 一轮里逐块累计的观测值（自己测的时候看的就是这几个数） */
interface TurnStats {
  reasoningChunks: number
  reasoningChars: number
  textChunks: number
  textChars: number
  /** 第一块到达的时刻（毫秒时间戳）。首块延迟 = 它减去回合开始 */
  firstDeltaAt: number | undefined
  /** 相邻块到达间隔。**观感由它决定**，字数统计看不出来 */
  gaps: number[]
  lastAt: number | undefined
}

async function runTurn(
  client: ModelClient,
  model: string,
  messages: Message[],
  tools: ToolSchema[] | undefined,
  signal: AbortSignal,
  options: TurnOptions = {},
): Promise<TurnResult> {
  const startedAt = Date.now()
  const notices: Notice[] = []

  let text = ''
  let usage: Usage | undefined
  let finish: FinishReason = 'unknown'
  let error: ModelError | undefined

  let reasoningStarted = false
  let answerStarted = false
  let toolCallNoticed = false

  /*
   * 逐块统计 —— 这是「自己测」时要看的那几个数。
   *
   * 为什么要记「块」而不只记「字」：上游是按 token 切的，块的长短和到达间隔
   * 决定观感。中位间隔 40ms 左右是流畅的物理基线；如果某一层把它做成几百毫秒，
   * 界面上就会显得一顿一顿，而字数统计**完全看不出来**。
   */
  const stats: TurnStats = {
    reasoningChunks: 0,
    reasoningChars: 0,
    textChunks: 0,
    textChars: 0,
    firstDeltaAt: undefined as number | undefined,
    gaps: [] as number[],
    lastAt: undefined as number | undefined,
  }

  for await (const event of client.stream({
    model,
    messages,
    tools,
    signal,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  })) {
    switch (event.type) {
      case 'reasoning_delta':
        if (!reasoningStarted) {
          process.stdout.write(`\n${dim('思考中… ')}`)
          reasoningStarted = true
        }
        noteChunk(stats)
        stats.reasoningChunks += 1
        stats.reasoningChars += event.text.length
        process.stdout.write(dim(event.text))
        break

      case 'text_delta':
        if (!answerStarted) {
          process.stdout.write(reasoningStarted ? '\n\n' : '\n')
          process.stdout.write(bold('助手 › '))
          answerStarted = true
        }
        noteChunk(stats)
        stats.textChunks += 1
        stats.textChars += event.text.length
        process.stdout.write(event.text)
        text += event.text
        break

      case 'tool_call_delta':
        if (!toolCallNoticed) {
          notices.push({
            code: 'tool_calls_ignored',
            message: '模型请求调用工具，但 v0 还没有工具循环，本次已忽略',
          })
          toolCallNoticed = true
        }
        break

      case 'usage':
        usage = event.usage
        break

      case 'notice':
        notices.push(event.notice)
        break

      case 'done':
        finish = event.reason
        break

      case 'error':
        error = event.error
        break
    }
  }

  if (!answerStarted && !reasoningStarted && !error) {
    process.stdout.write(dim('\n（模型没有返回任何内容）'))
  }
  process.stdout.write('\n')

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  if (error) {
    process.stdout.write(red(`[错误/${error.kind}] ${error.message}\n`))
  } else {
    const tokens = usage
      ? `${usage.inputTokens} → ${usage.outputTokens} tok`
      : 'usage 不可用'
    process.stdout.write(dim(`[${elapsed}s · ${tokens} · ${finish}]\n`))
  }
  /*
   * 实测过的一种情况：预算被**思考吃满**，正文一块都不会出现。
   * 那时 finish 是 `length` —— 把它说出来，别让人以为是模型不会回答。
   */
  printTurnStats(stats, startedAt)
  if (finish === 'length') {
    process.stdout.write(dim('（达到上限被截断：若思考吃满预算，正文一块都不会出现）\n'))
  }

  for (const notice of notices) {
    process.stdout.write(dim(`[提示 ${notice.code}] ${notice.message}\n`))
  }

  return { text, aborted: finish === 'aborted' || signal.aborted, error }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let options: CliOptions
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(red(`${(err as Error).message}\n`))
    process.exitCode = 1
    return
  }

  if (options.help) {
    printHelp()
    return
  }

  const resolved = await resolveConfig(options)
  if (!resolved.ok) {
    process.stderr.write(red(`${resolved.error}\n`))
    process.exitCode = 1
    return
  }

  const { baseUrl, model, apiKey, includeUsage, profileName } = resolved.config
  const client = new OpenAICompatibleClient({ baseUrl, model, apiKey, includeUsage })

  process.stdout.write(
    dim(`MVS Agent · ${profileName} · ${model}\n${baseUrl}${apiKey ? ' · 已带 key' : ' · 无 key'}\n`),
  )

  const messages: Message[] = []
  if (options.system) messages.push({ role: 'system', content: options.system })

  // 一次性模式：给了提问就直接跑一轮退出
  if (options.prompt) {
    messages.push({ role: 'user', content: options.prompt })
    const controller = new AbortController()
    process.on('SIGINT', () => controller.abort())
    await runTurn(client, model, messages, undefined, controller.signal, {
      maxTokens: options.maxTokens,
      temperature: options.temperature,
    })
    return
  }

  // REPL 模式
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  })

  let activeAbort: AbortController | null = null
  let interruptArmed = false

  const onInterrupt = (): void => {
    if (activeAbort) {
      // 正在生成：取消这一轮
      activeAbort.abort()
      return
    }
    if (interruptArmed) {
      rl.close()
      return
    }
    interruptArmed = true
    process.stdout.write(dim('\n（再按一次 Ctrl+C 退出）\n'))
  }

  rl.on('SIGINT', onInterrupt)
  // 非 TTY（管道输入）时 readline 不接管信号，靠这条兜底
  process.on('SIGINT', onInterrupt)

  let closed = false
  rl.on('close', () => {
    closed = true
  })

  process.stdout.write(dim('输入内容开始对话，/exit 退出\n'))

  while (!closed) {
    const line = await ask(rl, cyan('\n你 › '))
    if (line === null) break

    const input = line.trim()
    if (input === '') continue
    if (input === '/exit' || input === '/quit') break

    messages.push({ role: 'user', content: input })

    const controller = new AbortController()
    activeAbort = controller
    const result = await runTurn(client, model, messages, undefined, controller.signal)
    activeAbort = null
    interruptArmed = false

    if (result.aborted) {
      // 取消 = 这一轮没发生过。半截的助手回复留在历史里只会污染后续上下文。
      messages.pop()
      process.stdout.write(dim('[已取消，本轮未计入历史]\n'))
      continue
    }

    messages.push({ role: 'assistant', content: result.text })
  }

  rl.close()
}

/** 包一层：接口关闭时返回 null，而不是让 promise 悬挂或抛出 */
function ask(rl: readline.Interface, query: string): Promise<string | null> {
  return new Promise((resolve) => {
    const onClose = (): void => resolve(null)
    rl.once('close', onClose)
    try {
      rl.question(query, (answer) => {
        rl.removeListener('close', onClose)
        resolve(answer)
      })
    } catch {
      // stdin 已经 EOF 时 readline 已关闭，再 question 会抛 ERR_USE_AFTER_CLOSE。
      // 这不是异常情况（比如管道输入跑完），当作「没有更多输入」处理。
      rl.removeListener('close', onClose)
      resolve(null)
    }
  })
}

await main()
