/**
 * 上下文压缩演示。
 *
 * 造一段真实的「长对话 + 大工具结果」，看压缩前后发生了什么。
 *
 * 运行：node scripts/demo-compaction.ts
 */

import process from 'node:process'
import { compact, COMPACTION_MARKER, estimateConversationTokens } from '../src/context/index.ts'
import { DEFAULT_COMPACTION, triggerThreshold, usableBudget } from '../src/context/types.ts'
import type { Message } from '../src/model/types.ts'

const say = (text: string): void => process.stdout.write(`${text}\n`)
const rule = (): void => say('─'.repeat(70))
const bold = (t: string): string => `\u001b[1m${t}\u001b[0m`
const dim = (t: string): string => `\u001b[2m${t}\u001b[0m`

const options = {
  ...DEFAULT_COMPACTION,
  windowTokens: 6_000,
  outputReserveTokens: 0,
  triggerRatio: 0.9,
  keepRecentTurns: 3,
}

rule()
say(bold('上下文压缩演示'))
say(
  `  窗口 ${options.windowTokens} · 可用预算 ${usableBudget(options)}` +
    ` · 触发线 ${triggerThreshold(options)}（${options.triggerRatio * 100}%）· 保留最近 ${options.keepRecentTurns} 轮`,
)
say(
  dim(
    `  工具结果裁剪阈值 ${options.toolResultThresholdChars} 字符（保留头 ${options.toolResultHeadChars} / 尾 ${options.toolResultTailChars}）`,
  ),
)
say(dim('  这三个数字取自本机运行的 DSH 的 compaction-tool-result-pruner 配置'))
say(dim('  窗口刻意取小，好让这段演示里真的触发压缩'))

// ── 造一段长对话 ────────────────────────────────────────────────────────────
const messages: Message[] = [{ role: 'system', content: '你是 MVS Agent。' }]

for (let i = 1; i <= 10; i += 1) {
  messages.push({ role: 'user', content: `第 ${i} 轮：看看构建输出` })
  messages.push({
    role: 'assistant',
    content: '',
    toolCalls: [{ id: `call_${i}`, name: 'run_command', argsJson: `{"command":"npm run build"}` }],
  })
  messages.push({
    role: 'tool',
    content:
      `第 ${i} 次构建输出开始\n` +
      'npm warn deprecated inflight@1.0.6: This module is not supported\n'.repeat(400) +
      `第 ${i} 次构建输出结束：成功`,
    toolCallId: `call_${i}`,
  })
  messages.push({ role: 'assistant', content: `第 ${i} 轮：构建成功。` })
}

rule()
say(bold('压缩前'))
const before = estimateConversationTokens(messages)
say(`  消息数      ${messages.length}`)
say(`  估算 token  ${before}`)
const biggest = messages.reduce((max, m) => Math.max(max, m.content.length), 0)
say(`  最长一条    ${biggest} 字符${dim('（就是一个工具结果）')}`)

// ── 压缩 ────────────────────────────────────────────────────────────────────
const result = compact(messages, options)

rule()
say(bold('压缩做了什么'))
for (const action of result.actions) {
  if (action.kind === 'prune-tool-result') {
    say(
      `  裁剪工具结果  ${action.toolCallId}：${action.originalChars} → ${action.keptChars} 字符` +
        dim(`（省下 ${action.originalChars - action.keptChars}）`),
    )
  } else {
    say(`  丢弃轮次      丢掉最早 ${action.droppedTurns} 轮，共 ${action.droppedMessages} 条消息`)
  }
}

rule()
say(bold('压缩后'))
say(`  消息数      ${result.messages.length}`)
say(`  估算 token  ${result.tokensAfter}${dim(`（省下 ${result.tokensBefore - result.tokensAfter}）`)}`)

// ── 不变量检查 ──────────────────────────────────────────────────────────────
rule()
say(bold('压缩没有破坏什么'))

const system = result.messages[0]
say(`  系统提示原样保留  ${system?.role === 'system' && system.content === '你是 MVS Agent。' ? '✔' : '✗'}`)

const callIds = new Set<string>()
const resultIds = new Set<string>()
for (const message of result.messages) {
  if (message.role === 'assistant' && message.toolCalls !== undefined) {
    for (const call of message.toolCalls) callIds.add(call.id)
  }
  if (message.role === 'tool') resultIds.add(message.toolCallId)
}
say(
  `  工具调用与结果成对  ${
    JSON.stringify([...callIds].sort()) === JSON.stringify([...resultIds].sort()) ? '✔' : '✗'
  }${dim(`  （${callIds.size} 对）`)}`,
)

const markers = result.messages.filter(
  (m) => m.role === 'system' && m.content.startsWith(COMPACTION_MARKER),
)
say(`  压缩标记只有一条    ${markers.length === 1 ? '✔' : `✗（${markers.length} 条）`}`)

const users = result.messages.filter((m) => m.role === 'user')
say(`  保留了最近 ${options.keepRecentTurns} 轮  ${users.length === options.keepRecentTurns ? '✔' : `✗（${users.length}）`}`)

rule()
say(bold('模型看到的省略说明'))
const marker = markers[0]
if (marker !== undefined) for (const line of marker.content.split('\n')) say(`  ${line}`)

rule()
say(bold('被裁掉的工具结果，模型看到的是这个'))
const pruned = result.messages.find((m) => m.role === 'tool' && m.content.includes('已裁剪'))
if (pruned !== undefined) {
  const lines = pruned.content.split('\n')
  say(`  ${lines[0]?.slice(0, 60)}…`)
  say(`  ${lines[1] ?? ''}`)
  say(`  …${lines[lines.length - 1]?.slice(-40)}`)
}

rule()
say(dim('  原文仍完整保存在 events.jsonl 的 tool_settled.content 里 ——'))
say(dim('  压缩是有损的，但**不是不可逆的**。需要细节时重新读取比依赖记忆更可靠。'))
