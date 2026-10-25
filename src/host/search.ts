/**
 * 会话内容搜索。
 *
 * ## 为什么要搜**消息**而不是**事件**
 *
 * 事件流里是碎片：`model_text_delta` 一个 token 一条。直接在上面搜会得到
 * 一堆断句，而且命中位置毫无意义。所以这里先用 `rebuildMessages` 把事件
 * 折成完整消息，再在消息上匹配 —— 代价是一次投影，收益是"搜到的是人能读的句子"。
 *
 * ## 为什么先做线性扫描，不做索引
 *
 * 实测的量级：1840 个会话、日志共 3.4 MB、最大一个 760 KB。全量扫一遍是几十毫秒，
 * 而索引会带来"什么时候更新它"这个新问题（每次工具调用都要写索引？失败了怎么办？）。
 * 所以这里**先线性**，并且把「扫了多少」如实报出来 —— 等到真超过某个规模再换，
 * 那时会有真实数字，而不是提前猜。
 *
 * ## 三种"搜不到"必须分开
 *
 *   · 真的没有（`matches` 空，`scanned` 完整）
 *   · 只扫了一部分（`truncated` 有值，说明为什么）
 *   · 查询本身不合法（空串、正则写错）→ 抛错，由调用方回 400
 */

import type { Message } from '../model/types.ts'

export interface SearchHit {
  sessionId: string
  title: string
  workspace: string
  /** 命中的是哪一类消息 */
  role: 'user' | 'assistant' | 'tool'
  /** 命中位置前后各取一段，命中词用 `[](…)` 标出 */
  snippet: string
  /** 这条消息在会话里的序号（0 基），界面据此跳转 */
  messageIndex: number
  /** 命中时间（会话最后一次更新） */
  at: string
}

export interface SearchStats {
  /** 实际扫过的会话数 */
  sessions: number
  /** 一共有多少会话可扫 */
  sessionsAvailable: number
  /** 扫过的事件条数 */
  events: number
  /** 耗时（毫秒） */
  ms: number
  /**
   * 被截断的原因。**空 = 搜完了**。
   *
   * 这一条是"搜不到"和"没搜完"的分界线：没有它，用户会以为结果就是全部。
   */
  truncated?: string
}

export interface SearchResult {
  matches: SearchHit[]
  stats: SearchStats
}

export interface SearchInput {
  /** 一个会话的事件 → 完整消息。注入，便于测试 */
  messages: (sessionId: string) => Promise<{ messages: Message[]; events: number }>
  /** 可搜的会话（按最近更新排序由调用方负责） */
  sessions: Array<{ sessionId: string; title: string; workspace: string; at: string }>
  query: string
  /** true 时把 query 当正则。**写错就抛错**，不静默返回空 */
  regex?: boolean
  limit?: number
  /** 最多扫多少个会话 */
  maxSessions?: number
  /** 每条消息里最多取几个命中片段 */
  maxHitsPerMessage?: number
}

const DEFAULT_LIMIT = 20
const DEFAULT_MAX_SESSIONS = 500
const SNIPPET_BEFORE = 40
const SNIPPET_AFTER = 60

/**
 * 编译匹配器。
 *
 * 不做「自动转义」：用户搜 `(` 就该搜到 `(`。要做正则必须显式 `regex: true`，
 * 而写错时会得到一条明确的错误 —— 和 `grep` 工具的行为保持一致
 * （那边也是 `bad_pattern`，不是"没有匹配"）。
 */
export function compileMatcher(query: string, regex = false): (text: string) => Array<[number, number]> {
  const needle = query.trim()
  if (needle === '') throw new Error('搜索词不能为空')

  if (regex) {
    let pattern: RegExp
    try {
      pattern = new RegExp(needle, 'gi')
    } catch (error) {
      throw new Error(`正则写错了：${error instanceof Error ? error.message : String(error)}`)
    }
    return (text: string): Array<[number, number]> => {
      const spans: Array<[number, number]> = []
      pattern.lastIndex = 0
      for (;;) {
        const match = pattern.exec(text)
        if (match === null) break
        /* 零宽匹配会让 exec 卡在同一位置 —— 手工前进一格 */
        if (match[0].length === 0) pattern.lastIndex += 1
        else spans.push([match.index, match.index + match[0].length])
        if (spans.length > 50) break
      }
      return spans
    }
  }

  const lowered = needle.toLowerCase()
  return (text: string): Array<[number, number]> => {
    const spans: Array<[number, number]> = []
    const haystack = text.toLowerCase()
    let from = 0
    for (;;) {
      const at = haystack.indexOf(lowered, from)
      if (at < 0) break
      spans.push([at, at + lowered.length])
      from = at + lowered.length
      if (spans.length > 50) break
    }
    return spans
  }
}

/** 取一段上下文，命中处用 `[]` 包住（多段用 `…` 连接） */
export function snippetAround(text: string, spans: Array<[number, number]>, max = 3): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (spans.length === 0) return flat.slice(0, SNIPPET_BEFORE + SNIPPET_AFTER)

  /*
   * ⚠️ 先折叠空白再算位置会错位 —— 所以这里在**原文**上取片段，再折叠。
   */
  const parts: string[] = []
  for (const [start, end] of spans.slice(0, max)) {
    const from = Math.max(0, start - SNIPPET_BEFORE)
    const to = Math.min(text.length, end + SNIPPET_AFTER)
    const piece =
      (from > 0 ? '…' : '') +
      text.slice(from, start).replace(/\s+/g, ' ') +
      '[' +
      text.slice(start, end).replace(/\s+/g, ' ') +
      ']' +
      text.slice(end, to).replace(/\s+/g, ' ') +
      (to < text.length ? '…' : '')
    parts.push(piece)
  }
  return parts.join(' / ')
}

function roleOf(message: Message): SearchHit['role'] | null {
  if (message.role === 'user') return 'user'
  if (message.role === 'assistant') return 'assistant'
  if (message.role === 'tool') return 'tool'
  return null
}

/**
 * 一条消息里可搜的文字。
 *
 * 工具消息的 `content` 可能是字符串也可能是结构，用 `JSON.stringify` 兜底 ——
 * 搜 "ECONNREFUSED" 时命中的是工具输出，那是最常见的场景之一。
 */
function textOf(message: Message): string {
  if (typeof message.content === 'string') return message.content
  try {
    return JSON.stringify(message.content)
  } catch {
    return ''
  }
}

export async function searchSessions(input: SearchInput): Promise<SearchResult> {
  const startedAt = Date.now()
  const match = compileMatcher(input.query, input.regex === true)
  const limit = input.limit ?? DEFAULT_LIMIT
  const maxSessions = input.maxSessions ?? DEFAULT_MAX_SESSIONS

  const matches: SearchHit[] = []
  let scannedSessions = 0
  let scannedEvents = 0
  let truncated: string | undefined

  for (const session of input.sessions) {
    if (scannedSessions >= maxSessions) {
      truncated = `只扫了最近 ${maxSessions} 个会话（总共 ${input.sessions.length} 个）`
      break
    }
    if (matches.length >= limit) {
      truncated = `命中已够 ${limit} 条，后面的会话没再扫`
      break
    }

    scannedSessions += 1
    let folded: { messages: Message[]; events: number }
    try {
      folded = await input.messages(session.sessionId)
    } catch {
      /* 单个会话的日志坏了不该让整次搜索失败 —— 跳过，继续扫 */
      continue
    }
    scannedEvents += folded.events

    for (let index = 0; index < folded.messages.length; index += 1) {
      const message = folded.messages[index]!
      const role = roleOf(message)
      if (role === null) continue

      const text = textOf(message)
      if (text === '') continue
      const spans = match(text)
      if (spans.length === 0) continue

      matches.push({
        sessionId: session.sessionId,
        title: session.title,
        workspace: session.workspace,
        role,
        snippet: snippetAround(text, spans, input.maxHitsPerMessage ?? 3),
        messageIndex: index,
        at: session.at,
      })
      if (matches.length >= limit) break
    }
  }

  return {
    matches,
    stats: {
      sessions: scannedSessions,
      sessionsAvailable: input.sessions.length,
      events: scannedEvents,
      ms: Date.now() - startedAt,
      ...(truncated === undefined ? {} : { truncated }),
    },
  }
}
