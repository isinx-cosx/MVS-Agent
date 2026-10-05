/**
 * 上下文压缩的契约。
 *
 * ## 为什么压缩必须写进日志
 *
 * 我们立过一条铁律：**日志必须能重建出与当时逐字相同的消息数组**，
 * 否则 resume 之后模型看到的是另一段历史（这个 bug 我们真踩过一次）。
 *
 * 压缩会改变消息数组，所以它**不能只是内存里的动作**——它是一次状态转换，
 * 必须落盘。`rebuildMessages` 遇到 `context_compacted` 事件时直接用事件里
 * 携带的数组**整体替换**，这样「内存里的」和「重建出来的」永远一致。
 *
 * 代价是日志会大一点（事件里带完整数组）。但**日志里允许有冗余，不允许有歧义**。
 *
 * ## 触发条件：即将超出，而不是「有点大了」
 *
 * 压缩是**有损的**，所以它不该是个常备动作，只该在**真的快装不下时**发生。
 * 由此推出两条：
 *
 * 1. **预算必须从模型真实的上下文窗口推导**，不能是一个写死的常量。
 *    写死 96k 对 32k 窗口的模型是「还没触发就爆了」，对 1M 窗口的模型是
 *    「好端端地就开始丢历史」——两个方向都错。
 * 2. **触发线要贴近上限**（默认 90% 的可用预算），而不是一过半就动手。
 *
 * ## 两条不能违反的约束
 *
 * 1. **工具调用与结果必须成对** —— 丢掉 assistant 的 toolCalls 却留下 tool 结果
 *    （或反过来），接口会直接报错。所以只能在**轮次边界**上切，不能从中间切。
 * 2. **最近的轮次永远不动** —— 压缩的是历史，不是当下正在处理的上下文。
 */

import type { Message } from '../model/types.ts'

export interface CompactionOptions {
  /**
   * 模型的上下文窗口大小（token）。
   *
   * ⚠️ **必须与所选模型匹配，我们猜不出来。** 猜大了会在运行中报错，
   * 猜小了会无谓地丢历史。命令行有 `--context-window` 可以覆盖。
   */
  windowTokens: number
  /**
   * 为**输出**预留多少 token。
   *
   * 上下文窗口是「输入 + 输出」的总量，所以要留出回复的空间，
   * 否则会出现「输入刚好塞满、模型没有位置说话」这种最糟的情况。
   */
  outputReserveTokens: number
  /**
   * 超过**可用预算**的这个比例才触发压缩。
   *
   * 默认 0.9 —— 意思是「即将超出」而不是「有点大了」。
   */
  triggerRatio: number
  /** 至少保留最近多少个「轮」原封不动 */
  keepRecentTurns: number
  /** 单个工具结果超过多少字符就裁剪 */
  toolResultThresholdChars: number
  /** 裁剪时保留的开头字符数 */
  toolResultHeadChars: number
  /** 裁剪时保留的结尾字符数 */
  toolResultTailChars: number
}

/** 可用预算 = 窗口 − 输出预留 */
export function usableBudget(options: CompactionOptions): number {
  return Math.max(0, options.windowTokens - options.outputReserveTokens)
}

/** 触发线。超过它才压缩 */
export function triggerThreshold(options: CompactionOptions): number {
  return Math.floor(usableBudget(options) * options.triggerRatio)
}

/**
 * 保守的默认值。
 *
 * 窗口刻意取小（32k）：**默认值的作用是「不要因为猜错而炸掉」**，
 * 而不是「尽量少压缩」。用户知道自己模型的窗口，我们的职责是逼他显式声明。
 *
 * 工具结果裁剪的三个数字取自本机运行的 DSH 的 `compaction-tool-result-pruner`
 * 配置（`8192 / 4096 / 1024`）—— 这几个数字是被实际跑过的，不是拍的。
 */
export const DEFAULT_COMPACTION: CompactionOptions = {
  windowTokens: 32_768,
  outputReserveTokens: 4_096,
  triggerRatio: 0.9,
  keepRecentTurns: 4,
  toolResultThresholdChars: 8_192,
  toolResultHeadChars: 4_096,
  toolResultTailChars: 1_024,
}

/** 常见模型的窗口大小，供命令行预设用。**不是权威数据，只是省事** */
export const KNOWN_WINDOWS: Record<string, number> = {
  'deepseek-chat': 64_000,
  'deepseek-reasoner': 64_000,
  'gpt-4o': 128_000,
  'qwen2.5:7b': 32_768,
  'qwen2.5:14b': 32_768,
  'llama3.2': 131_072,
}

export type CompactionAction =
  /** 把超大工具结果换成「开头 + 结尾 + 标记」 */
  | {
      kind: 'prune-tool-result'
      toolCallId: string
      originalChars: number
      keptChars: number
    }
  /** 丢掉最老的若干轮 */
  | { kind: 'drop-turns'; droppedTurns: number; droppedMessages: number }

export interface CompactionResult {
  messages: Message[]
  /** 空数组表示这次没有压缩 */
  actions: CompactionAction[]
  tokensBefore: number
  tokensAfter: number
  /**
   * 压缩之后**仍然**超出可用预算。
   *
   * 出现这种情况说明受保护的最近几轮本身就太大（它们不参与裁剪）。
   * 调用方应当**警告**而不是拒绝调用：我们的估算偏保守，
   * 真正说了算的是模型服务端，不该拿一个启发式去挡掉本来能成的请求。
   */
  stillOverBudget: boolean
}
