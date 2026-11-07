/**
 * 权限层的契约。
 *
 * ⚠️ 关于这个模块最重要的一句话：
 *
 * **它不依赖沙箱，也替代不了沙箱。**
 *
 * 调研里有三个 CVE（CVE-2025-54131 / CVE-2026-22708 / CVE-2026-31854）全是同一类：
 * 字符串匹配的允许列表被绕过。所以这一层能防的是**手滑**，不是对抗。
 * 任何把它当安全边界的文档或 UI 文案都是错的。
 *
 * 它的价值在于：把「模型想干的事」和「实际允许干的事」分离开，并且让每一次
 * 拒绝都是**机器可读、可解释、可测试**的。
 */

import type { RiskLevel } from '../tools/types.ts'

export type Decision = 'allow' | 'deny' | 'ask'

export type PermissionMode = 'read-only' | 'workspace-write' | 'full-access'

/**
 * 规则冲突时的裁决方式。
 *
 * - `deny-first`（默认）：deny > ask > allow，**具体程度不改变顺序**。
 *   这是 Claude Code 的模型，也是更安全的一侧——allow 规则无法从 deny 里挖例外。
 * - `most-specific`：最长 pattern 胜。这是 Roo Code 的模型，更有表达力
 *   （长 allow 可以从短 deny 里挖例外），但也更容易配错。
 */
export type Precedence = 'deny-first' | 'most-specific'

export interface PolicyRule {
  /**
   * 规则串。两种形态：
   *   `run_command`              整个工具
   *   `run_command:git status`   前缀匹配该工具的参数匹配键
   *
   * 匹配键因工具而异：`run_command` 用完整命令行，文件工具用 path。
   */
  pattern: string
  decision: Decision
  note?: string
}

/**
 * 拒绝原因是**机器可读的**。
 *
 * 这不是洁癖。Claude Code 有几类规则形状是「接受了但从不生效」的，只给一条
 * 启动警告——「看起来配了、实际没生效」比没有更危险。所以每次判定都要能说出
 * 自己为什么这么判。
 */
export type PolicyReason =
  | 'read-auto-allow'
  | 'write-inside-workspace'
  | 'write-outside-workspace'
  | 'mode-read-only'
  | 'mode-no-command'
  | 'command-default'
  | 'allow-rule'
  | 'deny-rule'
  | 'ask-rule'
  /**
   * 命令被**证明**是只读的，自动放行。
   *
   * 和 `allow-rule` 不是一回事，值得分开：规则是「人写下的偏好」，而这条是
   * 「我们论证过它没有后果」（见 `read-only.ts` 的三条硬规矩）。混成一个理由，
   * 就没法在界面上区分「按你的规则放行」和「我们确定它无害」了。
   */
  | 'read-only-command'
  /** 熔断器：写保护路径 —— allow 规则无权批准 */
  | 'protected-path'
  /** 熔断器：删除关键路径 */
  | 'critical-path'
  /** 删除目标无法静态解析（含变量展开等）—— 按危险处理，绝不假设安全 */
  | 'unresolvable-delete-target'
  /** 命令里含危险替换（`$()`、反引号、`${}`、进程替换） */
  | 'dangerous-substitution'
  /** `curl … | sh` 这类管道直通解释器 */
  | 'pipe-to-shell'
  /** 删除工作区之外的东西（无限制模式下也要确认） */
  | 'delete-outside-workspace'
  /** 抗疲劳熔断：暂停自动放行 */
  | 'fatigue-downgrade'
  | 'unknown-tool'
  /** 没有人可以应答，ask 被降级为 deny */
  | 'headless-cannot-ask'

export interface PolicyVerdict {
  decision: Decision
  reason: PolicyReason
  message: string
  /** 命中的规则 pattern */
  rule?: string
  /** 熔断器剥夺了 allow 规则的批准权 */
  allowSuppressed?: boolean
  /** headless 环境下由 ask 降级而来 */
  downgradedFromAsk?: boolean
  /** 命中的熔断器（保护路径 / 关键路径）的具体对象 */
  breakerDetail?: string
}

export interface PolicyRequest {
  tool: string
  /** 来自工具注册表，不在这里猜 */
  risk: RiskLevel
  args: unknown
}

export interface PolicyContext {
  root: string
  /**
   * 是否存在可以应答的人。
   *
   * 默认 true。服务端 / `-p` / SDK 这类无人值守场景必须传 false ——
   * 那时 `ask` 会**立即降级为 deny**，而不是假装问过了。
   * Claude Code 在无从提示的环境里也是这个行为。
   */
  interactive?: boolean
}

export interface PolicyOptions {
  mode: PermissionMode
  rules?: PolicyRule[]
  precedence?: Precedence
  /** 连续被拦多少次后暂停自动放行（默认 3，取自 Claude Code） */
  fatigueConsecutive?: number
  /** 累计被拦多少次后暂停（默认 20，取自 Claude Code） */
  fatigueTotal?: number
  protectedPaths?: string[]
  interactive?: boolean
}

export interface PolicyStatus {
  mode: PermissionMode
  precedence: Precedence
  rules: number
  consecutiveBlocks: number
  totalBlocks: number
  /** 抗疲劳熔断是否已触发 */
  fatigued: boolean
  interactive: boolean
}

/**
 * 模式的能力上限。
 *
 * 注意 `command` 刻意只有两档 —— 调研结论：「执行大部分命令」在技术上不可定义，
 * 你没有办法实现一个「大部分」。所以要么不允许，要么允许，中间那档不存在。
 */
export interface ModeSpec {
  fileWrite: 'none' | 'workspace' | 'any'
  command: 'none' | 'any'
  /** 命令没有命中任何规则时的默认决策 */
  commandDefault: Decision
  /** 写工作区之外时的决策 */
  writeOutside: Decision
}

export const MODES: Record<PermissionMode, ModeSpec> = {
  'read-only': {
    fileWrite: 'none',
    command: 'none',
    commandDefault: 'deny',
    writeOutside: 'deny',
  },
  'workspace-write': {
    fileWrite: 'workspace',
    command: 'any',
    commandDefault: 'ask',
    writeOutside: 'deny',
  },
  'full-access': {
    fileWrite: 'any',
    command: 'any',
    commandDefault: 'allow',
    writeOutside: 'ask',
  },
}

/**
 * 保护路径：**allow 规则无权批准对这些路径的写入。**
 *
 * 这是 Claude Code 的「熔断器」设计，动机写在它的文档里：
 * 这个熔断器**防的是模型出错**，不是防攻击。
 * 检查发生在规则求值**之前**，所以任何 allow 规则都不能预先批准它们。
 *
 * 为什么是这些：它们能改变后续所有命令的行为（shell 启动、包管理器源、
 * MCP 配置、版本控制钩子），一旦被改，之后发生什么就说不清了。
 */
export const DEFAULT_PROTECTED_PATHS = [
  '.git',
  /*
   * MVS 自己的工作区状态：`skills/`（技能定义）与 `skills.json`（确认记录）。
   *
   * 必须保护的理由是一条**提权链**：模型写一份技能 → 用户确认一次写入 →
   * 之后这份技能**永久**改变模型的行为。比单次越权隐蔽得多，因为用户以为
   * 自己只是同意"写一个 markdown 文件"。
   *
   * `skills.json` 更要保护：它记着「哪些技能已确认」的哈希。能写它就能
   * 自己批准自己的技能，整条确认机制形同虚设。
   */
  '.mvs',
  '.config/git',
  '.vscode',
  '.idea',
  '.husky',
  '.devcontainer',
  '.mvs-agent',
  '.gitconfig',
  '.bashrc',
  '.zshrc',
  '.profile',
  '.envrc',
  '.npmrc',
  '.yarnrc',
  'bunfig.toml',
  '.bazelrc',
  'lefthook.yml',
  '.mcp.json',
]

/**
 * 出厂默认的拒绝规则。
 *
 * 只放**没有正当用途**的那几个。像 `rm` 这种 agent 会正当使用的，
 * 交给关键路径熔断器去处理，而不是一刀切禁掉——一刀切会让 agent 没法删构建产物。
 *
 * ⚠️ `git push` / `npm publish` 用的是 `ask` 而不是 `deny`：
 * 它们的后果在**远端**，本地快照恢复不了，所以必须让人看一眼。
 */
export const DEFAULT_DENY_RULES: PolicyRule[] = [
  { pattern: 'run_command:sudo ', decision: 'deny', note: '提权' },
  { pattern: 'run_command:mkfs', decision: 'deny', note: '格式化文件系统' },
  { pattern: 'run_command:diskutil eraseDisk', decision: 'deny' },
  { pattern: 'run_command:Format-Volume', decision: 'deny', note: '格式化卷' },
  { pattern: 'run_command:shutdown', decision: 'deny' },
  { pattern: 'run_command:reboot', decision: 'deny' },
  { pattern: 'run_command:Set-ExecutionPolicy', decision: 'deny', note: '改执行策略' },

  /*
   * 删除与移动：**一律拒，指向结构化工具**。
   *
   * 这些条目不是"黑名单能挡住一切"的假设 —— 它挡的是最常见的写法。
   * 真正的兜底是恢复层：工作区内的删除可以自动还原（见 guard 里的事后审计），
   * 而这里的价值是**别让它一开始就走错路**，并且把替代路径告诉模型，
   * 否则它会换着写法重试，白烧几轮。
   */
  { pattern: 'run_command:rm -', decision: 'deny', note: '要删文件请用 delete_paths（可撤销、有路径围栏）' },
  { pattern: 'run_command:rm --', decision: 'deny', note: '要删文件请用 delete_paths' },
  { pattern: 'run_command:del ', decision: 'deny', note: '要删文件请用 delete_paths' },
  { pattern: 'run_command:erase ', decision: 'deny', note: '要删文件请用 delete_paths' },
  { pattern: 'run_command:rd /', decision: 'deny', note: '要删目录请用 delete_paths（recursive: true）' },
  { pattern: 'run_command:rmdir ', decision: 'deny', note: '要删目录请用 delete_paths' },
  { pattern: 'run_command:Remove-Item', decision: 'deny', note: '要删文件请用 delete_paths' },
  { pattern: 'run_command:ri -', decision: 'deny', note: '要删文件请用 delete_paths' },
  { pattern: 'run_command:mv ', decision: 'deny', note: '要移动文件请用 move_path（可撤销）' },
  { pattern: 'run_command:move ', decision: 'deny', note: '要移动文件请用 move_path' },
  { pattern: 'run_command:ren ', decision: 'deny', note: '要重命名请用 move_path' },
  { pattern: 'run_command:git clean', decision: 'deny', note: '会删未跟踪文件；要清理请用 delete_paths 明确列出' },
  { pattern: 'run_command:git rm', decision: 'deny', note: '要删文件请用 delete_paths' },
  { pattern: 'run_command:robocopy', decision: 'deny', note: '/MIR 会清空目标目录' },
  { pattern: 'run_command:rsync --delete', decision: 'deny', note: '会清空目标目录' },
  { pattern: 'run_command:find ', decision: 'deny', note: '-delete 会删文件；要删请用 delete_paths' },
  { pattern: 'run_command:truncate ', decision: 'deny', note: '要清空文件请用 write_file 或 delete_paths' },
  { pattern: 'run_command:fsutil file setzerodata', decision: 'deny', note: '会清空文件内容' },

  /*
   * 不能评估的命令不该让人签字。
   *
   * `-EncodedCommand` 收的是 base64 的 UTF-16 PowerShell：审批卡上那串东西
   * 人读不懂，点了"允许"等于盲签。所以直接拒，理由写清楚。
   */
  { pattern: 'run_command:powershell -enc', decision: 'deny', note: '命令被 base64 混淆，人无法评估' },
  { pattern: 'run_command:powershell -EncodedCommand', decision: 'deny', note: '命令被 base64 混淆，人无法评估' },
  { pattern: 'run_command:frombase64string', decision: 'deny', note: '命令被 base64 混淆，人无法评估' },
  /*
   * ★ 读文件一律走 `read_file` / `grep`，shell 里的读命令**全部拒绝**。
   *
   * 理由不是"shell 读不干净"，而是**读的地方没有审核**：`type .env` 的输出
   * 直接进上下文，而我们的 read_file 会先过一遍闸门（打码 / 整份扣留 / taint）。
   * 两条路都能读，等于审核可以绕过 —— 那不如不做。
   *
   * 拒绝文案必须教路，否则模型会换写法（`Get-Content` 换成 `[IO.File]::ReadAllText`）。
   */
]

/**
 * 出厂默认的询问规则。
 *
 * 这些的后果在本地之外（远端仓库、包注册表），恢复层管不到。
 */
export const DEFAULT_ASK_RULES: PolicyRule[] = [
  { pattern: 'run_command:git push', decision: 'ask', note: '远端副作用不可撤销' },
  { pattern: 'run_command:git reset --hard', decision: 'ask' },
  { pattern: 'run_command:git clean', decision: 'ask' },
  { pattern: 'run_command:npm publish', decision: 'ask' },
  { pattern: 'run_command:yarn publish', decision: 'ask' },
  { pattern: 'run_command:pnpm publish', decision: 'ask' },
  { pattern: 'run_command:cargo publish', decision: 'ask' },
]

/**
 * 默认允许列表：**刻意是空的。**
 *
 * Cursor 官方示例把 `npm` 整条放进允许列表，而它的匹配是命令字符串前缀——
 * 所以那一条覆盖了 `npm install`、`npm publish`、以及**所有 postinstall 脚本**。
 * 我们不带这种出厂默认。
 *
 * 想减少确认次数，就显式加规则；规则越窄越好（`run_command:git status`
 * 而不是 `run_command:git`）。
 */
export const DEFAULT_ALLOW_RULES: PolicyRule[] = []
