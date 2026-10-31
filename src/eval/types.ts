/**
 * 行为评估（eval）的类型。
 *
 * ## 它评估什么，不评估什么
 *
 * 单元测试守的是**代码正确性**（给定输入，函数返回什么）；这里守的是**行为**：
 * 给它一个真实任务，它有没有按能接受的方式做完。
 *
 * 所以断言刻意不写成"模型必须调用 X 工具"——那是把某一种解法写死。这里的断言
 * 分两类：
 *
 *   · **不变量**（每个场景都查）：这一轮真的结束了、没有挂着的工具调用、
 *     没有悬空的审批、日志能解析、改过文件就有可撤销的事务
 *   · **任务断言**（按场景声明）：最终文件内容对不对、有没有碰不该碰的东西、
 *     该不该问人类
 *
 * 第一类失败说明**产品坏了**，第二类失败说明**模型不行**。报告里分开列。
 */

export interface ScenarioExpect {
  /** 最终正文必须匹配（子串或 `/正则/`） */
  finalText?: string
  /** 至少调用过其中之一的工具 */
  toolCalled?: string[]
  /** 这些工具**一个都不许调用** */
  toolNotCalled?: string[]
  /** 这些工具**必须全部**调用过 */
  toolAllCalled?: string[]
  /** 工作区里的文件内容必须等于这个值 */
  fileContains?: Record<string, string>
  /** 这些文件必须**不存在** */
  fileMissing?: string[]
  /** 最多走几个回合（一次用户消息可能触发多轮工具） */
  maxSteps?: number
  /** 必须出现过审批请求（要被问到） */
  approvalAsked?: boolean
  /** 不许出现审批请求（该自己决定的事别问人） */
  noApproval?: boolean
}

export interface Scenario {
  id: string
  description: string
  /** 发给它的任务 */
  prompt: string
  /** 工作区里的初始文件：相对路径 → 内容 */
  files?: Record<string, string>
  /** 权限模式，默认 `workspace-write` */
  mode?: 'read-only' | 'workspace-write' | 'full-access'
  /** 单个场景的超时（毫秒），默认 120000 */
  timeoutMs?: number
  /**
   * 遇到审批时自动同意（默认 true）。
   *
   * 默认同意是为了让场景能跑完；要验"该不该问"就用 `expect.approvalAsked` /
   * `expect.noApproval`，而不是靠人工点。
   */
  autoApprove?: boolean
  expect?: ScenarioExpect
}

/** 一次场景跑下来观察到的事实。断言只读这个结构 */
export interface Observations {
  /** 最终助手正文（最后一条 assistant 消息） */
  finalText: string
  /** 这一轮调用过的工具（按顺序，含失败的那些） */
  tools: Array<{ name: string; ok: boolean; errorKind?: string }>
  /** 走过了几步（工具调用次数） */
  steps: number
  /** 会话最终状态 */
  status: string
  /** 事件里出现过几次审批请求 */
  approvals: number
  /** 工作区文件的最终内容（只取场景声明过的那些） */
  files: Record<string, string>
  /** 可撤销事务数 */
  transactions: number
  /** 日志里解析不了的行数 */
  malformed: number
  /** 有没有挂着的工具调用（不变量） */
  unsettledCall: boolean
  /** 有没有悬空的审批（不变量） */
  pendingApproval: boolean
  /** 用时（毫秒） */
  ms: number
  /** 超出预算时的说明 */
  timedOut?: boolean
}

export interface Failure {
  /** `invariant` = 产品坏了；`expectation` = 模型没做到 */
  kind: 'invariant' | 'expectation'
  message: string
}

export interface ScenarioResult {
  id: string
  description: string
  ok: boolean
  observations: Observations
  failures: Failure[]
}

export interface EvalReport {
  /** 什么时候跑的、用什么模型、什么版本 */
  meta: {
    startedAt: string
    finishedAt: string
    model: string
    profile: string
    /** 脚本化模型（自检）时为 true —— 报告里要标明，否则会被当成真实结论 */
    scripted: boolean
  }
  results: ScenarioResult[]
  summary: {
    total: number
    passed: number
    failed: number
    /** 有哪些失败是**产品**层面的 */
    invariantFailures: number
    ms: number
  }
}
