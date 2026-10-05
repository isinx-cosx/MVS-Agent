/**
 * 上下文压缩。
 *
 * 两级策略，先便宜后贵：
 *
 * 1. **裁剪超大工具结果** —— 无模型调用、确定性、随时可做。
 *    一个 `npm install` 的输出就能吃掉几万 token，而头尾几 KB 通常就够了。
 * 2. **丢弃最老的轮次** —— 仍然超预算时的兜底，且**留下显式标记**，
 *    让模型知道「这里有一段历史被省略」，而不是让它以为对话本来就始于此处。
 *
 * 刻意**不做**「让模型总结历史」：那需要一次额外调用、会引入不确定性，
 * 而且总结本身可能是有损且不可复现的。先做确定性的两级；真需要总结再加。
 */

import type { Message } from '../model/types.ts'
import { estimateConversationTokens } from './tokens.ts'
import {
  triggerThreshold,
  usableBudget,
  type CompactionAction,
  type CompactionOptions,
  type CompactionResult,
} from './types.ts'

/** 标记前缀。用来在重复压缩时识别并替换旧标记，避免它们越积越多 */
export const COMPACTION_MARKER = '[上下文压缩]'

function isMarker(message: Message): boolean {
  return message.role === 'system' && message.content.startsWith(COMPACTION_MARKER)
}

/**
 * 开头的连续 system 消息 = 真正的系统提示，永不动。
 *
 * ⚠️ **必须把压缩标记排除在外。** 标记就插在系统提示的正后面，
 * 如果一并算进 leading，第二次压缩时它就躲过了去重逻辑 ——
 * 结果是每压一次多一条标记，越积越多（这个 bug 被测试逮到过）。
 */
function splitLeadingSystem(messages: readonly Message[]): { leading: Message[]; rest: Message[] } {
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (message === undefined) break
    if (message.role !== 'system' || isMarker(message)) break
    index += 1
  }
  return { leading: messages.slice(0, index), rest: messages.slice(index) }
}

export function needsCompaction(
  messages: readonly Message[],
  options: CompactionOptions,
  calibrationFactor = 1,
): boolean {
  return estimateConversationTokens(messages, calibrationFactor) > triggerThreshold(options)
}

/**
 * @param calibrationFactor 来自 {@link TokenCalibration} 的校准系数。
 *   它是**运行时状态**而不是配置，所以走参数而不是 CompactionOptions。
 */
export function compact(
  messages: readonly Message[],
  options: CompactionOptions,
  calibrationFactor = 1,
): CompactionResult {
  const estimate = (list: readonly Message[]): number =>
    estimateConversationTokens(list, calibrationFactor)

  const tokensBefore = estimate(messages)
  const threshold = triggerThreshold(options)

  // 只在「即将超出」时动手。**不到线就什么都不做** ——
  // 压缩是有损的，不该是个常备动作。
  if (tokensBefore <= threshold) {
    return {
      messages: [...messages],
      actions: [],
      tokensBefore,
      tokensAfter: tokensBefore,
      stillOverBudget: false,
    }
  }

  const actions: CompactionAction[] = []

  // ── 第一级：裁剪超大工具结果 ────────────────────────────────────────
  let working: Message[] = messages.map((message) => pruneToolResult(message, options, actions))

  // ── 第二级：仍然超线才丢最老的轮次 ────────────────────────────────
  if (estimate(working) > threshold) {
    working = dropOldTurns(working, options, actions)
  }

  const tokensAfter = estimate(working)
  return {
    // actions 为空时也要原样返回（可能只是刚好卡在阈值上）
    messages: actions.length === 0 ? [...messages] : working,
    actions,
    tokensBefore,
    tokensAfter,
    stillOverBudget: tokensAfter > usableBudget(options),
  }
}

// ---------------------------------------------------------------------------

function pruneToolResult(
  message: Message,
  options: CompactionOptions,
  actions: CompactionAction[],
): Message {
  if (message.role !== 'tool') return message
  if (message.content.length <= options.toolResultThresholdChars) return message

  const head = message.content.slice(0, options.toolResultHeadChars)
  const tail = message.content.slice(-options.toolResultTailChars)
  const removed = message.content.length - head.length - tail.length

  const content =
    `${head}\n\n` +
    `…[已裁剪 ${removed} 字符。原文仍在事件日志里（events.jsonl 的 tool_settled.content）；` +
    `若是文件内容，也可用恢复工具还原。需要细节时重新读取比依赖这段记忆更可靠]\n\n` +
    `${tail}`

  actions.push({
    kind: 'prune-tool-result',
    toolCallId: message.toolCallId,
    originalChars: message.content.length,
    keptChars: content.length,
  })

  return { ...message, content }
}

function dropOldTurns(
  messages: readonly Message[],
  options: CompactionOptions,
  actions: CompactionAction[],
): Message[] {
  const { leading, rest } = splitLeadingSystem(messages)

  // 先清掉旧的压缩标记 —— 否则每压一次就多一条，越积越多
  const conversation = rest.filter((message) => !isMarker(message))

  const userIndices: number[] = []
  conversation.forEach((message, index) => {
    if (message.role === 'user') userIndices.push(index)
  })

  if (userIndices.length <= options.keepRecentTurns) {
    // 轮次不够多，丢不出东西。不硬凑 —— 报实情，让调用方知道仍然超预算。
    return messages.filter((message) => !isMarker(message))
  }

  const cutAt = userIndices[userIndices.length - options.keepRecentTurns] as number
  if (cutAt === 0) return conversation

  const dropped = conversation.slice(0, cutAt)
  const kept = conversation.slice(cutAt)
  const droppedTurns = dropped.filter((message) => message.role === 'user').length

  actions.push({ kind: 'drop-turns', droppedTurns, droppedMessages: dropped.length })

  const marker: Message = {
    role: 'system',
    content:
      `${COMPACTION_MARKER} 已省略更早的 ${droppedTurns} 轮对话（${dropped.length} 条消息）。` +
      `它们不在当前上下文里，但完整记录仍在事件日志中。` +
      `如果用户提到更早的内容，直接说不记得，不要编造。`,
  }

  return [...leading, marker, ...kept]
}
