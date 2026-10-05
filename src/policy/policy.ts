/**
 * 权限求值器。
 *
 * 求值顺序就是整个设计：
 *
 *   1. **能力上限**（模式本身）—— 硬拒绝，任何 allow 规则都越不过
 *   2. **熔断器** —— 剥夺 allow 规则的批准权，但**不**强制拒绝
 *   3. **规则** —— deny > ask > allow（或最长 pattern 胜）
 *   4. **默认** —— 按工具风险与工作区内外
 *   5. **降级** —— 熔断命中时 allow→ask；无人可应答时 ask→deny
 *
 * 第 2 步和第 5 步是这一层真正有价值的地方。第 3 步（字符串匹配白名单）
 * 已经有三个 CVE 证明了它可被绕过，所以它只能当便利设施，不能当边界。
 */

import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_ASK_RULES,
  DEFAULT_DENY_RULES,
  DEFAULT_PROTECTED_PATHS,
  MODES,
  type Decision,
  type PermissionMode,
  type PolicyContext,
  type PolicyOptions,
  type PolicyReason,
  type PolicyRequest,
  type PolicyRule,
  type PolicyStatus,
  type PolicyVerdict,
  type Precedence,
} from './types.ts'
import { classifyReadOnly } from './read-only.ts'

// ---------------------------------------------------------------------------
// 纯函数：匹配键
// ---------------------------------------------------------------------------

export function normalizeArgs(raw: unknown): Record<string, unknown> {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return {}
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * 规则匹配用的「参数匹配键」。
 *
 * 规则串是 `工具名:前缀` 的形态，前缀与这个键做 `startsWith` 比较。
 * 刻意**只做前缀**：调研里 Roo Code 和 Cursor 都是这个模型，
 * 而四个 CVE（含三个 Cursor 的）全都是因为把前缀匹配当成了语义匹配。
 */
export function matchKey(request: PolicyRequest): string {
  const args = normalizeArgs(request.args)

  if (request.tool === 'run_command') {
    const command = typeof args.command === 'string' ? args.command : ''
    if (Array.isArray(args.args)) {
      const extra = args.args.filter((a): a is string => typeof a === 'string').join(' ')
      return extra === '' ? command : `${command} ${extra}`
    }
    return command
  }

  if (typeof args.path === 'string') return args.path
  return ''
}

function ruleMatches(rule: PolicyRule, tool: string, key: string): boolean {
  const colon = rule.pattern.indexOf(':')
  const toolPart = colon === -1 ? rule.pattern : rule.pattern.slice(0, colon)
  const spec = colon === -1 ? '' : rule.pattern.slice(colon + 1)

  if (toolPart !== '*' && toolPart !== tool) return false
  if (spec === '') return true
  return key.startsWith(spec)
}

// ---------------------------------------------------------------------------
// 纯函数：熔断器
// ---------------------------------------------------------------------------

interface BreakerHit {
  reason: PolicyReason
  message: string
  detail?: string
}

const DELETE_VERBS = [
  'rm',
  'rmdir',
  'del',
  'erase',
  'rd',
  'remove-item',
  'shutil.rmtree',
  'fs.rm',
  'fs.rmdir',
  'fs.unlink',
  'unlink',
  'trash',
]

const SUBSTITUTIONS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\$\(/, label: '$() 命令替换' },
  { pattern: /`/, label: '反引号命令替换' },
  { pattern: /\$\{/, label: '${} 参数展开' },
  { pattern: /<\(/, label: '<() 进程替换' },
  { pattern: />\(/, label: '>() 进程替换' },
]

/**
 * `curl … | sh` 这类管道直通解释器。
 *
 * 用**内容检查**而不是规则：前缀匹配抓不住管道（`startsWith('curl | sh')`
 * 对 `curl -s url | sh` 无效），这正是字符串白名单那类 CVE 的根源。
 */
const PIPE_TO_SHELL =
  /\|\s*(sh|bash|zsh|fish|pwsh|powershell|cmd|iex|invoke-expression|python3?|node|perl|ruby)\b/i

/**
 * 这次调用是不是后台启动。
 *
 * ⚠️ **后台命令刻意不适用只读自动放行**，即使命令文本本身可证明只读。
 *
 * 理由是「只读」这个判定是关于**命令文本**的，而后台命令的风险来自**时间**：
 * 它不会退出，会在快照边界之后持续写文件，因此不受恢复层保护。`git status`
 * 前台跑一次没有后果；同一个东西挂在后台跑着，就不是同一件事了。
 *
 * 注意这里只影响 `workspace-write` 下的默认行为（照常问）。**没有**在
 * `full-access` 下强行加一道询问 —— 那个模式的语义就是「不要问」，
 * 偷偷多问一次会让模式的定义变得不可信。
 */
function isBackgroundRequest(request: PolicyRequest): boolean {
  const args = normalizeArgs(request.args)
  return args.background === true
}

function commandText(request: PolicyRequest): string {  const args = normalizeArgs(request.args)
  const command = typeof args.command === 'string' ? args.command : ''
  if (Array.isArray(args.args)) {
    const extra = args.args.filter((a): a is string => typeof a === 'string').join(' ')
    return extra === '' ? command : `${command} ${extra}`
  }
  return command
}

const SHELL_BINARIES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'ksh',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'wsl',
])

/**
 * 这次调用是否会把字符串交给解释器执行。
 *
 * ⚠️ **不能只看「有没有给 args」。** 直接启动 `bash -c "..."` 同样是把字符串
 * 交给 shell —— 只是把解析责任从我们的 shell 挪到了显式调用的那个 shell 上。
 * 漏掉这一条，替换守卫就会被一个显式的 `bash -c` 绕过。
 */
function isShellMode(request: PolicyRequest): boolean {
  if (request.tool !== 'run_command') return false
  const args = normalizeArgs(request.args)

  // 不给 args → 经平台 shell 解析
  if (args.args === undefined) return true

  // 给了 args，但可执行文件本身是解释器 / shell
  const command = typeof args.command === 'string' ? args.command : ''
  const base = command.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  return SHELL_BINARIES.has(base)
}

function hasDeleteVerb(text: string): boolean {
  const lower = text.toLowerCase()
  return DELETE_VERBS.some((verb) => lower.includes(verb))
}

/**
 * 从命令文本里粗提「可能被删的东西」。
 *
 * ⚠️ **这是启发式，不是解析器。** 设计立场取自 doover：
 * **无法静态解析就按危险处理，绝不假设安全**（见 `#findDeleteTargets`）。
 *
 * 过滤掉：引号、分隔符、`-` 开头的选项、cmd 风格的 `/x` 短选项、删除动词本身。
 * 剩下的都当成候选目标去解析——宁可多问一次，不要漏掉一次。
 */
function candidateTargets(text: string): string[] {
  return text
    .replace(/["'`]/g, ' ')
    .split(/[\s(){};,&|]+/)
    .filter((token) => token !== '')
    .filter((token) => !token.startsWith('-'))
    // cmd.exe 的 `/q` `/s` 这类短选项，不是路径
    .filter((token) => !/^\/[a-zA-Z]{1,3}$/.test(token))
    .filter((token) => !DELETE_VERBS.includes(token.toLowerCase()))
}

/**
 * 解析一个 token。
 *
 * `~` 归到家目录 —— shell 会这么做，我们如果不照着做就会漏掉 `rm -rf ~`。
 * 含 `$` 或 `%` 的（`$HOME`、`%USERPROFILE%`）**解析不了**，由调用方按危险处理。
 */
function resolveToken(rootAbs: string, token: string): string | null {
  if (token.includes('$') || token.includes('%')) return null
  if (token === '~') return os.homedir()
  if (token.startsWith('~/') || token.startsWith('~\\')) {
    return path.join(os.homedir(), token.slice(2))
  }
  return path.resolve(rootAbs, token)
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b)
}

/** ancestor 是否是 descendant 的祖先（不包含相等） */
function isAncestorOf(ancestor: string, descendant: string): boolean {
  const rel = path.relative(ancestor, descendant)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function isCriticalTarget(abs: string, rootAbs: string, homeAbs: string): boolean {
  if (abs === path.parse(abs).root) return true
  if (samePath(abs, homeAbs)) return true
  if (samePath(abs, rootAbs)) return true
  // 工作区或家目录的祖先 —— 删掉它会波及它们
  if (isAncestorOf(abs, rootAbs)) return true
  if (isAncestorOf(abs, homeAbs)) return true
  return false
}

function isInside(abs: string, rootAbs: string): boolean {
  const rel = path.relative(rootAbs, abs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function toRelative(abs: string, rootAbs: string): string | null {
  if (!isInside(abs, rootAbs)) return null
  const rel = path.relative(rootAbs, abs).split(path.sep).join('/')
  return rel === '' ? '.' : rel
}

function isProtected(rel: string, protectedPaths: string[]): string | null {
  for (const entry of protectedPaths) {
    if (entry.includes('/')) {
      if (rel === entry || rel.startsWith(`${entry}/`)) return entry
    } else if (rel === entry || rel.split('/').includes(entry)) {
      return entry
    }
  }
  return null
}

function resolver(request: PolicyRequest, rootAbs: string): string | null {
  const args = normalizeArgs(request.args)
  if (typeof args.path !== 'string' || args.path.trim() === '') return null
  return path.resolve(rootAbs, args.path)
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export class Policy {
  #mode: PermissionMode
  #rules: PolicyRule[]
  #precedence: Precedence
  #protected: string[]
  #interactive: boolean
  #fatigueConsecutive: number
  #fatigueTotal: number
  #consecutiveBlocks = 0
  #totalBlocks = 0
  #fatigued = false

  constructor(options: PolicyOptions) {
    this.#mode = options.mode
    this.#rules = [...DEFAULT_DENY_RULES, ...DEFAULT_ASK_RULES, ...(options.rules ?? [])]
    this.#precedence = options.precedence ?? 'deny-first'
    this.#protected = options.protectedPaths ?? DEFAULT_PROTECTED_PATHS
    this.#interactive = options.interactive ?? true
    this.#fatigueConsecutive = options.fatigueConsecutive ?? 3
    this.#fatigueTotal = options.fatigueTotal ?? 20
  }

  get mode(): PermissionMode {
    return this.#mode
  }

  /**
   * 切换模式。
   *
   * ⚠️ **这个方法只能由人侧调用。**
   * 规则是：模型可以主动降权（自我保护），但**只能请求提权、不能设置提权**。
   * 如果存在一个模型可调的「提权」通道，整个权限层归零。
   *
   * ⚠️ **声明一句实话：这条纪律没有任何机制在强制，靠的是调用点自觉。**
   *
   * 类型系统管不了它 —— `setMode` 就是个公开方法，谁拿到 `Policy` 谁就能调。
   * 全仓库对它的调用只有两处，都在同一个文件里（`src/host/session.ts`）：
   *   - `Session.init()`：从检查点恢复上次的模式 —— 那不是提权，是恢复原状；
   *   - `Session.setMode()`：入口是服务端命令 `set_mode`。
   *
   * CLI（`policy.ts` / `serve.ts`）不走它：那里是把模式传进 `Policy` 构造函数。
   *
   * 真正把它钉住的是一件事：**模式切换没有被注册成模型可用的工具。**
   * 工具集在 `createDefaultRegistry()` 里，那里没有它。换成能力型令牌、或把
   * `Policy` 藏进模型不可达的闭包会更强，但那要等权限层真的接上沙箱时一起做 ——
   * 现在加一层壳只是让人觉得已经安全了。
   */
  setMode(mode: PermissionMode): void {
    this.#mode = mode
  }

  evaluate(request: PolicyRequest, context: PolicyContext): PolicyVerdict {
    const rootAbs = path.resolve(context.root)
    const interactive = context.interactive ?? this.#interactive
    const spec = MODES[this.#mode]
    const key = matchKey(request)

    // ── 1. 能力上限：硬拒绝，任何 allow 规则都越不过 ──────────────────
    if (request.risk === 'write' && spec.fileWrite === 'none') {
      return this.#finalize(
        {
          decision: 'deny',
          reason: 'mode-read-only',
          message: `当前是只读模式，不允许写入（${request.tool}）`,
        },
        interactive,
        [],
      )
    }
    if (request.risk === 'execute' && spec.command === 'none') {
      return this.#finalize(
        {
          decision: 'deny',
          reason: 'mode-no-command',
          message: '当前模式不允许执行命令',
        },
        interactive,
        [],
      )
    }

    // ── 1.5 可证明只读的命令：自动放行 ────────────────────────────────
    //
    // 出厂允许列表是空的（那是刻意的，见 types.ts 里的理由），代价是
    // `git status` 这种绝对无害的东西也要点一次确认。而人一旦开始闭眼点「允许」，
    // 权限层就形同虚设 —— 那比少问几次更危险。
    //
    // 所以放行的不是「更宽的允许列表」，而是**能证明只读**的命令：判不出来就照常问。
    // 判定逻辑单独在 read-only.ts 里，重点是不做前缀匹配、不接受 shell 元字符。
    //
    // 注意位置：在能力上限**之后**（只读模式下命令本来就该被拒），在熔断器与
    // 规则**之前**（只读命令不该受抗疲劳影响 —— 它没碰任何东西）。
    if (request.risk === 'execute' && !isBackgroundRequest(request)) {
      const verdict = classifyReadOnly(commandText(request))
      if (verdict.readOnly) {
        return this.#finalize(
          {
            decision: 'allow',
            reason: 'read-only-command',
            message: `可证明只读，自动放行：${verdict.reason}`,
          },
          interactive,
          // 空 hits：不触发熔断降级。理由同「读文件一律放行」——
          // 抗疲劳是为了拦住「闭眼批准有后果的事」，而这里没有任何后果。
          [],
        )
      }
    }

    const target = resolver(request, rootAbs)
    if (
      request.risk === 'write' &&
      spec.fileWrite === 'workspace' &&
      target !== null &&
      !isInside(target, rootAbs)
    ) {
      return this.#finalize(
        {
          decision: 'deny',
          reason: 'write-outside-workspace',
          message: `路径越出工作区，当前模式不允许：${path.relative(rootAbs, target)}`,
        },
        interactive,
        [],
      )
    }

    // ── 2. 熔断器 ────────────────────────────────────────────────────
    const hits = this.#runBreakers(request, rootAbs, target)
    if (this.#fatigued) {
      hits.push({
        reason: 'fatigue-downgrade',
        message: `连续被拦 ${this.#consecutiveBlocks} 次（累计 ${this.#totalBlocks} 次），已暂停自动放行`,
      })
    }

    // ── 3. 规则 ──────────────────────────────────────────────────────
    const fromRules = this.#matchRules(request, key, hits.length > 0)

    // ── 4. 默认 ──────────────────────────────────────────────────────
    const base = fromRules ?? this.#defaultDecision(request, target, rootAbs, spec)

    return this.#finalize(base, interactive, hits)
  }

  /**
   * 记录实际结果，用于抗疲劳。
   *
   * Claude Code 的阈值是「连续 3 次 / 累计 20 次」，且**不可配置**；
   * 这里是可配置的，但默认取它的值。
   *
   * 返回 `true` 表示**这一次刚好把熔断器打开了**。调用方据此只发一次事件 ——
   * 而不是每次被拦都发一遍，那会把事件流刷满、反而没人看见第一次。
   *
   * ⚠️ **「连续」要求调用方在放行路径上也调这个方法。** 只在一个方向上记账
   * （被拦时 +1）会让「连续 3 次」退化成「累计 3 次」，因为在两次被拦之间
   * 发生的一切都不作数。
   *
   * ⚠️ 另外：allowed **不会**清掉 `#fatigued`（见下）。
   */
  observe(outcome: 'allowed' | 'blocked'): boolean {
    if (outcome === 'blocked') {
      this.#consecutiveBlocks += 1
      this.#totalBlocks += 1
      if (
        !this.#fatigued &&
        (this.#consecutiveBlocks >= this.#fatigueConsecutive ||
          this.#totalBlocks >= this.#fatigueTotal)
      ) {
        this.#fatigued = true
        return true
      }
      return false
    }
    // 一次放行就打断「连续被拦」的链条。累计数不清 —— 那是刻意的。
    this.#consecutiveBlocks = 0
    return false
  }

  /**
   * 人明确说「我在看着，恢复自动放行」之后调用。
   *
   * ⚠️ **这是离开 `#fatigued` 的唯一途径，而且是刻意的。**
   *
   * 熔断器命中的前提就是「人在连续打回」——也就是说，此刻的「允许」正是
   * 我们不再信任的那个动作。所以**不能在放行时自动复位**：那等于熔断器
   * 一命中就自我解除，一次点击就把自己关掉，等于没有这个熔断器。
   *
   * 代价是它成了一道单向门，因此必须同时满足两件事，否则就是「静默单向门」：
   *   1. 状态要**可见**（`status()` → 会话投影 → 事件），用户得知道为什么
   *      突然每件事都要点确认；
   *   2. 要有**复位入口**（`reset_fatigue` 命令），否则只能重启进程，
   *      而「重启一下就好了」是一种谁都学得会的绕行方式。
   *
   * 这也正是这套代码在别处批判过的失败模式：能拦住但说不清、也解不开的锁，
   * 最终只会训练人去绕过它。
   */
  resetFatigue(): void {
    this.#consecutiveBlocks = 0
    this.#totalBlocks = 0
    this.#fatigued = false
  }

  status(): PolicyStatus {
    return {
      mode: this.#mode,
      precedence: this.#precedence,
      rules: this.#rules.length,
      consecutiveBlocks: this.#consecutiveBlocks,
      totalBlocks: this.#totalBlocks,
      fatigued: this.#fatigued,
      interactive: this.#interactive,
    }
  }

  rules(): PolicyRule[] {
    return [...this.#rules]
  }

  // -------------------------------------------------------------------------

  #runBreakers(
    request: PolicyRequest,
    rootAbs: string,
    target: string | null,
  ): BreakerHit[] {
    const hits: BreakerHit[] = []
    const homeAbs = os.homedir()

    // 保护路径：写入这些位置会改变后续所有命令的行为
    if (request.risk !== 'read' && target !== null) {
      const rel = toRelative(target, rootAbs)
      if (rel !== null) {
        const hit = isProtected(rel, this.#protected)
        if (hit !== null) {
          hits.push({
            reason: 'protected-path',
            detail: rel,
            message: `「${rel}」是保护路径（命中 ${hit}）：它能改变之后所有命令的行为，allow 规则无权预批准，需要人工确认`,
          })
        }
      }
    }

    // 关键路径 / 工作区外 / 无法解析的删除目标
    const deleteHit = this.#findDeleteTargets(request, rootAbs, homeAbs)
    if (deleteHit !== null) hits.push(deleteHit)

    // 只在 shell 模式下检查替换与管道
    if (isShellMode(request)) {
      const text = commandText(request)
      for (const { pattern, label } of SUBSTITUTIONS) {
        if (pattern.test(text)) {
          hits.push({
            reason: 'dangerous-substitution',
            detail: label,
            message: `命令里含 ${label}，白名单前缀无法覆盖它实际会执行的东西，需要人工确认`,
          })
          break
        }
      }
      if (PIPE_TO_SHELL.test(text)) {
        hits.push({
          reason: 'pipe-to-shell',
          detail: text.slice(0, 120),
          message: '命令把输出直接管道给了解释器，需要人工确认',
        })
      }
    }

    return hits
  }

  /**
   * 删除目标的三档判定：关键路径 > 工作区之外 > **解析不了**。
   *
   * 第三档是刻意加上的：`rm -rf $HOME` 里的 `$HOME` 不像路径，
   * 靠「像不像路径」去筛会直接漏掉它。doover 的立场是
   * **无法静态解析就按危险处理，绝不假设安全** —— 这里照做。
   */
  #findDeleteTargets(
    request: PolicyRequest,
    rootAbs: string,
    homeAbs: string,
  ): BreakerHit | null {
    if (request.tool === 'delete_file') {
      const target = resolver(request, rootAbs)
      if (target === null) return null
      if (isCriticalTarget(target, rootAbs, homeAbs)) {
        return {
          reason: 'critical-path',
          detail: target,
          message: `「${target}」是关键路径（文件系统根 / 家目录 / 工作区及其祖先），这类删除没有正当用途`,
        }
      }
      if (!isInside(target, rootAbs)) {
        return {
          reason: 'delete-outside-workspace',
          detail: target,
          message: `要删除工作区之外的东西：「${target}」`,
        }
      }
      return null
    }

    if (request.tool !== 'run_command') return null

    const text = commandText(request)
    if (!hasDeleteVerb(text)) return null

    const unresolved: string[] = []
    for (const token of candidateTargets(text)) {
      const abs = resolveToken(rootAbs, token)
      if (abs === null) {
        unresolved.push(token)
        continue
      }
      if (isCriticalTarget(abs, rootAbs, homeAbs)) {
        return {
          reason: 'critical-path',
          detail: abs,
          message: `删除目标是关键路径「${abs}」（文件系统根 / 家目录 / 工作区及其祖先），没有正当用途`,
        }
      }
      if (!isInside(abs, rootAbs)) {
        return {
          reason: 'delete-outside-workspace',
          detail: abs,
          message: `要删除工作区之外的东西：「${abs}」`,
        }
      }
    }

    if (unresolved.length > 0) {
      return {
        reason: 'unresolvable-delete-target',
        detail: unresolved[0],
        message: `删除目标里有无法静态解析的部分（${unresolved
          .slice(0, 3)
          .join('、')}）：解析不了就按危险处理`,
      }
    }

    return null
  }

  #matchRules(
    request: PolicyRequest,
    key: string,
    allowBlocked: boolean,
  ): PolicyVerdict | null {
    let candidates = this.#rules.filter((rule) => ruleMatches(rule, request.tool, key))
    if (allowBlocked) {
      // 熔断命中：allow 规则被剥夺批准权。deny 与 ask 仍然有效。
      candidates = candidates.filter((rule) => rule.decision !== 'allow')
    }
    if (candidates.length === 0) return null

    let picked: PolicyRule
    if (this.#precedence === 'most-specific') {
      picked = candidates.reduce((best, r) => (r.pattern.length > best.pattern.length ? r : best))
    } else {
      const order: Decision[] = ['deny', 'ask', 'allow']
      let bucket: PolicyRule[] = []
      for (const decision of order) {
        const same = candidates.filter((r) => r.decision === decision)
        if (same.length > 0) {
          bucket = same
          break
        }
      }
      picked = bucket.reduce((best, r) => (r.pattern.length > best.pattern.length ? r : best))
    }

    const reason: PolicyReason =
      picked.decision === 'deny' ? 'deny-rule' : picked.decision === 'ask' ? 'ask-rule' : 'allow-rule'

    return {
      decision: picked.decision,
      reason,
      message: `命中规则「${picked.pattern}」→ ${picked.decision}${
        picked.note !== undefined ? `（${picked.note}）` : ''
      }`,
      rule: picked.pattern,
    }
  }

  #defaultDecision(
    request: PolicyRequest,
    target: string | null,
    rootAbs: string,
    spec: (typeof MODES)[PermissionMode],
  ): PolicyVerdict {
    // 读操作一律放行 —— Cline / Roo / Claude Code 三家一致
    if (request.risk === 'read') {
      return {
        decision: 'allow',
        reason: 'read-auto-allow',
        message: '读操作不做拦截',
      }
    }

    if (request.risk === 'write') {
      const inside = target === null || isInside(target, rootAbs)
      if (inside) {
        return {
          decision: 'allow',
          reason: 'write-inside-workspace',
          message: '工作区内的文件写入',
        }
      }
      return {
        decision: spec.writeOutside,
        reason: 'write-outside-workspace',
        message: '写入工作区之外',
      }
    }

    if (request.risk === 'execute') {
      return {
        decision: spec.commandDefault,
        reason: 'command-default',
        message:
          spec.commandDefault === 'allow'
            ? '当前模式下命令默认放行'
            : '命令没有命中任何规则，默认需要确认',
      }
    }

    return {
      decision: 'ask',
      reason: 'unknown-tool',
      message: `未知风险等级的工具：${request.tool}`,
    }
  }

  #finalize(
    base: PolicyVerdict,
    interactive: boolean,
    hits: BreakerHit[],
  ): PolicyVerdict {
    let decision = base.decision
    let reason = base.reason
    let message = base.message
    let allowSuppressed = false
    let breakerDetail: string | undefined

    // 熔断命中：不能是 allow，最多 ask。
    //
    // 例外是读操作：读一律放行，抗疲劳不该把「读文件」也变成要确认。
    // 否则熔断触发后连看一眼文件都得点一次，那不是更安全，那是瘫痪。
    if (hits.length > 0 && decision !== 'deny' && base.reason !== 'read-auto-allow') {
      const hit = hits[0]
      allowSuppressed = decision === 'allow'
      decision = 'ask'
      reason = hit.reason
      message = hit.message
      breakerDetail = hit.detail
    }

    // 无人可应答 → 立即拒绝，而不是假装问过了
    let downgradedFromAsk = false
    if (decision === 'ask' && !interactive) {
      decision = 'deny'
      downgradedFromAsk = true
      message = `${message}（当前环境无人可应答，按拒绝处理）`
    }

    return { decision, reason, message, rule: base.rule, allowSuppressed, breakerDetail, downgradedFromAsk }
  }
}
