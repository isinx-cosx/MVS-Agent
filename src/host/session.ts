/**
 * 会话运行时：agent 循环 + 事件发射 + 检查点。
 *
 * ## 一次工具调用的完整顺序（顺序本身就是设计）
 *
 * ```
 * policy_decision      策略判定：放行 / 拒绝 / 问人
 *   （若是 ask）
 * approval_requested   发请求给人
 * approval_resolved    人回答了
 *   ← 注意 intent 在审批**之后**
 * tool_intent          落盘：我打算执行了
 *   ...执行...          ← 死在这里 = 有 intent 无 settled = 状态未知
 * tool_settled         落盘：结果 + 恢复事务 id
 * ```
 *
 * 两个顺序都有理由：
 *
 * - **intent 必须在执行之前** —— 否则区分不出「从没开始」和「开始了但结果丢了」。
 * - **intent 必须在审批之后** —— 否则「等人回答时崩溃」会被误报成「状态未知」，
 *   而实际上什么都没执行，白让人紧张一次。
 *
 * ## 降级而不是猜
 *
 * 恢复时遇到「有 intent 无 settled」，**不猜**。猜「跑过了」会漏掉一次本该发生的
 * 动作，猜「没跑过」会二次执行非幂等操作。唯一安全的处理是把状态标成
 * `interrupted` 并交给人 —— 而且此时**恢复层的快照还在**，真跑了一半也能撤。
 */

import { randomUUID } from 'node:crypto'
import { compact } from '../context/compact.ts'
import { TokenCalibration } from '../context/calibration.ts'
import { estimateConversationTokens, estimateTokens } from '../context/tokens.ts'
import {
  DEFAULT_COMPACTION,
  usableBudget,
  type CompactionOptions,
} from '../context/types.ts'
import { collect } from '../model/collect.ts'
import type { Message, ToolCall, Usage } from '../model/types.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { ToolContext, ToolResult } from '../tools/types.ts'
import type { JobRegistry } from '../tools/jobs.ts'
import type { WebSearchConfig } from '../config/types.ts'
import type { Policy } from '../policy/policy.ts'
import type { PermissionMode } from '../policy/types.ts'
import type { ModelClient } from '../model/types.ts'
import {
  findPendingApproval,
  findUnsettledCall,
  foldToolCall,
  rebuildMessages,
  rebuildToolCalls,
} from '../protocol/projection.ts'
import type {
  Checkpoint,
  Envelope,
  HostEvent,
  PendingApproval,
  RevertOutcome,
  SessionProjection,
  SessionStatus,
  ToolCallRecord,
} from '../protocol/types.ts'
import type { SessionStore } from './persistence.ts'

const DEFAULT_MAX_STEPS = 24

/**
 * 执行一次工具调用。
 *
 * 用结构化接口而不是直接依赖 `RecoveryGuard` 类：测试里可以注入假实现，
 * 而且以后换一个带沙箱的执行器也不用改会话。
 */
export interface ToolExecutor {
  execute(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<{ result: ToolResult; transactionId?: string }>
}

/**
 * 每次调模型前取一次当前生效的模型配置。
 *
 * 存在的意义是**让「在 UI 里改了 key / 换了模型」立刻生效**，不用重启 daemon。
 * 顺带处理一件容易漏的事：**换模型必须重置 token 校准** —— 旧系数是上一家
 * 分词器学出来的，用在新的上面只会更不准。
 */
/**
 * **一个会话选中的模型。**
 *
 * ## 为什么它必须是会话级的
 *
 * DSH 的设计里 `modelSelection` 是**每个会话**的投影，由该会话自己的
 * `model/selection` / `request/header` 事件推导
 * （`dsh-api-session-controller/lib/types/model-selection-projection.js`）。
 *
 * 而这里以前把它实现成「写全局 `config.json`」—— 于是在一个会话里选个模型，
 * 会把**所有会话**的模型都改掉，而且界面上看不出发生了什么。那正是这个功能
 * 一直"不对"的根源。
 *
 * `provider` 是 `providers` 里的 route（或垫片合成的 `mvs`，表示"用 `model` 段"）
 */
export interface ModelSelection {
  provider?: string
  model: string
}

export interface ModelProvider {
  /**
   * 取一次当前生效的模型。
   *
   * `selection` 是**这个会话**选中的模型；不传或没选过时，行为和以前一样
   * （用进程级配置）。实现方应当让选择覆盖进程级配置，而**不要去改配置文件**。
   */
  current(selection?: ModelSelection): { client: ModelClient; modelName: string; windowTokens: number }
}

export interface SessionDeps {
  sessionId: string
  workspace: string
  model: ModelClient
  modelName: string
  registry: ToolRegistry
  policy: Policy
  executor: ToolExecutor
  store: SessionStore
  /** 放在消息数组最前面的系统提示 */
  system?: string
  maxSteps?: number
  interactive?: boolean
  /** 上下文压缩参数。只覆盖你想改的字段 */
  context?: Partial<CompactionOptions>
  /**
   * 生成参数（来自后端配置）。**两个都不填就不发对应字段** ——
   * 由引擎/服务端用它自己的默认值，比我们在中间猜一个诚实。
   *
   * ⚠️ `maxTokens` 默认**不设**（无上限）：模型重复输出是模型层的事实，
   * 拿上限把它盖掉只会让人看不出模型坏了。
   */
  generation?: { temperature?: number; maxTokens?: number }
  /** 不提供时用上面固定的 model / modelName */
  modelProvider?: ModelProvider
  /**
   * 后台作业注册表。**每个工作区一份**，和恢复层同级。
   *
   * 不提供时 `run_command background=true` 会明确失败 —— 而不是静默退化成前台，
   * 那会让一个 dev server 把整轮对话卡死到超时。
   */
  jobs?: JobRegistry
  /**
   * 网络搜索的配置。**由 Runtime 从 `config.json` 读出来后注入。**
   *
   * ## 为什么不让工具自己去读配置
   *
   * 工具层读 `~/.mvs-agent/config.json` 的话，"工具能不能碰到配置文件"
   * 就变成一个**隐式依赖** —— 而这个项目里路径权限是明着设计的
   * （`resolveInsideRoot`，工作区外一律拒）。工具自己绕过那条线，
   * 等于给「代理读走自己的 API 密钥」开了个后门，而且是看起来正当的那一种。
   *
   * ## 不提供的后果（明确、不静默）
   *
   * `web_fetch` **不受影响**（它不需要密钥）；`web_search` 会明确报
   * 「没有配置搜索后端」，而不是去刮某个搜索引擎的 HTML 凑答案。
   */
  webSearch?: WebSearchConfig
}

export interface InitResult {
  resumed: boolean
  warnings: string[]
}

export class Session {
  #deps: SessionDeps
  #listeners = new Set<(envelope: Envelope) => void>()
  #messages: Message[] = []
  /** 撤销状态表，与 `#messages` 同源（都是从事件流推导），在 `#emit` 里同步更新 */
  #toolCalls: ToolCallRecord[] = []
  #status: SessionStatus = 'idle'
  #turn = 0
  #step = 0
  #interrupted: { callId: string; tool: string; argsJson: string } | null = null
  #pending: PendingApproval | null = null
  #approvals = new Map<string, (granted: boolean) => void>()
  #abort: AbortController | null = null
  #malformedEvents = 0
  #contextOptions: CompactionOptions
  /** 「压缩后仍超预算」每轮只警告一次，避免变成事件流噪音 */
  #contextWarnedThisTurn = false
  /**
   * 估算校准。
   *
   * 我们拿不到分词器，但每次调用的 `usage.prompt_tokens` 是真实的——
   * 用真实值去除自己的估算，估算就会收敛到那家模型的分词器。
   */
  #calibration = new TokenCalibration()
  /** 当前模型身份指纹。变了就重置校准 */
  #modelIdentity: string | null = null
  /**
   * **最近一次**模型调用的用量（含提示缓存命中与引擎自报速度）。
   *
   * ⚠️ 它**不是历史**，是"现在这一轮的账"：每次调用覆盖。所以它进投影
   * （像 `fatigue` / `interruptedCall` 那样是当前状态的一部分），而**不落日志** ——
   * 落盘就变成历史的一部分了，而历史里没有它的位置。
   *
   * 有了它，界面才能显示缓存命中率与真实的 token/秒，而不是只能显示上下文估算。
   */
  #lastUsage: Usage | null = null

  /**
   * **这个会话**选中的模型（DSH 的 `modelSelection` 里那份会话级意图）。
   *
   * `undefined` = 没选过 → 用进程级配置，行为和以前完全一样。
   * 它是**会话私有**的：改它**不会**碰 `config.json`，也不会影响别的会话。
   */
  #selection: ModelSelection | undefined

  /**
   * 记下这个会话选中的模型。**不落配置**、**不影响别的会话**。
   *
   * 下一次 `#callModel` 里的 `#refreshModel()` 会看到身份变了，
   * 于是重置 token 校准并发一条 `model_changed` 通知（那是既有行为）。
   */
  selectModel(provider: string, model: string): void {
    const trimmed = model.trim()
    if (trimmed === '') return
    this.#selection = { ...(provider === '' ? {} : { provider }), model: trimmed }
  }

  /** 这个会话选中的模型（没有就是 undefined）—— 供上层与投影读取 */
  selection(): ModelSelection | undefined {
    return this.#selection
  }

  constructor(deps: SessionDeps) {
    this.#deps = deps
    this.#contextOptions = { ...DEFAULT_COMPACTION, ...(deps.context ?? {}) }
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async init(): Promise<InitResult> {
    const warnings: string[] = []
    const { items: envelopes, malformed } = await this.#deps.store.readEvents()
    this.#malformedEvents = malformed
    if (malformed > 0) {
      warnings.push(`事件日志有 ${malformed} 行损坏、已跳过`)
    }

    const checkpoint = await this.#deps.store.readCheckpoint()

    // 完整性校验：静默地用一个不完整的日志恢复，比不恢复更糟
    if (checkpoint !== null && checkpoint.eventsSeen > envelopes.length) {
      warnings.push(
        `检查点记录了 ${checkpoint.eventsSeen} 条事件，日志里只有 ${envelopes.length} 条 —— 日志被截断过，恢复结果不可全信`,
      )
    }

    const events = envelopes.map((envelope) => envelope.event)
    this.#messages = rebuildMessages(events)
    this.#toolCalls = rebuildToolCalls(events)

    if (this.#deps.system !== undefined && this.#messages[0]?.role !== 'system') {
      this.#messages.unshift({ role: 'system', content: this.#deps.system })
    }

    if (checkpoint !== null) {
      this.#turn = checkpoint.turn
      this.#step = checkpoint.step
      this.#deps.policy.setMode(checkpoint.mode)
    }

    if (events.length === 0) {
      await this.#emit({
        type: 'session_started',
        workspace: this.#deps.workspace,
        model: this.#deps.modelName,
        mode: this.#deps.policy.mode,
      })
      await this.#syncCheckpoint()
      return { resumed: false, warnings }
    }

    const unsettled = findUnsettledCall(events)
    if (unsettled !== null) {
      this.#interrupted = unsettled
      this.#status = 'interrupted'
      warnings.push(
        `上次退出时有一次工具调用没有结算：${unsettled.tool} —— 它**是否执行过无法确定**，需要人确认后才能继续`,
      )
      await this.#syncCheckpoint()
      return { resumed: true, warnings }
    }

    const pendingApproval = findPendingApproval(events)
    if (pendingApproval !== null) {
      // 审批还没答进程就死了。因为 intent 写在审批之后，所以**什么都没执行**，
      // 安全的重启方式是重新问一次，而不是标成未知。
      warnings.push(`上次退出时有一个审批请求没被回答：${pendingApproval.tool}`)
    }

    return { resumed: true, warnings }
  }

  /**
   * 人确认「中断那次调用没有执行过」。
   *
   * ⚠️ 这里刻意**不提供**「就当它执行过了」的选项。那需要人来判断副作用是否已发生，
   * 而不是运行时代替人做这个判断。真正跑了一半的情况有恢复层的快照兜底。
   */
  async acknowledgeInterrupted(): Promise<void> {
    if (this.#status !== 'interrupted') return
    this.#interrupted = null
    this.#status = 'idle'
    await this.#syncCheckpoint()
  }

  // -------------------------------------------------------------------------
  // 观察
  // -------------------------------------------------------------------------

  subscribe(listener: (envelope: Envelope) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * 客户端迟到加入时读的东西。
   *
   * 消息由内存中的 `#messages` 给出（是从日志重建的），后续事件靠订阅接上。
   * 不需要重放全部历史 —— 那是事件溯源，我们不欠这个债。
   */
  projection(): SessionProjection {
    return {
      sessionId: this.#deps.sessionId,
      workspace: this.#deps.workspace,
      /*
       * ★ **这个会话选中的模型优先。**
       *
       * `#deps.modelName` 是"上次真正调用用过的那个"——它只在模型调用时更新，
       * 所以刚选完、还没发消息时会滞后。这里让**选中值**覆盖它，于是
       * `/projection` 报的就是这个会话**将要**用的模型 —— 和 DSH 的
       * `modelSelection`（`next` 优先）语义一致，而且可以据此验证会话级选择
       * 真的生效了（不用真的发一次请求）。
       */
      model: this.#selection?.model ?? this.#deps.modelName,
      /* 会话级选择一并报给客户端 —— 见 `SessionProjection.modelSelection` 的注释 */
      ...(this.#selection === undefined ? {} : { modelSelection: this.#selection }),
      mode: this.#deps.policy.mode,
      status: this.#status,
      turn: this.#turn,
      step: this.#step,
      messages: this.#messages.map((m) => ({ ...m })),
      contextTokens: this.#calibration.apply(estimateConversationTokens(this.#messages)),
      contextWindowTokens: this.#contextOptions.windowTokens,
      contextBudgetTokens: usableBudget(this.#contextOptions),
      contextCalibration: {
        factor: this.#calibration.snapshot().factor,
        samples: this.#calibration.samples,
      },
      pendingApproval: this.#pending === null ? null : { ...this.#pending },
      interruptedCall: this.#interrupted === null ? null : { ...this.#interrupted },
      /* 最近一次调用的用量（缓存命中、引擎自报速度）—— 见 `#lastUsage` 的注释 */
      ...(this.#lastUsage === null ? {} : { lastUsage: { ...this.#lastUsage } }),
      fatigue: (() => {
        const status = this.#deps.policy.status()
        return {
          active: status.fatigued,
          consecutiveBlocks: status.consecutiveBlocks,
          totalBlocks: status.totalBlocks,
        }
      })(),
      toolCalls: this.#toolCalls.map((t) => ({ ...t })),
      lastSeq: this.#deps.store.currentSeq,
    }
  }

  /**
   * 当前已落盘的事件序号。
   *
   * 给**不属于任何一轮**的事件用（比如服务端补一条旁路错误）。走 `projection()`
   * 拿 `lastSeq` 也能拿到，但那会白白复制整个消息数组 —— 和 `runtimeState()`
   * 同样的理由。
   */
  currentSeq(): number {
    return this.#deps.store.currentSeq
  }

  /**
   * 轻量状态，给侧栏的索引用。
   *
   * **刻意不返回消息数组** —— 索引每次变化都要给**全部**会话算一遍摘要，
   * 而 `projection()` 会复制整个消息数组。几十个会话下那是纯浪费。
   */
  runtimeState(): {
    status: SessionStatus
    turn: number
    step: number
    pendingTool?: string
    interruptedTool?: string
  } {
    return {
      status: this.#status,
      turn: this.#turn,
      step: this.#step,
      ...(this.#pending === null ? {} : { pendingTool: this.#pending.tool }),
      ...(this.#interrupted === null ? {} : { interruptedTool: this.#interrupted.tool }),
    }
  }

  // -------------------------------------------------------------------------
  // 驱动
  // -------------------------------------------------------------------------

  /**
   * 现在能不能接一条新的用户消息？不能的话，原因是什么。
   *
   * ## 为什么要把这个判断抽出来
   *
   * `user_message` 是**刻意不等待**的（一轮可能跑几分钟，还可能停下来等人审批，
   * 让 HTTP 响应挂在那里会把客户端一起挂住 —— 见 `server.ts` 里那段注释）。
   * 于是 `sendUserMessage` 里那个 throw 只能变成**事件流里的一条错误**，
   * 而命令本身返回 `ok:true` —— 界面看起来是"发出去了"，实际什么都没发生。
   *
   * 把判断抽出来之后，命令就能**先把话说明白**：不能接就回 `{ok:false, message}`。
   *
   * ⚠️ 消息文本与 `sendUserMessage` 里的 throw **共用这一份**，不各写一遍 ——
   * 两处文案漂移过一次（"未结算"vs"没有结算"），测试和界面就对不上了。
   */
  blockReason(): string | null {
    if (this.#status === 'running' || this.#status === 'awaiting-approval') {
      return `会话正在运行中（${this.#status}），不能并发发起新一轮`
    }
    if (this.#status === 'interrupted' && this.#interrupted !== null) {
      return `上次有一次未结算的工具调用（${this.#interrupted.tool}），状态未知，必须先由人确认才能继续`
    }
    return null
  }

  async sendUserMessage(text: string): Promise<void> {
    const blocked = this.blockReason()
    if (blocked !== null) throw new Error(blocked)

    this.#turn += 1
    this.#step = 0
    this.#contextWarnedThisTurn = false
    // ⚠️ 用户消息必须进 `#messages`。
    // 漏掉这一步会得到一个最阴险的 bug：**运行时模型看不到用户消息，
    // 重启后从日志重建才看得到** —— 运行行为和恢复行为不一致，
    // 而唯一能发现它的方式是重启一次对比。
    this.#messages.push({ role: 'user', content: text })
    await this.#emit({ type: 'turn_started', turn: this.#turn, input: text })

    const controller = new AbortController()
    this.#abort = controller

    try {
      await this.#setStatus('running')
      await this.#runLoop(controller.signal)
      await this.#settleStatusAfterLoop()
    } catch (err) {
      await this.#emit({ type: 'error', message: messageOf(err) })
      await this.#setStatus('error')
    } finally {
      this.#abort = null
      await this.#emit({ type: 'turn_finished', turn: this.#turn, status: this.#status })
      await this.#syncCheckpoint()
    }
  }

  resolveApproval(approvalId: string, granted: boolean): boolean {
    const resolve = this.#approvals.get(approvalId)
    if (resolve === undefined) return false
    this.#approvals.delete(approvalId)
    resolve(granted)
    return true
  }

  /**
   * 切换权限模式。
   *
   * ⚠️ **只由人侧调用。** 规则是：**模型可以主动降权，但只能请求提权、不能设置提权。**
   * 如果存在一个模型可调的提权通道，前面整个权限层归零。
   * 这个方法只挂在服务端命令上，绝不能被暴露成模型可用的工具。
   */
  async setMode(mode: PermissionMode): Promise<void> {
    const previous = this.#deps.policy.mode
    if (previous === mode) return
    this.#deps.policy.setMode(mode)
    await this.#emit({
      type: 'notice',
      code: 'mode_changed',
      message: `权限模式：${previous} → ${mode}`,
    })
    await this.#syncCheckpoint()
  }

  /**
   * 记一次策略结果，并在**刚好打开熔断器**时发一条通知。
   *
   * 只在状态跳变的那一次发事件：每次被拦都发会把事件流刷满，而真正需要被看见的
   * 是「从这一刻起，所有写和命令都要你确认了」——那句话只说一次才有分量。
   */
  async #observePolicy(outcome: 'allowed' | 'blocked'): Promise<void> {
    if (!this.#deps.policy.observe(outcome)) return
    const status = this.#deps.policy.status()
    await this.#emit({
      type: 'notice',
      code: 'fatigue_paused',
      message:
        `已暂停自动放行：连续被拦 ${status.consecutiveBlocks} 次（累计 ${status.totalBlocks} 次）。` +
        '这通常意味着你正在连着打回好几次 —— 从现在起写文件和执行命令都要你逐个确认。' +
        '读操作不受影响。确认你确实在看着，可以恢复自动放行。',
    })
  }

  /**
   * 人明确要求恢复自动放行。
   *
   * 这是离开熔断状态的**唯一**入口。它必须存在：没有出口的锁只会训练人去绕过它
   * ——而唯一的绕行方式是重启进程，那反而把整套记账一起清掉了。
   */
  async resetFatigue(): Promise<boolean> {
    if (!this.#deps.policy.status().fatigued) return false
    this.#deps.policy.resetFatigue()
    await this.#emit({
      type: 'notice',
      code: 'fatigue_reset',
      message: '已恢复自动放行（人确认）。计数清零，重新开始累计。',
    })
    return true
  }

  abort(): boolean {
    if (this.#abort === null) return false
    this.#abort.abort()
    return true
  }

  /**
   * 记一次撤销。
   *
   * 会话**不执行**撤销 —— 恢复层是每个工作区一份，执行由 Runtime 负责。
   * 这里只负责把它写进这个会话的日志：那条日志是界面唯一能看到的持久流，
   * 撤销不进去，刷新之后「我撤过没有」就没有答案了。
   *
   * 刻意不碰 `#messages`：撤销改的是磁盘上的文件，不是对话历史。
   * 把一条假的 assistant 消息塞进上下文，模型就会以为自己撤销过。
   */
  async recordRevert(outcome: RevertOutcome): Promise<void> {
    await this.#emit({ type: 'revert_settled', ...outcome })
  }

  // -------------------------------------------------------------------------
  // 循环
  // -------------------------------------------------------------------------

  async #runLoop(signal: AbortSignal): Promise<void> {
    const maxSteps = this.#deps.maxSteps ?? DEFAULT_MAX_STEPS

    for (;;) {
      if (signal.aborted) {
        await this.#emit({ type: 'notice', code: 'aborted', message: '已取消' })
        return
      }
      if (this.#step >= maxSteps) {
        await this.#emit({
          type: 'notice',
          code: 'step_limit',
          message: `达到步数上限 ${maxSteps}，已停止`,
        })
        return
      }

      this.#step += 1
      await this.#emit({ type: 'step_started', turn: this.#turn, step: this.#step })
      await this.#syncCheckpoint()

      const output = await this.#callModel(signal)

      /*
       * ⚠️ **这份 `Message` 和写进事件日志的那一份必须逐字一致。**
       *
       * 投影（`projection()`）返回的就是这个数组 —— 它**不是**从日志重建的。
       * 所以少带一个字段，就会造成：
       *
       *     事件日志里有 reasoning      （`#emit` 那一份带了）
       *     投影里没有                  （这一份没带）
       *     重开会话之后又有            （`rebuildMessages` 也带了）
       *
       * 于是界面上**当前会话看不到思考，切走再切回来反而看到了** ——
       * 一个只在「刚跑完」这个窗口里出现的 bug。
       *
       * 我第一版就是只改了 `#emit` 那一处，然后花了很久在客户端、
       * SSE 分帧、llama.cpp 参数上找原因 —— 因为「日志里有」让我以为链路是通的。
       * 实测复现路径：`tools/probe-client-events.mjs`（客户端正常）→
       * `tools/dump-session-events.mjs`（日志有）→ `/projection`（没有）。
       */
      const assistant: Message =
        output.toolCalls.length > 0
          ? {
              role: 'assistant',
              content: output.text,
              ...(output.reasoning.trim() === '' ? {} : { reasoning: output.reasoning }),
              toolCalls: output.toolCalls,
            }
          : {
              role: 'assistant',
              content: output.text,
              ...(output.reasoning.trim() === '' ? {} : { reasoning: output.reasoning }),
            }

      /**
       * ⚠️ **模型调用失败、且一个字都没产出时，不写 `assistant_message`。**
       *
       * 不这么做的后果是永久性的，而且一开始看不出来：
       *
       * 1. 日志里会出现一条「模型什么都没说」—— 而事实是「调用失败了」。
       *    这违反本项目的规矩：**日志里允许有冗余，不允许有歧义。**
       * 2. 更麻烦的是它会**毒化后续对话**：空 assistant 消息进了历史，
       *    下一轮原样送给模型，而 OpenAI 兼容接口对
       *    `{role:'assistant', content:''}`（且没有 tool_calls）是直接报错的。
       *    于是**一次网络抖动会让这段会话永久不可用**，而且现象是「模型一直报错」，
       *    看起来像模型或 key 的问题，不像历史里埋了一条坏消息。
       *
       * 注意判据是「失败**且**毫无产出」。流到一半断掉的那半截文本必须留下 ——
       * 它是真实产出，而且上层要能区分「没开始」和「吐了一半」。
       */
      const produced = output.text !== '' || output.toolCalls.length > 0
      /*
       * ★★ 「模型只产出了思考」这种回合**不能静默变成一条空消息**。
       *
       * ## 这里原来错在哪
       *
       * 判据是 `output.text !== '' || output.toolCalls.length > 0` ——
       * **`reasoning` 根本没被考虑**。而开了思考模式的模型（`--reasoning on`）
       * 会把整段输出放进 `reasoning_content`，`content` 在思考结束前一直是空的。
       * 于是：
       *
       *   · `produced === false`，但 `output.error === undefined`
       *   · 仍然发了一条 `text: ''` 的 assistant 消息
       *   · 它被写进 `#messages` 和事件日志
       *   · **界面上一片空白，不报错，也没有任何提示**
       *
       * 实测就是这么撞出来的：给 agent 一个需要搜索+改文件的任务，
       * 会话里只有 system + user，`step=1`、`status=idle`，看起来像「卡住了」，
       * 而实际上是一回合完整结束了、只是产出了一条空白消息。
       *
       * ## 现在的处理
       *
       * 思考内容**不冒充正文**（那是模型的草稿，不是回答），但也不能什么都不说。
       * 所以发一条 `notice` 说清楚：只有思考、没有正文，以及为什么
       * （最可能是输出预算被思考吃光了 —— `finish_reason: length`）。
       *
       * 同时**不往历史里塞空消息**：塞了的话下一轮模型会看到一条空的 assistant
       * 消息，只能自己猜那是什么意思。
       */
      const onlyReasoning =
        output.text === '' && output.toolCalls.length === 0 && output.reasoning.trim() !== ''

      if (onlyReasoning) {
        const budgetHint =
          output.finishReason === 'length'
            ? '输出预算被思考用完了（finish_reason: length）—— 回答一个字都没来得及写。'
            : `它停下来了（finish_reason: ${output.finishReason}），但没有写正文。`
        await this.#emit({
          type: 'notice',
          code: 'reasoning_only',
          message:
            `这一回合模型只产出了思考（${output.reasoning.length} 字符），没有正文。${budgetHint}` +
            `开着思考模式时输出预算要留够：思考会和正文抢同一份 token。`,
        })
        await this.#emit({
          type: 'step_finished',
          turn: this.#turn,
          step: this.#step,
          finishReason: output.finishReason,
        })
        return
      }

      if (output.error === undefined || produced) {
        await this.#emit({
          type: 'assistant_message',
          text: output.text,
          /*
           * 思考**落盘**（区别于只在线上推的 `model_reasoning_delta`）。
           *
           * 界面靠它把「模型当时想了什么」画出来，重开会话也要能再看到 ——
           * 那是模型输出的一部分，不是缓存。
           *
           * 空的就不带这个字段：`reasoning: ''` 和「没有思考」在界面上
           * 应当是同一件事，多带一个空串只会让下游多一个分支。
           */
          ...(output.reasoning.trim() === '' ? {} : { reasoning: output.reasoning }),
          toolCalls: output.toolCalls,
        })
        // ★ `#messages` 和事件日志必须**同时**推进，否则「重开会话后重建的消息
        // 数组与中断前逐字相同」这条不变量就断了。有测试钉着它。
        this.#messages.push(assistant)
      }

      if (output.error !== undefined) {
        await this.#emit({ type: 'error', message: `模型调用失败：${output.error.message}` })
      }

      if (output.toolCalls.length === 0) {
        await this.#emit({
          type: 'step_finished',
          turn: this.#turn,
          step: this.#step,
          finishReason: output.finishReason,
        })
        return
      }

      for (const call of output.toolCalls) {
        if (signal.aborted) return
        const content = await this.#invokeTool(call, signal)
        this.#messages.push({ role: 'tool', content, toolCallId: call.id })
      }

      await this.#emit({
        type: 'step_finished',
        turn: this.#turn,
        step: this.#step,
        finishReason: output.finishReason,
      })
    }
  }

  /**
   * 上下文压缩。
   *
   * 位置很关键：**在每次调模型之前**，而不是在某个固定的轮次边界上。
   * 而动手的条件是「估算 token 超过可用预算的 90%」—— 也就是**即将超出**，
   * 不是「有点大了」。压缩是有损的，不该是个常备动作。
   *
   * 压缩结果**写回 `#messages` 并落盘为一次状态转换** —— 不是每次调用临时算一份。
   * 理由：日志必须能重建出与内存逐字相同的数组；如果压缩只存在于调用时的
   * 临时变量里，resume 之后模型看到的就是压缩前的那段历史。
   */
  async #compactIfNeeded(): Promise<void> {
    const result = compact(this.#messages, this.#contextOptions, this.#calibration.factor)

    if (result.actions.length > 0) {
      this.#messages = result.messages
      await this.#emit({
        type: 'context_compacted',
        messages: result.messages,
        actions: result.actions,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
      })
    }

    // 压完还是超出（受保护的最近几轮本身就太大）→ 警告。
    //
    // **只警告，不拒绝**：我们的估算偏保守，真正说了算的是模型服务端，
    // 不该拿一个启发式挡掉本来能成的请求。
    // 每轮只警告一次，否则会变成事件流里的噪音。
    if (result.stillOverBudget && !this.#contextWarnedThisTurn) {
      this.#contextWarnedThisTurn = true
      await this.#emit({
        type: 'notice',
        code: 'context_over_budget',
        message:
          `压缩之后上下文仍约 ${result.tokensAfter} token，超出可用预算 ${usableBudget(this.#contextOptions)}` +
          `（窗口 ${this.#contextOptions.windowTokens} − 输出预留 ${this.#contextOptions.outputReserveTokens}）。` +
          `受保护的最近几轮本身就太大时会这样。可能触发服务端的上下文超限错误。`,
      })
    }
  }

  /**
   * 取一次当前生效的模型配置。
   *
   * 只在**身份变了**的时候动手 —— 端点或模型名一变就说明换了一家，
   * 那么上一家学到的 token 校准系数必须作废：**不同模型的分词器不一样**，
   * 拿旧系数套新模型只会更不准。
   */
  async #refreshModel(): Promise<void> {
    const provider = this.#deps.modelProvider
    if (provider === undefined) return

    const current = provider.current(this.#selection)
    const identity = `${current.modelName}@${current.windowTokens}`

    if (this.#modelIdentity === null) {
      this.#modelIdentity = identity
      this.#deps.model = current.client
      this.#deps.modelName = current.modelName
      return
    }
    if (identity === this.#modelIdentity) {
      // 身份没变也要换 client —— 用户可能只是改了 API key，那本该立刻生效
      this.#deps.model = current.client
      return
    }

    this.#modelIdentity = identity
    this.#deps.model = current.client
    this.#deps.modelName = current.modelName
    this.#contextOptions = { ...this.#contextOptions, windowTokens: current.windowTokens }
    this.#calibration.reset()

    await this.#emit({
      type: 'notice',
      code: 'model_changed',
      message:
        `模型已切换为 ${current.modelName}（窗口 ${current.windowTokens}）。` +
        `token 估算的校准已重置 —— 不同模型的分词器不一样，旧系数是错的。`,
    })
  }

  async #callModel(signal: AbortSignal) {
    await this.#refreshModel()
    await this.#compactIfNeeded()

    // 调用前先算一遍「我们以为这次请求有多大」，等真实 usage 回来做校准
    const schemas = this.#deps.registry.toModelSchemas()
    const estimatedForThisCall =
      estimateConversationTokens(this.#messages) + estimateTokens(JSON.stringify(schemas))

    /* 自己掐表 —— 不是所有端点都会报速度（见下面 tokensPerSecond 的兜底） */
    const callStartedAt = Date.now()

    const output = await collect(
      this.#deps.model.stream({
        model: this.#deps.modelName,
        messages: this.#messages,
        tools: schemas,
        /*
         * 生成参数从后端配置一路穿到这里。
         * `undefined` 就不进请求体 —— 模型层只在有值时写 `temperature` / `max_tokens`。
         */
        ...(this.#deps.generation?.temperature === undefined
          ? {}
          : { temperature: this.#deps.generation.temperature }),
        ...(this.#deps.generation?.maxTokens === undefined
          ? {}
          : { maxTokens: this.#deps.generation.maxTokens }),
        signal,
      }),
      {
        onEvent: (event) => {
          // 流式增量只推给在线客户端，**不落盘**（会把日志撑爆，恢复时又没用）
          if (event.type === 'text_delta') {
            this.#emitLive({ type: 'model_text_delta', text: event.text })
          } else if (event.type === 'reasoning_delta') {
            this.#emitLive({ type: 'model_reasoning_delta', text: event.text })
          }
        },
      },
    )

    // ★ 用真实 usage 校准估算。
    //
    // 这是我们在「拿不到分词器」的前提下能拿到的最好的东西：
    // 端点告诉我们这次真实输入了多少 token，我们据此修正自己的估算，
    // 于是估算会**收敛到那家模型的分词器**。
    //
    // 端点不给 usage 时 observe 会拒绝这个样本 —— 宁可不校准，也不要被 0 污染。
    if (output.usage !== undefined) {
      this.#calibration.observe(estimatedForThisCall, output.usage.inputTokens)
      /*
       * 顺手记下这份用量：界面要靠它显示缓存命中率与生成速度。
       *
       * ⚠️ **速度不能只指望端点报。** llama.cpp 会给 `timings.predicted_per_second`，
       * 但 **OpenAI / DeepSeek 这类 API 没有这个字段** —— 只认它，就等于"只有本地
       * 模型能显示速度"。所以这里自己掐表兜底：`completion_tokens ÷ 本次调用耗时`。
       *
       * 两者口径的差别要说清楚：引擎报的是**纯解码**速度，我们算的**含预填充**
       * （prompt 处理）—— 所以它偏低，是下界。宁可偏保守，也不要显示不了。
       */
      const elapsedMs = Date.now() - callStartedAt
      const measured =
        output.usage.tokensPerSecond ??
        (elapsedMs > 0 && output.usage.outputTokens > 0
          ? output.usage.outputTokens / (elapsedMs / 1000)
          : undefined)

      this.#lastUsage =
        measured === undefined ? output.usage : { ...output.usage, tokensPerSecond: measured }
    }

    return output
  }

  /** 返回回填给模型的内容 */
  async #invokeTool(call: ToolCall, signal: AbortSignal): Promise<string> {
    const tool = this.#deps.registry.get(call.name)
    // 未知工具按最危险的一档处理，不给它「因为查不到所以放行」的机会
    const risk = tool?.risk ?? 'execute'

    const verdict = this.#deps.policy.evaluate(
      { tool: call.name, risk, args: call.argsJson },
      { root: this.#deps.workspace, interactive: this.#deps.interactive },
    )

    await this.#emit({
      type: 'policy_decision',
      callId: call.id,
      tool: call.name,
      decision: verdict.decision,
      reason: verdict.reason,
      message: verdict.message,
    })

    if (verdict.decision === 'deny') {
      await this.#observePolicy('blocked')
      return await this.#settle(call, false, `被策略拒绝：${verdict.message}`)
    }

    if (verdict.decision === 'ask') {
      const granted = await this.#requestApproval(call, verdict.message, signal)
      if (!granted) {
        await this.#observePolicy('blocked')
        return await this.#settle(call, false, '人工确认未通过或被取消')
      }
      await this.#observePolicy('allowed')
    } else {
      // ★ 自动放行也要记账。
      //
      // 只在被拦时 +1，会让「连续被拦 3 次」退化成「累计 3 次」—— 因为在两次
      // 被拦之间放过多少事都不作数。而这两者完全不是一回事：偶尔被拦一下、
      // 中间干了一堆正事，和连着三次撞墙，是两种不同的信号。
      await this.#observePolicy('allowed')
    }

    // ★ intent 先于执行落盘
    await this.#emit({
      type: 'tool_intent',
      callId: call.id,
      tool: call.name,
      argsJson: call.argsJson,
    })
    // 必须真的等到落盘完成才继续 —— 否则「先写 intent」只是一句口号
    await this.#syncCheckpoint()

    const ctx: ToolContext = {
      root: this.#deps.workspace,
      signal,
      // 后台作业注册表按工作区一份，由 Runtime 注入
      ...(this.#deps.jobs === undefined ? {} : { jobs: this.#deps.jobs }),
      /*
       * 搜索配置由**会话层注入**，工具不自己去读配置文件。
       *
       * 让工具读的话，"工具能不能碰到 ~/.mvs-agent/config.json" 就变成
       * 一个隐式依赖 —— 而这个项目里路径权限是明着设计的（工作区外一律拒）。
       * 工具自己绕过那条线等于给密钥泄露开了个后门，而且是看起来正当的那种。
       */
      ...(this.#deps.webSearch === undefined ? {} : { webSearch: this.#deps.webSearch }),
    }
    const { result, transactionId } = await this.#deps.executor.execute(
      call.name,
      call.argsJson,
      ctx,
    )

    const summary = result.ok
      ? firstLine(result.content)
      : `${result.error?.kind ?? 'failed'}：${result.error?.message ?? ''}`

    await this.#emit({
      type: 'tool_settled',
      callId: call.id,
      tool: call.name,
      ok: result.ok,
      content: result.content,
      summary,
      ...(transactionId !== undefined ? { recoveryTxnId: transactionId } : {}),
    })

    return result.content
  }

  async #settle(call: ToolCall, ok: boolean, content: string): Promise<string> {
    await this.#emit({
      type: 'tool_settled',
      callId: call.id,
      tool: call.name,
      ok,
      content,
      summary: content,
    })
    return content
  }

  async #requestApproval(
    call: ToolCall,
    message: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const approvalId = `apr-${randomUUID()}`
    this.#pending = {
      approvalId,
      callId: call.id,
      tool: call.name,
      argsJson: call.argsJson,
      message,
    }

    // ★ 先注册应答通道，**再**广播审批请求。
    //
    // 反过来的话，一个反应很快的客户端会在「事件已到达」和「会话已准备好接受回答」
    // 之间那几毫秒里拿到「未知的审批 id」—— 那正是「UI 提供了操作但点了没用」的形态
    // （Claude Code #34368 就是这个病）。
    //
    // 和「intent 先于执行」是同一条原则：**让状态可见，必须晚于让处理它的机器就绪。**
    const grantedPromise = this.#waitForApproval(approvalId, signal)

    await this.#emit({ type: 'approval_requested', ...this.#pending })
    await this.#setStatus('awaiting-approval')

    const granted = await grantedPromise

    this.#pending = null
    await this.#emit({ type: 'approval_resolved', approvalId, granted })
    await this.#setStatus('running')
    return granted
  }

  #waitForApproval(approvalId: string, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false)
        return
      }

      const onAbort = (): void => {
        this.#approvals.delete(approvalId)
        resolve(false)
      }
      signal.addEventListener('abort', onAbort, { once: true })

      this.#approvals.set(approvalId, (granted) => {
        signal.removeEventListener('abort', onAbort)
        resolve(granted)
      })
    })
  }

  // -------------------------------------------------------------------------
  // 事件与检查点
  // -------------------------------------------------------------------------

  async #setStatus(status: SessionStatus): Promise<void> {
    this.#status = status
    await this.#syncCheckpoint()
  }

  /**
   * 一轮跑完之后收状态：还停在 `running` 就收成 `idle`。
   *
   * 单独抽成一个方法不只是为了好看。TS 会把进入本轮之前那次守卫判断
   * （「正在跑 / 等确认就拒绝并发」）对 `this.#status` 的收窄结果一直保留到
   * 这里 —— **方法调用不会让属性收窄失效**，而 `#setStatus` 恰恰是方法调用。
   * 于是原地写 `if (this.#status === 'running')` 会被判成「两个类型没有重叠，
   * 判断永不成立」，而运行时它明明刚被设成 `running`。
   *
   * 换个函数边界，读到的就是当场的真实值，而不是进入本轮之前的旧推论。
   */
  async #settleStatusAfterLoop(): Promise<void> {
    if (this.#status === 'running') await this.#setStatus('idle')
  }

  async #emit(event: HostEvent): Promise<Envelope | null> {
    const envelope = await this.#deps.store.append(event)
    if (envelope === null) return null
    // 撤销状态和消息数组一样，都是「从事件推导出来的视图」，所以在同一个漏斗里
    // 更新。放在这里而不是各个产出点，是为了保证「日志里记了什么」和「内存里算了
    // 什么」永远不会分家 —— 分家之后 refresh 出来的界面才是对的，而在线界面是错的。
    foldToolCall(this.#toolCalls, event)
    for (const listener of this.#listeners) listener(envelope)
    return envelope
  }

  /**
   * 只推给在线客户端，不落盘。
   *
   * ⚠️ 带的是**当前**序号，不是新序号 —— 同一段时间里连发的几条流式增量会
   * 共用同一个 seq。这是刻意的（本地补一个计数器会让它和落盘事件的序号空间
   * 混在一起），代价是 **seq 不能当去重键用**。详情见 `Envelope.seq` 的注释。
   */
  #emitLive(event: HostEvent): void {
    const envelope: Envelope = {
      sessionId: this.#deps.sessionId,
      seq: this.#deps.store.currentSeq,
      at: new Date().toISOString(),
      event,
    }
    for (const listener of this.#listeners) listener(envelope)
  }

  async #syncCheckpoint(): Promise<void> {
    const checkpoint: Checkpoint = {
      sessionId: this.#deps.sessionId,
      workspace: this.#deps.workspace,
      model: this.#deps.modelName,
      mode: this.#deps.policy.mode,
      status: this.#status,
      turn: this.#turn,
      step: this.#step,
      eventsSeen: this.#deps.store.currentSeq,
      interruptedCall: this.#interrupted,
      pendingApproval: this.#pending,
      updatedAt: new Date().toISOString(),
    }
    await this.#deps.store.writeCheckpoint(checkpoint)
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > 120 ? `${line.slice(0, 120)}…` : line
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
