/**
 * 恢复守卫：包在**工具分发之外**。
 *
 * 这不是实现细节，而是整个设计的关键位置。
 *
 * 调研里最硬的一条结论是：**所有能覆盖 shell 通道的方案，都把快照边界挪到了
 * agent 之下。** Claude Code、华为 CodeArts、Kiro 三家文档记录着同一个洞——
 * 工具级 checkpoint 看不见 `rm`、`mv`、`sed -i`、以及任何命令产生的副作用。
 *
 * 所以这里不在工具**内部**记录，而是在**分发这一层**包一圈：
 * 动作前整树快照 → 执行工具（含它 spawn 的一切）→ 动作后整树快照。
 * 因此 shell 副作用、代码生成、甚至并发的外部改动都被同一个边界覆盖。
 */

import type { RecoveryManager } from './manager.ts'
import type { ToolRegistry } from '../tools/registry.ts'
import type { ToolContext, ToolResult } from '../tools/types.ts'

export interface GuardedExecution {
  result: ToolResult
  /**
   * 事务 id。
   *
   * **只有真的产生了文件变化才有值。** 没有变化时刻意不产生条目——
   * 调研里 Claude Code 的 issue #34368 正是「提供撤销选项但点了没用」，
   * 那比没有更危险。
   */
  transactionId?: string
}

/** 参数没通过校验时不可能有文件变化，不值得产生事务 */
const NO_EFFECT_ERRORS = new Set(['invalid_args', 'unknown_tool'])

/**
 * 这四个工具的目标路径是**结构化给的**（参数里的 `path`），所以快照可以只扫它。
 *
 * 为什么只有这四个：`run_command` 的副作用无法从参数推出（`rm`、`sed -i`、
 * 构建产物、代码生成、甚至 `git checkout`）。给它收窄等于漏掉真正的变化 ——
 * 而"漏掉变化的撤销"比"没有撤销"更坏。所以它永远走全树。
 *
 * `spawn_agent` 同理不收窄：子代理里可能发生任何事。
 */
const NARROWED_TOOLS = new Set(['write_file', 'create_file', 'delete_file', 'edit'])

/**
 * 从工具参数里取出可以收窄的路径。
 *
 * 取不到（字段缺失、类型不对、JSON 解析失败）就返回 `undefined` —— 那意味着
 * "老老实实扫全树"。**宁可慢，不可漏。**
 */
function narrowPaths(name: string, rawArgs: unknown): string[] | undefined {
  if (!NARROWED_TOOLS.has(name)) return undefined

  let args: unknown = rawArgs
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs)
    } catch {
      return undefined
    }
  }
  if (typeof args !== 'object' || args === null) return undefined

  const value = (args as Record<string, unknown>)['path']
  if (typeof value !== 'string' || value.trim() === '') return undefined

  /* 绝对路径 / `..` 的防护在 walkTree 里（那里已经有规范化逻辑），不在这重复一套 */
  return [value]
}

export class RecoveryGuard {
  #registry: ToolRegistry
  #manager: RecoveryManager

  constructor(registry: ToolRegistry, manager: RecoveryManager) {
    this.#registry = registry
    this.#manager = manager
  }

  get manager(): RecoveryManager {
    return this.#manager
  }

  async execute(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<GuardedExecution> {
    const tool = this.#registry.get(name)

    // 读类工具改变不了文件系统，快照是纯开销
    if (tool === undefined || tool.risk === 'read') {
      return { result: await this.#registry.execute(name, rawArgs, ctx) }
    }

    // ── 两种情况**刻意不产生撤销条目** ──────────────────────────────────
    //
    // 1. **这次调用本身是后台启动。** 它立刻返回，after 快照此刻拍到的是「还没开始
    //    干活」的状态，而进程之后会一直写。给它一个事务，等于给用户一个点了没用
    //    的撤销按钮。
    //
    // 2. **有后台作业正在跑。** 它随时可能在任意时刻写文件，所以「动作前 → 动作后」
    //    这个时间窗里的归属**根本无法确定**。此时提交事务会更糟：下一个工具调用
    //    的事务会把后台进程刚生成的产物算成「自己新增的」，于是撤销那一步会
    //    **删掉后台的产物**（copilot-cli#1675 就是这一类）。
    //
    // 宁可让这一段时间里没有撤销可用，也不提供一个会删错东西的撤销。
    // 这条规则和「无变化不产生条目」是同一个取舍：**没有 > 有但不对。**
    //
    // 作业注册表从 `ctx` 拿而不是构造参数：它按工作区一份，而 `ctx` 本来就是
    // 「这次调用在哪、能碰到什么」的载体。走两个入口迟早会有一处忘了传。
    if (ctx.jobs?.hasRunning() === true) {
      const result = await this.#registry.execute(name, rawArgs, ctx)
      return { result }
    }

    /*
     * 收窄：四个文件工具的目标路径是给定的，没必要为一次 `write_file`
     * 扫两遍全树。`run_command` / `spawn_agent` 仍然是全树（取不到路径）。
     *
     * ⚠️ `only` 会随 pending 一起带到 commit —— 两次快照必须是同一范围，
     * 否则 diff 会比两棵大小不同的树，把"before 里没扫到"错算成"新增"。
     */
    const only = narrowPaths(name, rawArgs)
    const pending = await this.#manager.begin({
      tool: name,
      summary: summarize(name, rawArgs),
      ...(only === undefined ? {} : { only }),
    })

    const result = await this.#registry.execute(name, rawArgs, ctx)

    if (!result.ok && result.error !== undefined && NO_EFFECT_ERRORS.has(result.error.kind)) {
      this.#manager.abort(pending)
      return { result }
    }

    // 后台启动：放弃这次事务（原因见上面第 1 条）
    if (isBackgroundResult(result)) {
      this.#manager.abort(pending)
      return { result }
    }

    const transaction = await this.#manager.commit(pending)
    return transaction === null ? { result } : { result, transactionId: transaction.id }
  }
}

/** 工具结果里带 `background: true` 说明它只起了个进程，没干活 */
function isBackgroundResult(result: ToolResult): boolean {
  const data = result.data
  if (data === null || typeof data !== 'object') return false
  return (data as Record<string, unknown>).background === true
}

/** 生成一行人类可读的事务描述，用于「撤销上一步」这类 UI */
function summarize(name: string, rawArgs: unknown): string {
  let args: unknown = rawArgs
  if (typeof rawArgs === 'string') {
    try {
      args = JSON.parse(rawArgs)
    } catch {
      return name
    }
  }
  if (args !== null && typeof args === 'object') {
    const record = args as Record<string, unknown>
    if (typeof record.path === 'string') return `${name} ${record.path}`
    if (typeof record.command === 'string') return `${name} ${record.command}`
  }
  return name
}
