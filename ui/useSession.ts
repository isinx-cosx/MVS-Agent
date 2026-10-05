/**
 * 会话状态机。**投影是真相，增量只是提示。**
 *
 * ## 为什么要这样分
 *
 * 旧那套把流式做成独立通道，自己带计数器，还要和落盘记录对账；两套数一旦错开
 * 就整条流重建，而且**重建是静默的** —— 我们花了两天才定位。
 *
 * 这里的规则只有一条：
 *
 *   · `messages` 永远由 `/projection` 重建（真相）；
 *   · `live` 是"正在生成的那一段"，只被 `model_*_delta` 追加（提示）；
 *   · 提示丢了、重了、乱了都不影响正确性 —— 下一次重建就纠正回来。
 *
 * 于是"流式渲染"退化成一件很简单的事：往 `live` 里追加文本，由它先画出来。
 *
 * ## 换会话
 *
 * `selectedId` 是**外部给的**（界面上点哪条对话）。传 `null` 表示"你自己挑一个"。
 * 它一变，这个 hook 就整个换掉：断开旧连接、清空界面状态、订阅新会话、重取投影。
 *
 * ⚠️ 换会话时**必须把界面状态清干净**（`live` / `pending` / `interruptedTool` …）。
 * 不清的话旧会话的半个回答会留在新对话上，看起来就像串台 —— 而那是最吓人的一类
 * 现象（"我的对话被别人的内容污染了"）。真正的内容以投影为准，所以清掉不会丢东西。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  connectSession,
  getProjection,
  getState,
  postCommand,
  textOf,
  type ChatMessage,
  type CommandResult,
  type CommandSender,
  type HostEvent,
} from './client.ts'

export interface LiveBlock {
  reasoning: string
  text: string
  active: boolean
}

export interface SessionState {
  ready: boolean
  sessionId: string | null
  messages: ChatMessage[]
  /** 刚发出去、投影还没来得及确认的那条（乐观显示，确认后交还给投影） */
  pending: string | null
  live: LiveBlock
  running: boolean
  /**
   * 会话被**阻断**时卡住的那个工具名（`interrupted` 状态）。
   *
   * 单独立一个字段而不是拼进 `error` 文本：它不是"出错了"，而是"需要你做决定"
   * —— 界面上要配一个动作（确认后继续），而一段错误文本给不出动作。
   */
  interruptedTool: string | null
  /**
   * 正在等**人**批准的那次工具调用。`null` = 没有。
   *
   * 它和 `interruptedTool` 是一对：那个是"已经过去、结果未知"，这个是"就在眼前、
   * 等你一句话"。两者都必须有出口 —— 否则会话就停在那儿，而用户不知道为什么。
   */
  approval: {
    approvalId: string
    callId: string
    tool: string
    argsJson: string
    message: string
  } | null
  error: string | null
  note: string | null
  status: string
  /** 当前会话的权限模式（投影是真相）。空串表示还没读到 */
  mode: string
  /** 上下文用量与窗口 —— 只用于显示 */
  contextTokens: number
  contextWindowTokens: number
  /**
   * 最近一次模型调用的用量。`null` = 还不知道（还没跑过一轮，或端点不给）。
   * 缓存命中率与真实 token/秒都从这里来。
   */
  lastUsage: {
    inputTokens: number
    outputTokens: number
    cachedTokens?: number
    tokensPerSecond?: number
  } | null
  /**
   * 抗疲劳熔断器状态。它是一道单向门（只有人明确复位才解除），所以界面必须
   * 同时给出**原因**（计数）和**出口**（复位按钮）。
   */
  fatigue: { active: boolean; consecutiveBlocks: number; totalBlocks: number } | null
}

const EMPTY_LIVE: LiveBlock = { reasoning: '', text: '', active: false }

/**
 * 自动挑一个会话：**最近打开的工作区里、最近改过的那个**；那个工作区还没有对话才建一个。
 *
 * ⚠️ 这里曾经是"每次挂载都新建一个会话"—— 于是每刷新一次页面就多一条"新会话"，
 * 列表里堆到 190 条。挑现有的既干净，也更符合直觉：刷新该回到你刚才在的地方。
 */
async function pickDefaultSession(): Promise<{ sessionId: string | null; note: string | null }> {
  const before = await getState()
  const workspaces = before.state.workspaces ?? []
  const first = workspaces[0]
  if (first === undefined) {
    return { sessionId: null, note: '还没有打开任何工作区。' }
  }

  /* 最近打开过的那个，和守护进程的默认一致 */
  const workspace =
    [...workspaces].sort(
      (a, b) => Date.parse(b.lastOpenedAt ?? '') - Date.parse(a.lastOpenedAt ?? ''),
    )[0]?.path ?? first.path

  const mine = (before.state.sessions ?? []).filter((s) => s.workspace === workspace)
  const newest = [...mine].sort(
    (a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''),
  )[0]
  if (newest !== undefined) return { sessionId: newest.sessionId, note: null }

  /* 这个工作区一个对话都没有：建一个。用命令回传的 id —— 它是有契约的
     （见 `test/server.test.ts` 那条"create_session 回传新会话的 id"）。 */
  const created = await postCommand({ type: 'create_session', workspace })
  return { sessionId: created.sessionId ?? null, note: null }
}

export function useSession(selectedId: string | null): SessionState & {
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  /** 人确认那次结果未知的工具调用，解除阻断（那道门的开关） */
  acknowledge: () => Promise<void>
  /** 改这个会话的权限模式（`set_mode`，**会话级**，不是进程配置） */
  setMode: (mode: string) => Promise<void>
  /** 复位抗疲劳熔断器（那道单向门的出口） */
  resetFatigue: () => Promise<void>
  /**
   * 回答一次审批请求。
   *
   * ⚠️ 这是**唯一**能解开"等批准"那个状态的动作 —— 不给它按钮，会话就停在那里，
   * 而界面上没有任何东西说明它在等什么。
   */
  approve: (granted: boolean) => Promise<void>
} {
  const [state, setState] = useState<SessionState>({
    ready: false,
    sessionId: null,
    messages: [],
    pending: null,
    live: EMPTY_LIVE,
    running: false,
    interruptedTool: null,
    approval: null,
    error: null,
    note: null,
    status: '',
    mode: '',
    contextTokens: 0,
    contextWindowTokens: 0,
    lastUsage: null,
    fatigue: null,
  })

  /* 会话 id 在回调里要用，但它不该触发重订阅，所以放 ref */
  const sessionRef = useRef<string | null>(null)

  /**
   * 在**这条会话的 WebSocket** 上发命令的能力。
   *
   * 它按会话更换（每次重订阅时替换），所以放 ref。
   * 拿不到（socket 还没开、或超时）时回落 HTTP —— 两条路的返回值形状一样。
   */
  const wsCommand = useRef<CommandSender | null>(null)

  /**
   * 发一条**会话命令**。
   *
   * ⚠️ 优先走 WS，而不是一直用 HTTP：HTTP 那条路服务端不知道是哪个连接在发消息，
   * 于是"发出去了、订阅还没到"这个窗口里的逐 token 增量会被整段丢掉
   * （现象：第一轮不流式、后面就好）。走 WS 之后服务端收到命令就顺手订阅，
   * 窗口从构造上消失。
   *
   * 回落 HTTP 不是多余的：daemon 还没重启、WS 正在重连、回执超时 —— 这些时候
   * HTTP 仍然是通的，而"命令没发出去"比"偶尔少一点流式"严重得多。
   */
  const runCommand = useCallback(
    async (command: Record<string, unknown>): Promise<CommandResult> => {
      const sender = wsCommand.current
      if (sender !== null) {
        const result = await sender(command)
        if (result !== null) {
          if (result.ok === false) {
            throw new Error(result.message ?? `${String(command.type)} 被拒绝`)
          }
          return result
        }
      }
      return postCommand(command)
    },
    [],
  )

  const patch = useCallback((part: Partial<SessionState>) => {
    setState((prev) => ({ ...prev, ...part }))
  }, [])

  /** 从投影重建真相。**所有落盘内容的唯一来源** */
  const reconcile = useCallback(async () => {
    const sessionId = sessionRef.current
    if (sessionId === null) return
    try {
      const { projection } = await getProjection(sessionId)
      const running = projection.status === 'running'
      const messages = projection.messages ?? []
      setState((prev) => {
        /*
         * 乐观消息什么时候交还：**投影里已经出现同内容的那条 user 消息**。
         * 不能"一重建就清" —— 那样会闪一下（先消失、再随投影出现）。
         */
        const lastUser = [...messages].reverse().find((m) => m.role === 'user')
        const confirmed =
          prev.pending !== null && lastUser !== undefined && textOf(lastUser.content) === prev.pending

        /*
         * ★ **落盘消息已经包含"正在生成"的那段时，把 live 收掉。**
         *
         * 一个回合里模型可能调用多次（每次都是一条 `assistant/message`）。第一次
         * 调用结束后，投影里**已经有**那条助手消息了，而此刻 `running` 仍为真
         * （回合还没结束），于是 live 块**不会**被清 —— 同一段文字同时出现在
         * "已落盘"和"正在生成"两处 ✗，等下一次 reconcile 又少掉一份 ✓。
         * 用户看到的就是**内容一上一下地跳**。
         *
         * 判据用文本相等：这是唯一能量化"同一段内容"的东西，而且只在
         * live 有正文时才比较（纯思考阶段投影里还没有消息可比）。
         */
        const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
        const settledAlready =
          prev.live.text !== '' &&
          lastAssistant !== undefined &&
          textOf(lastAssistant.content) === prev.live.text

        return {
          ...prev,
          messages,
          running,
          pending: confirmed ? null : prev.pending,
          /* 回合结束、或内容已经落盘 —— 两种都把 live 收掉 */
          live: running && !settledAlready ? prev.live : EMPTY_LIVE,
          /* 阻断状态以投影为准（人确认之后它自己会变回 null） */
          interruptedTool: projection.interruptedCall?.tool ?? null,
          /* 等批准的那一次（以投影为准：批准之后它自己会变回 null） */
          approval: projection.pendingApproval ?? null,
          /*
           * 权限模式与上下文用量也以投影为准 —— 它们都会被 daemon 改（换模式、
           * 新消息进来），界面自己记一份必然会漂。界面只用它们**显示**。
           */
          mode: projection.mode ?? '',
          contextTokens: projection.contextTokens ?? 0,
          contextWindowTokens: projection.contextWindowTokens ?? 0,
          /* 缺省就是"不知道"（null），不用 0 冒充 —— 界面据此显示 `—` */
          lastUsage: projection.lastUsage ?? null,
          fatigue: projection.fatigue ?? null,
        }
      })
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }, [patch])

  const onEvent = useCallback(
    (event: HostEvent) => {
      switch (event.type) {
        case 'turn_started':
          patch({ running: true, error: null, live: { reasoning: '', text: '', active: true } })
          break

        case 'model_reasoning_delta':
          setState((prev) => ({
            ...prev,
            live: {
              reasoning: prev.live.reasoning + String(event.text ?? ''),
              text: prev.live.text,
              active: true,
            },
          }))
          break

        case 'model_text_delta':
          setState((prev) => ({
            ...prev,
            live: {
              reasoning: prev.live.reasoning,
              text: prev.live.text + String(event.text ?? ''),
              active: true,
            },
          }))
          break

        case 'assistant_message':
          /* 落盘消息到了：正文与思考以它为准，先落到"进行中"那块 */
          setState((prev) => ({
            ...prev,
            live: {
              reasoning: String(event.reasoning ?? prev.live.reasoning),
              text: String(event.text ?? prev.live.text),
              active: true,
            },
          }))
          break

        case 'turn_finished':
          patch({ running: false })
          void reconcile()
          break

        /* 错误必须显形：旧那套把它当事件丢掉，用户只看到"没反应" */
        case 'error':
          patch({ error: String(event.message ?? '未知错误'), running: false })
          break

        case 'notice':
          patch({ note: String(event.message ?? '') })
          break

        case 'tool_intent':
          patch({ note: `调用工具 ${event.tool ?? ''}` })
          break

        default:
          break
      }
    },
    [patch, reconcile],
  )

  /* 启动 / 换会话：定下目标会话，然后订阅它 */
  useEffect(() => {
    let dispose: (() => void) | undefined
    let cancelled = false

    /* 先把上一个会话的界面状态清干净（理由见文件头注释：不清就会"串台"） */
    sessionRef.current = null
    patch({
      ready: false,
      sessionId: null,
      messages: [],
      pending: null,
      live: EMPTY_LIVE,
      running: false,
      interruptedTool: null,
      approval: null,
      error: null,
      note: null,
      status: '',
      mode: '',
      contextTokens: 0,
      contextWindowTokens: 0,
      lastUsage: null,
      fatigue: null,
    })

    const boot = async (): Promise<void> => {
      try {
        let target = selectedId
        let note: string | null = null

        /* 选中的那个可能已经被删掉：先确认它还在，不在就退回自动挑选 */
        if (target !== null) {
          try {
            await getProjection(target)
          } catch {
            note = '那个对话已经不在了，已自动切到最近的一个。'
            target = null
          }
        }

        if (target === null) {
          const picked = await pickDefaultSession()
          target = picked.sessionId
          note = note ?? picked.note
        }

        if (target === null) {
          patch({ ready: true, error: note ?? '没有可用的会话。' })
          return
        }
        if (cancelled) return

        sessionRef.current = target
        patch({ sessionId: target, ready: true, note })
        await reconcile()
        const opened = connectSession(target, {
          onEvent,
          onChanged: () => void reconcile(),
          onStatus: (status) => patch({ status }),
        })
        dispose = opened.dispose
        /* 会话命令改走这条 WS —— 服务端收到就顺手订阅，竞态从构造上消失 */
        wsCommand.current = opened.command
      } catch (err) {
        patch({ ready: true, error: err instanceof Error ? err.message : String(err) })
      }
    }

    void boot()
    return () => {
      cancelled = true
      wsCommand.current = null
      dispose?.()
    }
  }, [selectedId, onEvent, patch, reconcile])

  const send = useCallback(
    async (text: string) => {
      const sessionId = sessionRef.current
      if (sessionId === null) return
      const trimmed = text.trim()
      if (trimmed === '') return

      patch({
        error: null,
        note: null,
        running: true,
        pending: trimmed,
        live: { reasoning: '', text: '', active: true },
      })
      try {
        await runCommand({ type: 'user_message', sessionId, text: trimmed })
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err), running: false })
      }
    },
    [patch],
  )

  const stop = useCallback(async () => {
    const sessionId = sessionRef.current
    if (sessionId === null) return
    try {
      await runCommand({ type: 'abort', sessionId })
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }, [patch])

  /**
   * 确认那次结果未知的工具调用，解除会话阻断。
   *
   * 这条命令只表示"我知道了，继续"，不表示"就当它执行过了" —— 副作用有没有发生
   * 要人来判断（daemon 那侧 `acknowledgeInterrupted()` 的注释也是这个意思）。
   */
  const acknowledge = useCallback(async () => {
    const sessionId = sessionRef.current
    if (sessionId === null) return
    try {
      await runCommand({ type: 'acknowledge_interrupted', sessionId })
      patch({ error: null, note: null })
      await reconcile()
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }, [patch, reconcile])

  /**
   * 改这个会话的权限模式。
   *
   * ⚠️ 走的是 `set_mode`（**会话级**），不是 `set_config`（进程级）——
   * 后者会把所有会话一起改掉，而用户在界面上看不出发生了什么（这条在
   * `src/protocol/types.ts` 里也有说明）。
   *
   * 改完**立刻重取投影**：模式以投影为准，界面不自己记一份。
   */
  const setMode = useCallback(
    async (mode: string) => {
      const sessionId = sessionRef.current
      if (sessionId === null) return
      try {
        await runCommand({ type: 'set_mode', sessionId, mode })
        await reconcile()
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) })
      }
    },
    [patch, reconcile],
  )

  /**
   * 复位抗疲劳熔断器。
   *
   * ⚠️ 这条命令**刻意不能自动触发**（比如"允许"的时候顺手复位）——
   * 熔断命中的前提就是"人在连续打回"，所以此刻的"允许"正是它不再信任的那个动作。
   * 界面上的入口必须是人**专门**点的，而且旁边要写清它意味着什么：
   * 复位会把整套记账（连续次数与累计次数）一起清掉。
   */
  const resetFatigue = useCallback(async () => {
    const sessionId = sessionRef.current
    if (sessionId === null) return
    try {
      await runCommand({ type: 'reset_fatigue', sessionId })
      await reconcile()
    } catch (err) {
      patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }, [patch, reconcile])

  /**
   * 回答一次审批请求（允许 / 拒绝）。
   *
   * `approvalId` 取自**投影**（不取自界面自己的临时状态）：投影是真相，而且能保证
   * 我们回答的**正是当前那一次** —— 迟到的点击不会误批准后来的一次请求。
   */
  const pendingApprovalId = state.approval?.approvalId ?? null

  const approve = useCallback(
    async (granted: boolean) => {
      const sessionId = sessionRef.current
      if (sessionId === null || pendingApprovalId === null) return
      try {
        await runCommand({ type: 'approve', sessionId, approvalId: pendingApprovalId, granted })
        await reconcile()
      } catch (err) {
        patch({ error: err instanceof Error ? err.message : String(err) })
      }
    },
    [patch, reconcile, pendingApprovalId],
  )

  return { ...state, send, stop, acknowledge, setMode, resetFatigue, approve }
}
