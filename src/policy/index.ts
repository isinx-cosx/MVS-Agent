/**
 * 权限层组装点。
 *
 * 与工具层、恢复层同样的边界纪律：**这条路径不接给模型。**
 * 只有人工调用入口和以后的执行循环能用它。
 */

import { Policy, matchKey, normalizeArgs } from './policy.ts'
import { MODES } from './types.ts'
import type {
  Decision,
  PermissionMode,
  PolicyContext,
  PolicyOptions,
  PolicyReason,
  PolicyRequest,
  PolicyRule,
  PolicyStatus,
  PolicyVerdict,
  Precedence,
} from './types.ts'

export { Policy, matchKey, normalizeArgs }
export {
  DEFAULT_ALLOW_RULES,
  DEFAULT_ASK_RULES,
  DEFAULT_DENY_RULES,
  DEFAULT_PROTECTED_PATHS,
  MODES,
} from './types.ts'

export type {
  Decision,
  PermissionMode,
  PolicyContext,
  PolicyOptions,
  PolicyReason,
  PolicyRequest,
  PolicyRule,
  PolicyStatus,
  PolicyVerdict,
  Precedence,
}

/**
 * 人侧的模式切换入口。
 *
 * ⚠️ 规则：**模型可以主动降权，但只能请求提权、不能设置提权。**
 * 这个函数存在的意义是给人用；如果把它暴露成模型可调的工具，整个权限层归零。
 */
export function describeMode(mode: PermissionMode): string {
  const spec = MODES[mode]
  return [
    `文件写：${spec.fileWrite === 'none' ? '禁止' : spec.fileWrite === 'workspace' ? '仅工作区' : '任意'}`,
    `命令执行：${spec.command === 'none' ? '禁止' : '允许'}`,
    `命令默认：${spec.commandDefault}`,
  ].join(' · ')
}
