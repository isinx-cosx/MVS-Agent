/**
 * 上下文层：token 估算与压缩。
 *
 * ⚠️ 这一层不接给模型 —— 它是运行时内部的策略，模型看不到也不知道。
 */

export { compact, needsCompaction, COMPACTION_MARKER } from './compact.ts'
export { TokenCalibration } from './calibration.ts'
export {
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
  describeBudget,
} from './tokens.ts'
export {
  DEFAULT_COMPACTION,
  KNOWN_WINDOWS,
  triggerThreshold,
  usableBudget,
} from './types.ts'
export type { CalibrationSnapshot } from './calibration.ts'
export type { CompactionAction, CompactionOptions, CompactionResult } from './types.ts'
