/**
 * 工具契约。
 *
 * 三条原则，和模型层保持一致：
 *
 * 1. **错误是结果，不是异常。**
 *    工具报错要能被回填给模型让它自己修正。throw 会让整个循环死掉，
 *    所以边界（ToolRegistry.execute）负责把所有异常收敛成 ToolResult。
 *
 * 2. **参数是不可信输入。**
 *    模型给的参数完全可能是坏的。校验由参数 schema 统一负责，
 *    而 schema 同时就是给模型看的那份 —— 单一事实来源，不会漂移。
 *
 * 3. **risk 字段从第一天就在。**
 *    现在没人读它，但它是后续权限/审批层的挂载点。
 *    等事件日志落地、审批从「事前静态决定」变成「真暂停真恢复」时，
 *    工具实现一行都不用改 —— 贵的是契约，便宜的是驱动。
 */

import type { SkillToolApi } from '../skills/types.ts'
import type { PluginEnvApi } from '../plugins/types.ts'

export type RiskLevel =
  | 'read'
  | 'write'
  | 'execute'
  /**
   * **会离开这台机器**的操作（网络请求）。
   *
   * ## 为什么它必须是单独一档，而不是并进 `read`
   *
   * 威胁模型完全不同。本地读一个文件，最坏情况是"模型看到了不该看的本机内容"；
   * 而网络请求有三个本机操作没有的性质：
   *
   *   1. **它是对外的** —— 请求本身就在往第三方泄露信息（URL、查询词、
   *      以及我们可能带上的任何头）
   *   2. **响应是不受信任的输入** —— 网页是最典型的提示注入载体
   *   3. **结果是不可撤销的** —— 发出去就是发出去了，本地读写还能撤销
   *
   * 所以策略层可以单独对网络设限（比如 `read-only` 下也拒网络、
   * 或者只允许白名单主机），而不必把"读本地文件"一起牵连进来。
   *
   * 并进 `read` 的话，那两件事就再也分不开了 —— 而它们该分开。
   */
  | 'network'

/**
 * 后台作业的**契约**。
 *
 * ⚠️ 这几个类型刻意放在这里，而不是放在实现文件 `jobs.ts` 里。
 *
 * 原因很具体：`types.ts` **会进浏览器程序**（`src/policy/types.ts` 从这里取
 * `RiskLevel`，而协议层又依赖它），所以它引用的任何东西都必须是浏览器安全的。
 * 第一版我写的是 `import type { JobRegistry } from './jobs.ts'` —— 那一行把
 * `jobs.ts`（用 `node:child_process` / `node:fs`）整个拖进了浏览器程序，
 * 于是 `vue-tsc` 报了一片「找不到模块 node:child_process」。
 *
 * 所以：契约与 `node:` 无关，放这边；实现放那边。`JobRegistry` 实现这个接口。
 */
export interface JobRecord {
  id: string
  command: string
  cwd: string
  /** 进程 id。启动失败时为 null */
  pid: number | null
  startedAt: string
  stdoutPath: string
  stderrPath: string
  /** null = 还在跑 */
  exit: { code: number | null; signal: string | null } | null
  /** 是我们主动杀的，还是自己退出的 */
  killed: boolean
}

export interface StartJobOptions {
  command: string
  file: string
  argv: readonly string[]
  cwd: string
  /** 结果如何呈现给模型 */
  label: string
}

export interface JobRegistryLike {
  start(options: StartJobOptions): Promise<JobRecord>
  list(): JobRecord[]
  get(id: string): JobRecord | undefined
  /** 有作业还在跑。恢复层用它决定「这个时间窗的归属是否可信」 */
  hasRunning(): boolean
  kill(id: string): boolean
  output(id: string): Promise<{ stdout: string; stderr: string } | undefined>
}

export interface ToolContext {
  /** 工作区根目录。所有路径解析都以它为界，越界一律拒绝。 */
  root: string
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputChars?: number
  /**
   * 后台作业注册表。
   *
   * 可选，是因为它**属于工作区**（每个工作区一份，和恢复层同级），而工具上下文
   * 是每次调用现攒的。没有它时 `run_command background=true` 会明确失败，
   * 而不是静默退化成前台 —— 那会让一个 dev server 把整轮对话卡死。
   */
  jobs?: JobRegistryLike
  /**
   * 网络搜索的配置。
   *
   * ## 为什么从 `ctx` 传进来、而不是工具自己去读配置文件
   *
   * 工具层**不该读 `~/.mvs-agent/config.json`**。让它读的话，"工具能不能碰到
   * 配置文件"就变成一个隐式依赖 —— 而这个项目里路径权限是明着设计的
   * （`resolveInsideRoot`，工作区外一律拒）。工具自己绕过那条线，
   * 等于给密钥泄露开了个后门，而且是**看起来正当**的那一种。
   *
   * 所以配置由调用方（会话层）注入。工具只声明"我需要它"。
   */
  webSearch?: {
    provider?: 'tavily' | 'brave' | 'searxng'
    apiKey?: string
    baseUrl?: string
    maxResults?: number
  }
  /**
   * 开一个**子代理**：给它一段任务，它自己跑完，只把结果交回来。
   *
   * ## 为什么这个能力也是从 `ctx` 注入的
   *
   * 和 `webSearch` 同一条规矩：工具层不该自己去造会话、读配置、摸模型客户端。
   * 那些都属于宿主层，工具只声明"我需要能开子代理"，由会话把实现塞进来。
   *
   * ## 为什么不在这里给出自定义选项（工具子集、模型、温度…）
   *
   * v1 刻意**不给** —— 每多一个选项，就多一种"子代理和父代理行为不一致"的
   * 情况，而那些不一致**不会报错**，只会让结果变得没法解释。
   * 子代理继承父会话的一切（模型、模式、策略、恢复），这条先说死。
   *
   * 返回的 `text` 是**有界**的（由实现截断）—— 子代理的价值是"上下文隔离"，
   * 把它的整段历史搬回来就等于没开子代理。
   */
  spawnAgent?: (input: {
    prompt: string
    /** 给这次委派起个名字，只用于日志/错误信息 */
    name?: string
    signal?: AbortSignal
  }) => Promise<{
    /** 子代理最后一条回复（已截断） */
    text: string
    /** 子代理的会话 id —— 出事时可以顺着它去查 */
    sessionId: string
    /** 它跑了几轮 */
    turns: number
    /** 它花掉的 token（会并入父会话的累计） */
    usage?: { inputTokens: number; outputTokens: number }
  }>
  /**
   * 技能能力：按类型查名字、按名字读正文。
   *
   * 和 `webSearch` / `spawnAgent` 同一条规矩：工具只声明「我需要它」，实现由
   * 会话层注入。工具层不自己扫工作区、不自己算哈希、不自己判确认状态 ——
   * 那些都属于宿主层。
   *
   * 类型是**只导入**（`import type`）的：`tools/types.ts` 会进浏览器程序，
   * 而技能层的实现带着 `node:crypto` / `node:fs`，不能被打包进去。
   */
  skills?: SkillToolApi
  /**
   * 插件工具在执行期需要的两个动作（取密钥、报告违规）。
   *
   * 和 `skills` 一样由会话层注入：工具层不读配置、不查插件状态。
   * 插件工具的**根目录**也从 `ctx.root` 来，不从闭包来 —— 工具对象是所有
   * 工作区共用的，闭包捕获工作区会让它在别的工作区里用错目录。
   */
  pluginEnv?: PluginEnvApi
}

export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_OUTPUT_CHARS = 60_000

export type ToolErrorKind =
  /** 没有这个工具 */
  | 'unknown_tool'
  /** 参数不符合 schema */
  | 'invalid_args'
  | 'not_found'
  | 'already_exists'
  /** 路径逃出了工作区 */
  | 'outside_root'
  | 'is_a_directory'
  | 'not_a_directory'
  /**
   * `grep` 的正则写错了。
   *
   * 单列的理由：含糊地回「没有匹配」的话，模型会当成「这个仓库里没有」——
   * 而它只是正则写错了，于是会基于一个**错的前提**继续往下做。
   * 这个码告诉它「换参数重试」。
   */
  | 'bad_pattern'
  /**
   * `edit` 的 `oldString` 在文件里出现了多次，**一处都没改**。
   *
   * 这是整个工具集里最要紧的一个码。锚点不唯一时它有两条路：
   * 改第一处（猜），或者报错。**猜的代价是改错了地方而且不报错** ——
   * 那是最糟的一类失败：文件看起来改成功了，而真正要改的那处没动。
   * 所以这里选报错，并把这个码单独给出来，让调用方知道「补上下文再来」。
   */
  | 'ambiguous'
  /** `edit` 的 oldString 和 newString 一样 —— 这次调用什么都不会变 */
  | 'no_change'
  /** 调用前或执行中被取消 */
  | 'aborted'
  | 'timeout'
  /** 被沙箱拒绝。**与「命令本身失败」不同**：重试同一个命令不会有不同结果。 */
  | 'sandbox'
  | 'failed'

export interface ToolError {
  kind: ToolErrorKind
  message: string
}

export interface ToolResult {
  ok: boolean
  /** 回填给模型看的文本。失败时也应尽量有内容，方便模型自我修正。 */
  content: string
  /** 结构化数据，给代码用（模型看不到） */
  data?: unknown
  error?: ToolError
}

export interface Tool<A = unknown> {
  readonly name: string
  readonly description: string
  /** JSON Schema。既是给模型看的声明，也是运行时的校验依据。 */
  readonly parameters: Record<string, unknown>
  readonly risk: RiskLevel
  run(args: A, ctx: ToolContext): Promise<ToolResult>
}

/**
 * 注册表里存的擦除类型。
 *
 * 注意 run 的参数是 never：按函数参数逆变规则，任何 Tool<A> 都能赋给 AnyTool，
 * 而调用方必须先通过 schema 校验才能拿到这个值。工具定义处仍然有完整类型。
 */
export interface AnyTool {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly risk: RiskLevel
  run(args: never, ctx: ToolContext): Promise<ToolResult>
}

export function okResult(content: string, data?: unknown): ToolResult {
  return { ok: true, content, data }
}

export function failResult(
  kind: ToolErrorKind,
  message: string,
  extra: { content?: string; data?: unknown } = {},
): ToolResult {
  return {
    ok: false,
    content: extra.content ?? message,
    data: extra.data,
    error: { kind, message },
  }
}
