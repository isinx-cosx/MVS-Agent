/**
 * 全栈端到端演示：模型 → 策略 → 工具 → 恢复 → 会话/事件/检查点。
 *
 * 需要假端点先跑起来：
 *   终端 1：node scripts/fake-server.ts
 *   终端 2：node scripts/demo-session.ts
 *
 * 这个脚本走的是**真实 HTTP**（真 fetch、真 SSE 分帧、真流式），
 * 只是端点换成了本地假端点，所以不花钱、可重复。
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { OpenAICompatibleClient } from '../src/model/openai-compatible.ts'
import { createDefaultRegistry } from '../src/tools/index.ts'
import { createRecovery, RecoveryGuard } from '../src/recovery/index.ts'
import { Policy } from '../src/policy/index.ts'
import { Session, SessionStore } from '../src/host/index.ts'
import type { HostEvent } from '../src/protocol/types.ts'

const baseUrl = process.argv[2] ?? process.env.MVS_BASE_URL ?? 'http://127.0.0.1:8787/v1'

const say = (text: string): void => process.stdout.write(`${text}\n`)
const rule = (): void => say('─'.repeat(72))
const dim = (t: string): string => `\u001b[2m${t}\u001b[0m`
const bold = (t: string): string => `\u001b[1m${t}\u001b[0m`

const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-host-'))
const box = await mkdtemp(path.join(os.tmpdir(), 'mvs-host-state-'))

try {
  const registry = createDefaultRegistry()

  const recovery = createRecovery({ root, storeDir: path.join(box, 'recovery') })
  await recovery.init()
  const executor = new RecoveryGuard(registry, recovery)

  const policy = new Policy({ mode: 'workspace-write' })

  const store = new SessionStore(path.join(box, 'session'))
  await store.init()

  const session = new Session({
    sessionId: 'demo',
    workspace: root,
    model: new OpenAICompatibleClient({ baseUrl, model: 'fake', includeUsage: true }),
    modelName: 'fake',
    registry,
    policy,
    executor,
    store,
    system: '你是 MVS Agent 的演示实例。',
  })

  // 订阅事件流 —— 这就是将来推给 UI 的那条流
  const seen: HostEvent[] = []
  session.subscribe((envelope) => {
    const event = envelope.event
    seen.push(event)
    switch (event.type) {
      case 'model_text_delta':
        process.stdout.write(event.text)
        break
      case 'policy_decision':
        say(
          dim(
            `\n  [策略] ${event.tool} → ${event.decision}（${event.reason}）`,
          ),
        )
        break
      case 'tool_intent':
        say(dim(`  [意图] ${event.tool} ${event.argsJson}   ← 先落盘，再执行`))
        break
      case 'tool_settled':
        say(
          dim(
            `  [结算] ${event.tool} ok=${event.ok}` +
              (event.recoveryTxnId !== undefined ? `  恢复事务=${event.recoveryTxnId.slice(0, 12)}…` : ''),
          ),
        )
        break
      default:
        break
    }
  })

  rule()
  say(bold('启动会话'))
  const init = await session.init()
  say(`  工作区    ${root}`)
  say(`  状态目录  ${box}`)
  say(`  端点      ${baseUrl}`)
  if (init.warnings.length > 0) {
    for (const w of init.warnings) say(`  ⚠ ${w}`)
  }
  say(`  模式      ${policy.mode} —— ${JSON.stringify(describeMode(policy.mode))}`)

  rule()
  say(bold('第 1 轮：让模型去写一个文件'))
  say('用户 › 帮我写文件\n')
  say('助手 › ')
  await session.sendUserMessage('帮我写文件')

  const note = path.join(root, 'agent-note.txt')
  say('')
  say(`  文件真的被创建了吗：${existsSync(note)}`)
  if (existsSync(note)) {
    say(`  内容：${JSON.stringify(await readFile(note, 'utf8'))}`)
  }

  rule()
  say(bold('投影（客户端迟到加入时读这个）'))
  const projection = session.projection()
  say(`  状态    ${projection.status}`)
  say(`  轮次    ${projection.turn}    步数 ${projection.step}`)
  say(`  模式    ${projection.mode}`)
  say(`  消息    ${projection.messages.length} 条`)
  for (const message of projection.messages) {
    const label =
      message.role === 'tool'
        ? `tool(${message.toolCallId ?? '?'})`
        : message.role
    const preview =
      message.role === 'assistant' && 'toolCalls' in message && message.toolCalls !== undefined
        ? `${message.content || '(无文本)'} [调用 ${message.toolCalls.map((c) => c.name).join(',')}]`
        : message.content.replace(/\n/g, ' ⏎ ')
    say(`    ${label.padEnd(12, ' ')} ${preview.slice(0, 60)}`)
  }

  rule()
  say(bold('持久化：两个文件，两种写入模式'))
  const rawLog = await readFile(store.eventsPath, 'utf8')
  const logLines = rawLog.trim().split('\n').length
  const checkpointRaw = await readFile(store.checkpointPath, 'utf8')
  say(`  events.jsonl    ${logLines} 条事件，${rawLog.length} 字节（只追加）`)
  say(`  checkpoint.json ${checkpointRaw.length} 字节（每步原子重写，大小恒定）`)
  say(
    dim(
      `  日志里没有 token 级事件：${
        rawLog.includes('model_text_delta') ? '有（不对）' : '没有 ✔'
      }`,
    ),
  )

  rule()
  say(bold('恢复层：刚才那次写入是可撤销的'))
  const transactions = await recovery.list()
  for (const t of transactions) {
    say(`  ${t.id.slice(0, 18)}…  ${t.summary}`)
    say(`    新增 ${t.changes.added.length} / 修改 ${t.changes.modified.length} / 删除 ${t.changes.removed.length}`)
    for (const p of t.changes.added) say(`      + ${p}`)
  }

  const last = transactions.at(-1)
  if (last !== undefined && last.changes.added.length > 0) {
    const report = await recovery.restore(last.id)
    say('')
    say(`  执行撤销 → ${report.message}`)
    say(`  文件还在吗：${existsSync(note)}`)
    for (const gap of report.notCovered) say(dim(`  管不到：${gap}`))
  }

  rule()
  say(bold('总计事件序列'))
  const counts = new Map<string, number>()
  for (const e of seen) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
  for (const [type, count] of counts) say(`  ${type.padEnd(22, ' ')} ×${count}`)
} finally {
  const cleanup = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const
  await rm(root, cleanup)
  await rm(box, cleanup)
}

function describeMode(mode: string): Record<string, string> {
  return {
    'read-only': '写=禁止 · 命令=禁止',
    'workspace-write': '写=仅工作区 · 命令=允许（默认询问）',
    'full-access': '写=任意 · 命令=允许（默认放行）',
  }[mode] ?? {}
}
