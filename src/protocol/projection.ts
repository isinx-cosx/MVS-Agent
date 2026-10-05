/**
 * 投影：从事件流推导出客户端要看的视图。
 *
 * 这是 DSH 里 `session-projection` 对应的那一层，也是我前面说的
 * 「UI 需要的是状态可重建，不等于执行可恢复」里那个便宜的一半。
 *
 * 关键设计：**投影是纯函数的结果**。给定同一个事件流，推导出的消息数组逐字相同。
 * 所以「迟到加入的客户端」和「一直在线的客户端」看到的是一致的东西
 * —— 这正是 Claude Code #34368 那个 bug（UI 提供了撤销但对应不上）的反面。
 */

import type { Message } from '../model/types.ts'
import type { Envelope, HostEvent, PendingApproval, ToolCallRecord } from './types.ts'

/**
 * 重建送给模型的消息数组。
 *
 * **必须与当时逐字相同**，否则 resume 之后模型看到的是另一段历史。
 * 所以日志里存的是完整内容（`assistant_message.toolCalls`、
 * `tool_settled.content`），而不是摘要。
 */
export function rebuildMessages(events: readonly HostEvent[]): Message[] {
  let messages: Message[] = []

  for (const event of events) {
    switch (event.type) {
      case 'turn_started':
        messages.push({ role: 'user', content: event.input })
        break

      case 'assistant_message':
        messages.push({
          role: 'assistant',
          content: event.text,
          /*
           * 思考也一样：**有才带**。
           *
           * 带上它界面才能把「模型当时想了什么」画出来 —— 而重开会话之后
           * 也要能再看到，所以它必须落盘、也必须被重建出来。
           *
           * ⚠️ 只带 `content` 的话思考会在重建时**静默消失**：写进去的日志里有，
           * 但重建出来的消息里没有，于是「内存里的」和「从日志重建的」
           * 不一致 —— 那正是这个文件开头那段注释在防的事。
           */
          ...(event.reasoning === undefined || event.reasoning === ''
            ? {}
            : { reasoning: event.reasoning }),
          // 只有真的有工具调用时才带这个字段，保持与当时一致
          ...(event.toolCalls.length > 0 ? { toolCalls: event.toolCalls } : {}),
        })
        break

      case 'tool_settled':
        messages.push({ role: 'tool', content: event.content, toolCallId: event.callId })
        break

      case 'context_compacted':
        // 压缩是一次状态转换：**整体替换**，不做增量推导。
        //
        // 增量推导会要求重建方也实现一遍压缩算法，两边一旦不一致就是
        // 静默的历史分叉 —— 而那种 bug 只在 resume 之后才现形，极难定位。
        messages = event.messages.map((message) => ({ ...message }))
        break

      default:
        // 其余事件不产生消息（流式增量、策略判定、通知等）
        break
    }
  }

  return messages
}

/**
 * 找出未结算的工具调用 —— 也就是「状态未知」那次。
 *
 * 有 intent 没有 settled，意味着进程死在执行中途。**不能猜**：
 * 猜「跑过了」会漏掉一次本该发生的动作，猜「没跑过」会二次执行非幂等操作。
 * 唯一安全的处理是交给人。
 */
export function findUnsettledCall(
  events: readonly HostEvent[],
): { callId: string; tool: string; argsJson: string } | null {
  const open = new Map<string, { tool: string; argsJson: string }>()

  for (const event of events) {
    if (event.type === 'tool_intent') {
      open.set(event.callId, { tool: event.tool, argsJson: event.argsJson })
    } else if (event.type === 'tool_settled') {
      open.delete(event.callId)
    }
  }

  const first = open.entries().next()
  if (first.done === true) return null
  return { callId: first.value[0], tool: first.value[1].tool, argsJson: first.value[1].argsJson }
}

/** 找出还挂着的审批请求（进程死在等人回答的时候） */
export function findPendingApproval(events: readonly HostEvent[]): PendingApproval | null {
  const open = new Map<string, PendingApproval>()

  for (const event of events) {
    if (event.type === 'approval_requested') {
      open.set(event.approvalId, {
        approvalId: event.approvalId,
        callId: event.callId,
        tool: event.tool,
        argsJson: event.argsJson,
        message: event.message,
      })
    } else if (event.type === 'approval_resolved') {
      open.delete(event.approvalId)
    } else if (event.type === 'turn_finished' || event.type === 'session_started') {
      open.clear()
    }
  }

  const first = open.values().next()
  return first.done === true ? null : first.value
}

export function lastSeq(envelopes: readonly Envelope[]): number {
  const last = envelopes.at(-1)
  return last === undefined ? 0 : last.seq
}

/**
 * 把一条事件折进工具调用记录表。**就地修改**，因为它会被逐条调用。
 *
 * 和 `rebuildMessages` 一样，这是**唯一**一处决定「结算与撤销状态怎么算」的
 * 地方：会话在启动时把整段日志折一遍，之后每落一条事件再折一次，两条路径共用
 * 这个函数。分两份实现的话，「一直在线的客户端」和「刚刷新的客户端」会算出不同
 * 的撤销状态 —— 那是 Claude Code #34368 那类 bug 的经典形态（界面给了撤销，
 * 但和实际状态对不上）。
 */
export function foldToolCall(records: ToolCallRecord[], event: HostEvent): void {
  if (event.type === 'tool_settled') {
    records.push({
      callId: event.callId,
      tool: event.tool,
      ok: event.ok,
      summary: event.summary,
      // 没动文件的工具（读、查）没有事务 —— 它照样是一张卡，只是没有撤销按钮
      undoTxnId: event.recoveryTxnId ?? null,
      reverted: false,
    })
    return
  }

  if (event.type !== 'revert_settled') return

  // 撤销是否**真的**把文件翻过去了。
  //
  // ⚠️ 只有「整体成功」才算翻转。恢复层可能部分成功（有的文件之后被改过，
  // 于是它拒绝覆盖），这时文件状态停在中间 —— 既不是「改完了」也不是
  // 「没改过」。把它当成翻转会让界面显示「已撤销（可重做）」，而文件其实
  // 只回去了一半，用户看到的就是一个说谎的按钮。
  const flipped = event.ok && event.skipped.length === 0
  if (!flipped) return

  const record = records.find((r) => r.undoTxnId === event.txnId)
  if (record === undefined) return
  record.reverted = !record.reverted
  // 撤销产生了一个新事务：要翻回去，现在该撤它。
  // 拿不到新事务（恢复层没能为恢复本身拍快照）就说明翻不回去了。
  record.undoTxnId = event.restoreTxnId
}

/** 从整段日志算出工具调用记录表（启动时用） */
export function rebuildToolCalls(events: readonly HostEvent[]): ToolCallRecord[] {
  const records: ToolCallRecord[] = []
  for (const event of events) foldToolCall(records, event)
  return records
}
