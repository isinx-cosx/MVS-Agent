/**
 * 跨边界的契约：host 与客户端之间唯一的接口。
 *
 * 两条纪律，取自 DSH 的 host/client 划分：
 *
 * 1. **客户端不持有任何权限。** 它只渲染投影、回答提示。所有判定在 host。
 * 2. **客户端读的是「投影」，不是原始状态。** 迟到加入时拿一份投影，
 *    再订阅后续事件——不需要重放全部历史（那是事件溯源，我们不欠这个债）。
 *
 * 事件同时是**追加日志的格式**，所以它有一处硬约束：
 * **所有字段必须是可无损 JSON 序列化的。** 不允许塞活对象、函数、Map。
 */

import type { Message, ToolCall, Usage } from '../model/types.ts'
import type { Decision, PermissionMode } from '../policy/types.ts'
import type { CompactionAction } from '../context/types.ts'

/**
 * 权限模式是协议的一部分（`session_started`、`set_mode`、会话摘要里都带着它），
 * 所以这里把它**转出去**：客户端只需要认识协议这一个入口，不该为了拿一个模式
 * 的联合类型去翻 `src/policy/`。
 */
export type { PermissionMode }
/**
 * `Message` 也要转出去：`SessionProjection.messages` 就是它，客户端要按它推时间线
 * 就得能取到这个类型。和 `PermissionMode` 同一个理由 —— 客户端只该认识协议这一个
 * 入口，不该为了拿一个类型去翻 `src/model/`。
 */
export type { Message }

// ---------------------------------------------------------------------------
// 服务端 → 客户端
// ---------------------------------------------------------------------------

export type HostEvent =
  | { type: 'session_started'; workspace: string; model: string; mode: PermissionMode }
  | { type: 'turn_started'; turn: number; input: string }
  | { type: 'step_started'; turn: number; step: number }
  /** 流式文本。**不进日志**——日志只记最终消息，否则日志会被 token 撑爆 */
  | { type: 'model_text_delta'; text: string }
  | { type: 'model_reasoning_delta'; text: string }
  /**
   * 助手消息。
   *
   * **刻意带上完整的 toolCalls 而不是一个数量。** 日志必须能重建出
   * 与当时**逐字相同**的消息数组 —— 否则 resume 之后送给模型的上下文
   * 和中断前不一样，模型看到的就是另一段历史。
   * 日志里允许有冗余，不允许有歧义。
   *
   * ## `reasoning` 为什么要**落盘**（不像 `model_reasoning_delta` 那样只在线上推）
   *
   * 那两个是**不同用途**的东西，不是重复：
   *
   *   · `model_reasoning_delta` —— 逐 token 的在线增量。落盘会把日志撑爆，
   *     而且它是**同一段内容的一部分**，恢复时没有任何用处。
   *   · 这个 `reasoning` —— 那一段思考的**完整文本**，一条消息一份。
   *     界面靠它把「模型当时想了什么」画出来；重开会话也要能再看到。
   *
   * 不落盘的话，用户切走再切回来思考就没了 —— 而那是模型输出的一部分，
   * 不是缓存。
   */
  | { type: 'assistant_message'; text: string; reasoning?: string; toolCalls: ToolCall[] }
  /** 策略判定：这次调用被允许 / 被拒 / 需要人确认 */
  | { type: 'policy_decision'; callId: string; tool: string; decision: Decision; reason: string; message: string }
  | { type: 'approval_requested'; approvalId: string; callId: string; tool: string; argsJson: string; message: string }
  | { type: 'approval_resolved'; approvalId: string; granted: boolean }
  /**
   * 工具**即将**执行。**必须先于执行落盘。**
   *
   * 这是恢复能力的全部基础：如果进程死在执行中途，
   * 我们会看到「有 tool_intent、没有 tool_settled」——
   * 那就是「状态未知」，只能问人。猜「跑过了」会漏，猜「没跑过」会重跑非幂等操作。
   */
  | { type: 'tool_intent'; callId: string; tool: string; argsJson: string }
  /**
   * 工具结算。
   *
   * `content` 是回填给模型的原文（不是摘要）——理由同 `assistant_message`：
   * 日志要能重建出当时真正送进模型的那个消息数组。
   * `summary` 只是给人看的。
   */
  | {
      type: 'tool_settled'
      callId: string
      tool: string
      ok: boolean
      content: string
      summary: string
      recoveryTxnId?: string
    }
  | { type: 'step_finished'; turn: number; step: number; finishReason: string }
  /**
   * 上下文压缩发生了。**这是一次状态转换，不是一个提示。**
   *
   * 它携带**压缩后的完整消息数组**，`rebuildMessages` 遇到它整体替换。
   * 这样「内存里的」和「从日志重建出来的」永远一致 ——
   * 否则 resume 之后模型看到的会是压缩前的那段历史。
   *
   * 完整数组让日志变大，但**日志里允许有冗余，不允许有歧义**。
   */
  | {
      type: 'context_compacted'
      messages: Message[]
      actions: CompactionAction[]
      tokensBefore: number
      tokensAfter: number
    }
  /**
   * 撤销落地了。
   *
   * 撤销**不是模型那一轮的一部分** —— 它是人在看完结果之后按的按钮。但它必须
   * 落盘：否则刷新页面之后「我撤过没有」就没有答案了，而用户会再按一次。
   * 落在这个会话的日志里是合适的：它就是「这个会话的用户做过这件事」。
   */
  | ({ type: 'revert_settled' } & RevertOutcome)
  | { type: 'turn_finished'; turn: number; status: SessionStatus }
  | { type: 'notice'; code: string; message: string }
  | { type: 'error'; message: string }

/**
 * 一次撤销的结果。
 *
 * 形状照着恢复层的 `RestoreReport` 来，但在这里**重新声明**：协议不该反向
 * 依赖恢复层的内部类型。`skipped` 和 `notCovered` 是必须传到界面的两个字段 ——
 * 撤销「大部分成功」和「全部成功」是完全不同的两件事，只报一个 `ok` 会让用户
 * 以为文件回到了原样，而实际上有的没回去。
 */
export interface RevertOutcome {
  /** 被撤销的那次工具事务 */
  txnId: string
  /** 撤销动作自身也是一个事务，可以用它再撤回去（null = 没能建立） */
  restoreTxnId: string | null
  ok: boolean
  message: string
  restored: string[]
  deleted: string[]
  /** 明确没动的文件及原因（比如之后被改过 —— 拒绝覆盖别人的工作） */
  skipped: Array<{ path: string; reason: string }>
  /** 这次撤销**管不到**的类别（快照盲区），必须显示给用户 */
  notCovered: string[]
}

/**
 * 列表里的一次可撤销事务。
 *
 * 只带**计数**不带完整路径数组：界面在列表里要显示的是「改了 3 个文件」，
 * 而一次大改动的路径数组可以有几千条 —— 为了一个数字把整个索引撑大不划算。
 * 真要逐条看路径，那是在按了撤销之后的报告里。
 */
export interface TransactionSummary {
  id: string
  tool: string
  summary: string
  startedAt: string
  finishedAt: string
  added: number
  modified: number
  removed: number
  /** 若这次事务本身是一次恢复，指向被恢复的那次 */
  restoredFrom?: string
}

/** 只用于实时推送、不落盘的事件 */
export const EPHEMERAL_EVENTS = new Set<HostEvent['type']>([
  'model_text_delta',
  'model_reasoning_delta',
])

// ---------------------------------------------------------------------------
// 客户端 → 服务端
// ---------------------------------------------------------------------------

/**
 * 客户端发来的命令。
 *
 * ⚠️ **每条命令都带 sessionId（除索引类）。** 多会话之后，一条不带目标的
 * 「发消息」是歧义的；而事后往协议里补字段会波及所有客户端代码。
 */
export type ClientCommand =
  // ── 会话级 ──
  | { type: 'user_message'; sessionId: string; text: string }
  | { type: 'approve'; sessionId: string; approvalId: string; granted: boolean }
  | { type: 'abort'; sessionId: string }
  | { type: 'set_mode'; sessionId: string; mode: PermissionMode }
  /**
   * 人明确要求恢复自动放行（清掉抗疲劳熔断）。
   *
   * 熔断器是一道**单向门**：命中的前提就是「人在连续打回」，所以此刻的「允许」
   * 正是我们不再信任的那个动作，不能在放行时自动解除。代价是它必须有一个明确
   * 的出口，否则用户只会去重启进程 —— 而重启会把整套记账一起清掉。
   */
  | { type: 'reset_fatigue'; sessionId: string }
  /**
   * 撤销某次工具调用造成的文件改动。
   *
   * 带 `sessionId` 是因为撤销要落到某个会话的日志里（那条日志是界面唯一能看到
   * 的持久流）。真正执行的是**工作区**的恢复层 —— 会话和工作区是多对一的。
   *
   * `force` 对应恢复层的冲突策略：默认拒绝覆盖「之后又被改过」的文件，
   * 只有人明确选了「就是我改的，覆盖掉」才传 true。
   */
  | { type: 'revert'; sessionId: string; txnId: string; force?: boolean }
  /**
   * **人确认了那次结果未知的工具调用，允许这个会话继续。**
   *
   * ## 为什么这条命令必须存在
   *
   * `interrupted` 是一道**闸门**：上次有个工具调用没结算（进程就是在那里没的），
   * 副作用有没有发生**没人知道**，于是这个会话拒绝开新回合。
   *
   * 闸门本身是对的 —— 不许猜。但它必须有一道**门**，否则这个会话永久不可用：
   * 发消息返回 `ok:true`、界面却毫无反应。实测就是这样卡住了一个会话
   * （`2828d5a6`，工具是 `run_command`），而人在界面上找不到任何出口。
   *
   * ⚠️ **这条命令只表示"我知道了，继续"，不表示"就当它执行过了"。**
   * 副作用究竟有没有发生要人来判断；真正跑了一半的情况由恢复层的快照兜底。
   * （`session.acknowledgeInterrupted()` 的注释里也是这个意思。）
   */
  | { type: 'acknowledge_interrupted'; sessionId: string }
  // ── 索引级 ──
  | { type: 'open_workspace'; path: string }
  | { type: 'close_workspace'; path: string }
  | { type: 'create_session'; workspace: string; title?: string }
  | { type: 'rename_session'; sessionId: string; title: string }
  | { type: 'delete_session'; sessionId: string }
  /**
   * 声明「我正在看这些会话」。
   *
   * 服务端据此裁剪高频事件：**索引类状态（谁在等我）全部推，
   * token 级增量只推正在看的**。没有这条，多会话下每开一个标签页
   * 都会收到其他会话的逐字流，纯属浪费。
   */
  | { type: 'watch'; sessionIds: string[] }
  // ── 配置 ──
  | { type: 'set_config'; config: unknown }
  /**
   * **一个会话**选中一个模型 —— DSH 的 `modelSelection` 语义。
   *
   * ⚠️ **它和 `set_config` 的区别是本质的，别把两条合并：**
   *
   *   · `set_config` 改**进程级配置**（所有会话都跟着变）
   *   · 这条只改**那一个会话**（DSH 的设计里选择是会话级的，由该会话自己的
   *     `model/selection` 事件推导）
   *
   * 以前界面里选模型走的是 `set_config` —— 于是在一个会话里选个模型会把
   * 所有会话都改掉，而且用户在界面上看不出发生了什么。
   */
  | { type: 'select_model'; sessionId: string; provider: string; model: string }

// ---------------------------------------------------------------------------
// 投影
// ---------------------------------------------------------------------------

export type SessionStatus =
  | 'idle'
  /** 正在跑 */
  | 'running'
  /** 卡在等人工确认 */
  | 'awaiting-approval'
  /**
   * 上次退出时留下了一个未结算的工具调用 —— 状态未知，必须问人。
   * 这是恢复流程唯一有实质难度的分支。
   */
  | 'interrupted'
  | 'error'

export interface PendingApproval {
  approvalId: string
  callId: string
  tool: string
  argsJson: string
  message: string
}

/**
 * 客户端迟到加入时读的东西。
 *
 * `messages` 由事件重建，`lastSeq` 之后的事件靠订阅接上 —— 两者拼起来就是完整视图。
 */
export interface SessionProjection {
  sessionId: string
  workspace: string
  /**
   * 这个会话**将要**用的模型名。
   *
   * ⚠️ 有会话级选择时它是**选择值**（不是"上次调用用过的那个"）——
   * 后者只在模型调用时更新，刚选完还没发消息时会滞后 ✗。
   */
  model: string
  /**
   * **这个会话选中的模型**（DSH 的 `modelSelection` 语义：会话级、持久）。
   *
   * 宿主把它一并告诉客户端 ✓ —— 客户端不该自己去猜"全局默认是什么" ✗。
   * 我一度就是这么猜的（铭牌只读全局生效的供应商 ✗），后果是**每个会话都显示
   * MVS Agent** ✓ —— 与"切了模型切走再回来又变回去"是同一个症状 ✓。
   *
   * 没选过时**不带这个字段**（= 用进程默认 ✓）。
   */
  modelSelection?: { provider?: string; model: string }
  mode: PermissionMode
  status: SessionStatus
  turn: number
  step: number
  messages: Message[]
  /** 当前上下文的估算 token 数（**估算，不是分词**）。UI 用它显示进度条 */
  contextTokens: number
  /** 配置的模型上下文窗口。**不是探测出来的，是用户声明的** */
  contextWindowTokens: number
  /** 可用预算 = 窗口 − 输出预留。进度条的分母是它，不是窗口 */
  contextBudgetTokens: number
  /**
   * 估算的校准状态。
   *
   * 我们拿不到分词器，但每次调用的 `usage.prompt_tokens` 是真实的——
   * 用真实值去除自己的估算，就能让估算**收敛到那家模型的分词器**。
   */
  contextCalibration: { factor: number; samples: number }
  pendingApproval: PendingApproval | null
  /** 未结算的工具调用（中断遗留） */
  interruptedCall: { callId: string; tool: string; argsJson: string } | null
  /**
   * **最近一次**模型调用的用量（不是历史，每次调用覆盖）。
   *
   * 界面靠它显示两件只有引擎才知道的事：
   *   · 提示缓存命中率（`cachedTokens / inputTokens`）
   *   · 真实的生成速度（`tokensPerSecond`）
   *
   * 端点不给（非 llama.cpp 之类的服务可能没有）时**整个字段缺席** —— 缺了就是
   * "不知道"，界面显示 `—`，而不是拿 0 冒充"没命中"。
   */
  lastUsage?: Usage
  /**
   * 抗疲劳熔断器状态。
   *
   * **必须传出来。** 一旦命中，之后每次写文件和执行命令都会被降级成「要你
   * 确认」，而如果不解释，用户只会觉得这个软件突然变得很烦 —— 然后去点更多次
   * 「允许」，恰好是熔断器想阻止的那件事。
   *
   * 它是一道单向门（只有人明确复位才解除，见 `Policy.resetFatigue`），所以
   * 界面必须同时给出**原因**（计数）和**出口**（复位按钮）。
   */
  fatigue: { active: boolean; consecutiveBlocks: number; totalBlocks: number }
  /**
   * 这个会话里每次工具调用的结算结果，以及它现在的撤销状态。
   *
   * 为什么不从 `messages` 推？`rebuildMessages` 只保留 `tool_settled.content`
   * （那是回填给模型的原文），**ok 和 summary 都不在里面**。所以刷新页面之后，
   * 光看消息数组画出来的卡片会退化成「一坨文本」，既没有成功/失败，也没有撤销
   * 按钮 —— 而工具卡是这个界面的主角，退化了就等于不能用。
   *
   * 每次调用一条，包括没动文件的那种（它们只是 `undoTxnId` 为 null）。
   */
  toolCalls: ToolCallRecord[]
  lastSeq: number
}

/**
 * 一次工具调用的结算结果与撤销状态。
 *
 * 撤销这部分是个小状态机，值得说清楚：
 *
 * - 撤销事务 `T` 会**新建**一个事务 `R`（恢复本身也必须可恢复）。
 * - 所以撤销 `T` 之后，要让文件回到「改完」的样子，就该去撤销 `R`。
 *
 * `undoTxnId` 因此不是「当初那个事务」，而是**现在要翻转这次调用该撤销哪个**。
 * 它会在 `T`、`R`、`R2`… 之间来回换，而 `reverted` 标明当前文件状态落在哪一边。
 * 界面据此把按钮画成「撤销」或「重做」，不需要自己推这个链。
 */
export interface ToolCallRecord {
  callId: string
  tool: string
  ok: boolean
  summary: string
  /** 现在撤销它就能翻转这次调用的文件改动；null = 没有可撤销的改动，或已经翻不动了 */
  undoTxnId: string | null
  /** 文件状态是否已经回到这次调用**之前** */
  reverted: boolean
}

// ---------------------------------------------------------------------------
// 信封与索引
// ---------------------------------------------------------------------------

export interface Envelope {
  /**
   * ⚠️ 多会话之后这是必需的。
   *
   * 没有它，客户端收到一个 `model_text_delta` 时**不知道是谁在说话**——
   * 而侧栏要判断「哪个会话在等我」也全靠它。
   */
  sessionId: string
  /**
   * 该会话内单调递增的落盘序号。
   *
   * ⚠️ **不要把 seq 当成唯一 id 或去重键。** 有两类事件不带自己的序号：
   *
   *  - **流式增量**（`EPHEMERAL_EVENTS`）：它们不落盘，所以带的是**当前**
   *    序号 —— 同一段时间里连发的几条 delta 会共用同一个 seq。
   *  - **服务端补的旁路事件**（比如 `sendUserMessage` 抛错时广播的 `error`）：
   *    它没落盘，借的是当前序号。
   *
   * 按 seq 去重会把这些内容丢掉。seq 的用途只有一个：**断档检测** ——
   * `seq > lastSeq + 1` 说明中间有事件没收到，此时客户端必须重新拉一份投影，
   * 而不是在已经错的状态上继续叠加。重复的 seq 不构成断档，这正是我们要的。
   */
  seq: number
  at: string
  event: HostEvent
}

export interface WorkspaceSummary {
  /** 规范化（realpath）后的绝对路径。**去重和显示都用它** */
  path: string
  /** 目录名，给侧栏用。**不是身份**，重名无所谓，路径才是身份 */
  name: string
  sessionCount: number
  /** 该工作区下最紧急的状态，用于折叠时把信号上浮 */
  alert: SessionAlert
  addedAt: string
  lastOpenedAt: string
}

/**
 * 侧栏用的「需要你」信号。
 *
 * 优先级：**等确认 > 中断未结算 > 正在跑**。
 * 正在跑的不需要你，等确认的才需要 —— 侧栏的作用是把该你出手的事顶到眼前，
 * 不是报告活动量。
 */
export type SessionAlert = 'needs-approval' | 'interrupted' | 'running' | 'none'

export interface SessionSummary {
  sessionId: string
  workspace: string
  /** 默认取第一条用户消息的前若干字，可手动改。**不含工作区前缀** —— 嵌套已说明归属 */
  title: string
  status: SessionStatus
  alert: SessionAlert
  turn: number
  step: number
  /** 在等确认时，等的是什么工具 */
  pendingTool?: string
  /** 中断未结算时，是哪个工具 */
  interruptedTool?: string
  createdAt: string
  updatedAt: string
}

export function alertOf(status: SessionStatus): SessionAlert {
  if (status === 'awaiting-approval') return 'needs-approval'
  if (status === 'interrupted') return 'interrupted'
  if (status === 'running') return 'running'
  return 'none'
}

/** 折叠工作区时把子会话最紧急的信号上浮。**否则折叠就等于把提醒藏起来** */
export function worstAlert(alerts: readonly SessionAlert[]): SessionAlert {
  const order: SessionAlert[] = ['needs-approval', 'interrupted', 'running', 'none']
  for (const level of order) {
    if (alerts.includes(level)) return level
  }
  return 'none'
}

/**
 * 索引状态。
 *
 * **索引变化时整份推送，不做增量事件** —— 索引很小（工作区 + 会话摘要），
 * 而变化很罕见。这样就不必发明一整套索引事件类型，也少了一整类
 * 「增量对不上」的 bug。
 *
 * 会话的**内容**才是高频的，那部分走 `Envelope` 增量。
 */
/**
 * 设置面板要显示的东西。**打码后的配置 + 若干只读诊断信息。**
 *
 * ⚠️ 这个类型刻意定义在协议里，而**不是**直接复用 `src/config/types.ts` 的
 * `MaskedConfig`。两条理由：
 *
 * 1. 协议是客户端唯一该依赖的东西。让界面直接引用服务端配置模块的类型，等于把
 *    「配置长什么样」变成前后端共享的内部结构，以后改配置结构就会连带改界面 ——
 *    而界面本来只需要「有哪些字段、能不能改」。
 * 2. 服务端配置模块里有可能拖进 `node:` 的东西。协议层必须始终浏览器安全
 *    （两个 tsconfig 就是为了钉住这条，两个方向都踩过坑了）。
 *
 * `apiKeySourceVar` / `apiKeyIsPlaintext` 一个都不能省：「我的 key 从哪来」和
 * 「它是不是明文躺在磁盘上」是两个不同的担忧，只给一个打码字符串，用户没法判断
 * 自己该不该去改。
 */
export interface SettingsView {
  model: {
    baseUrl: string
    model: string
    /**
     * **这个供应商下可选的全部模型**（`config.model.models`）。
     *
     * 少了它，「添加模型」的现象是：界面加出一行、保存回了成功、
     * 刷新之后**只剩一个** —— 因为读的那一侧不知道还有别的。
     * 和 `providers` 是同一类问题：**写入通、读取少一段**。
     */
    models?: string[]
    /** 打码形式，例如 `sk-…8f3a`。把**这个值原样回传**表示「密钥没改」 */
    apiKey: string
    /** 密钥是不是明文存在配置文件里 —— 界面要把这件事显示出来 */
    apiKeyIsPlaintext: boolean
    /** 当前生效的密钥来自哪个环境变量。**和「配置要求从哪读」不是一回事** */
    apiKeySourceVar?: string
    /** 显式声明的上下文窗口；没声明时由探测或保守默认决定 */
    contextWindow?: number
  }
  /** 新会话的默认权限模式。**已开的会话不受影响** —— 它有自己的模式 */
  permissions: { defaultMode: PermissionMode }
  /**
   * 压缩参数。
   *
   * ⚠️ 字段名是**照 `ContextConfig` 抄的**，不是我自己起的。第一版我写成
   * `windowTokens` / `reserveForOutput` / `compactAtRatio` —— 三个都不存在，
   * 类型检查一次性全抓出来了。这一层最怕的就是「看起来合理但和真实字段对不上」。
   *
   * 界面只显示 `triggerRatio` 和 `outputReserveTokens`（前者是「什么时候压缩」，
   * 后者决定可用预算），其余几个是给超长工具输出做截断的，属于进阶项。
   */
  context: {
    /** 用掉可用预算的多少比例就压缩 */
    triggerRatio: number
    /** 预留给模型输出的 token */
    outputReserveTokens: number
    keepRecentTurns: number
    toolResultThresholdChars: number
    toolResultHeadChars: number
    toolResultTailChars: number
  }
  /**
   * **命名的模型供应商库**（`config.providers`，密钥已打码）。
   *
   * ## 为什么要单独给这一项
   *
   * `model` 只有**当前生效**那一份 —— 模型层需要的就是它。但设置页面要的是
   * **整库**：用户得能看见、能编辑别的供应商。
   *
   * 少了这一项的现象是「加了一个供应商 → 保存成功 → 界面上看不到」，
   * 而文件里其实有。**写入那条路是通的，只是读的这条路少了一段** ——
   * 这种"一半通"最难查，因为每一步单独看都是对的。
   *
   * ⚠️ **每个供应商的 `apiKey` 都必须是打码形式。** 明文密钥永不出这个边界，
   * 和 `model.apiKey` 是同一条规矩。
   */
  providers: Record<string, ModelProviderView>
  /** `providers` 里哪一个是当前生效的。**永远有值**（没配时是 `mvs`） */
  activeProvider: string
  /**
   * 只读诊断。改不了，但排查问题时必须有 —— 用户问「我的配置到底在哪」的时候，
   * 不该让他去翻文档。
   */
  paths: { home: string; config: string }
}

/** `SettingsView.providers` 的一项。密钥已经是打码形式 */
export interface ModelProviderView {
  baseUrl?: string
  /**
   * **协议**（DSH 的 `api` 字段）：`openai-completions` / `openai-responses` /
   * `anthropic-messages`。
   *
   * ⚠️ 这一项一度被**故意丢掉**，理由是"我们的守护进程只会说 OpenAI 兼容那种，
   * 存了也没用"。那个取舍是错的：用户在下拉框里选了协议，我们丢了，
   * 然后按默认发 —— 界面显示的和实际发出去的**不是一回事**，而且没有任何一处
   * 会提示这件事。
   *
   * 存下来不等于实现了那些协议。它现在的价值是**如实往返**：界面选了什么，
   * 刷新之后还是什么，而不是每次跳回默认值。
   */
  api?: string
  /** **当前选中**的模型名 */
  model?: string
  /** 这个供应商下可选的全部模型 */
  models?: string[]
  /** 界面显示名。不填时界面用 route */
  label?: string
  /** 打码形式，例如 `sk-…8f3a` */
  apiKey?: string
  apiKeyIsPlaintext?: boolean
  apiKeyEnv?: string
  contextWindow?: number
  includeUsage?: boolean
}

export interface AppStateView {
  workspaces: WorkspaceSummary[]
  sessions: SessionSummary[]
  /**
   * 打码后的配置 + 只读诊断。**明文密钥永不出这个边界。**
   *
   * 这个字段原来标的是 `unknown`，因为写入路径还有别的东西要先落地。现在它有了
   * 明确形状：界面只依赖 `SettingsView`，不依赖服务端配置模块。
   */
  config: SettingsView
  /**
   * 上下文窗口，以及它是**怎么来的**。
   *
   * `source` 必须传出来：窗口是「用户声明的」还是「探测到的」还是「保守默认」，
   * 直接决定了压缩什么时候触发，而界面上只说一个数字等于把这件事藏起来。
   * 探测不到时用保守默认值，用户有权利知道自己在用哪个。
   */
  window: { tokens: number; source: string }
}

// ---------------------------------------------------------------------------
// WebSocket 上行帧
// ---------------------------------------------------------------------------

/**
 * 服务端推给客户端的东西。
 *
 * 三种帧对应两种更新节奏：**索引整份推**（少而小），**会话事件增量推**（多而长）。
 */
export type ServerFrame =
  /** 索引变化，或客户端刚连上。整份 */
  | { kind: 'state'; state: AppStateView }
  /** 某个会话的快照。客户端切到它、或它被新建时 */
  | { kind: 'projection'; sessionId: string; projection: SessionProjection }
  /** 会话事件增量 */
  | { kind: 'event'; envelope: Envelope }
  /**
   * **命令回执**：回应通过 WebSocket 发来的那条命令（带同一个 `id`）。
   *
   * 为什么必须有它：命令走 WS 的好处是**服务端能顺手替这条连接订阅**
   * （见 `server.ts` 的 `#handleClientMessage`），但客户端因此拿不到 HTTP 的响应体 ——
   * 没有回执，"这条命令成功了没有"就只能靠等（超时后才回落 HTTP）。
   *
   * `ok:false` 时 `message` 是**给用户看的原因**（与 HTTP 那条路同一份文案）。
   */
  | { kind: 'commandResult'; id: string; ok: boolean; message?: string; sessionId?: string }

/** 客户端建连后服务端发的第一帧 */
export type ClientFrame = ClientCommand

// ---------------------------------------------------------------------------
// 检查点
// ---------------------------------------------------------------------------

/**
 * 小而恒定，**每步原子重写**。
 *
 * 刻意**不**存消息内容：那会让每次写入变成 O(历史长度)，长任务下是 O(n²)。
 * 消息只在事件日志里追加一次，恢复时重放日志重建（一次 O(事件数)，进程启动时付一次）。
 */
export interface Checkpoint {
  sessionId: string
  workspace: string
  model: string
  mode: PermissionMode
  status: SessionStatus
  turn: number
  step: number
  /**
   * 写入本检查点时日志里已有多少条事件。
   *
   * 纯粹是**完整性校验**：启动时若实际事件数少于它，说明日志被截断过，
   * 必须报警而不是照常恢复。静默地用一个不完整的日志恢复，比不恢复更糟。
   */
  eventsSeen: number
  /** 中断遗留：有 intent 但没有 settled */
  interruptedCall: { callId: string; tool: string; argsJson: string } | null
  pendingApproval: PendingApproval | null
  updatedAt: string
}

export const CHECKPOINT_VERSION = 1

export interface CheckpointFile extends Checkpoint {
  version: number
}
