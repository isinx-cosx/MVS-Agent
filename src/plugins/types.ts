/**
 * 插件层的公共类型与硬上限。
 *
 * ## 这一层是什么
 *
 * 插件 = **一批新工具的声明**。v1 只有一种形态：清单里写一条 argv，宿主动手
 * spawn。插件**不自带代码进宿主进程** —— 进程内模块能读 `config.json`（里面有
 * 明文密钥）、能绕开策略判定点、能改恢复层的快照，一条就能废掉这个项目的
 * 三个不变量。见 `docs/技能与插件设计.md` 的插件部分。
 *
 * ## 关于「这里没有沙箱」
 *
 * 必须写清楚：命令型插件能做的事，就是**用户能做的事**。安全不来自"它不能"，
 * 来自三样：
 *   1. 风险等级决定**要不要问人**（策略层）
 *   2. `write` / `execute` / `network` 一次调用做**整树快照**，撤得回（恢复层）
 *   3. 密钥**默认一个都不给**，只有清单逐项声明才注入
 */

/** 插件名上限。要留出对外工具名 `plugin__<插件>__<工具>` 的长度预算 */
export const PLUGIN_NAME_MAX = 20
/** 单个工具名上限 */
export const PLUGIN_TOOL_NAME_MAX = 20
/**
 * 对外工具名总长上限。
 *
 * 64 是模型侧函数名的硬限制。20 + 20 + `plugin__`（8）+ `__`（2）= 50，
 * 留了 14 的余量 —— 但校验时仍然按真实拼接长度算，不靠算术推。
 */
export const PLUGIN_TOOL_FULL_NAME_MAX = 64
/** 工具描述上限（它进常驻前缀，每个请求都要带） */
export const PLUGIN_DESCRIPTION_MAX = 200
/** 参数 schema 的属性数上限 */
export const PLUGIN_PARAMS_MAX_PROPS = 20
/** 参数 schema 序列化后的长度上限 */
export const PLUGIN_PARAMS_MAX_CHARS = 4_000
/** 单个插件的工具数上限 */
export const PLUGIN_TOOLS_MAX = 20
/** 一个工作区启用的插件工具总数上限（含内置 15 个） */
export const PLUGIN_TOOLS_PER_WORKSPACE_MAX = 50
/** 超时上限 */
export const PLUGIN_TIMEOUT_MAX_MS = 120_000
/** 默认超时 */
export const PLUGIN_TIMEOUT_DEFAULT_MS = 30_000
/** 输出上限（和 run_command 一致） */
export const PLUGIN_OUTPUT_MAX_CHARS = 60_000

/** 对外工具名的前缀。所有插件工具都以它开头，用来识别归属 */
export const PLUGIN_PREFIX = 'plugin__'

export type PluginRisk = 'read' | 'write' | 'execute' | 'network'

const RISKS: readonly PluginRisk[] = ['read', 'write', 'execute', 'network']

export function isPluginRisk(value: string): value is PluginRisk {
  return (RISKS as readonly string[]).includes(value)
}

/**
 * 一条工具声明。**不含任何可执行代码**，只有一条 argv。
 *
 * 没有 `shell` 字段，也不接受它：一旦允许 shell，`{{path}}` 就从
 * "一个字符串参数"变成"一段可以被注入的脚本"。而 argv 模式没有分词，
 * 替换后永远只占一个元素 —— 这是选 argv 的全部理由。
 */
export interface PluginToolRun {
  type: 'command'
  /** argv 数组。允许 `{{参数名}}` 占位；不允许出现 shell 字段 */
  argv: string[]
  timeoutMs?: number
  /** 参数怎么传：`json` = 整个参数对象 JSON 化后走 stdin；`none` = 不传 */
  stdin?: 'json' | 'none'
  /** stdout 怎么解：`text` = 原样；`json` = 按 {ok, content, data?} 解析 */
  output?: 'text' | 'json'
}

export interface PluginToolSpec {
  name: string
  description: string
  risk: PluginRisk
  parameters: Record<string, unknown>
  /**
   * 哪些参数是**路径**。
   *
   * 宿主会先用 `resolveInsideRoot` 解析它们（做越界与符号链接检查），
   * 然后把参数值**换成规范化后的绝对路径**，再去做模板替换。
   *
   * 顺序不能反：先替换再校验，argv 里放的就是用户原始字符串，
   * 校验的对象和实际执行的不是同一个值 —— 那是典型的 TOCTOU 形状。
   */
  pathArgs?: string[]
  /** 需要注入的环境变量：`{ "FOO_TOKEN": "webSearch.apiKey" }`（配置路径） */
  env?: Record<string, string>
  run: PluginToolRun
}

export interface PluginManifest {
  schema: 1
  name: string
  version?: string
  description?: string
  tools: PluginToolSpec[]
}

export interface PluginProblem {
  path: string
  name: string | null
  message: string
}

export interface PluginNote {
  path: string
  message: string
}

/**
 * 一个已安装插件的运行态。
 *
 * 状态是四选一，都和「能不能用」直接相关：
 *   enabled  已确认 + 已在当前工作区启用 → 工具出现在模型手里
 *   disabled 人显式关掉了
 *   pending  哈希对不上（新装的，或清单被改过）→ 要人确认
 *   broken   清单不合规 → `message` 说原因
 */
export type PluginStatus = 'enabled' | 'disabled' | 'pending' | 'broken'

export interface PluginRecord {
  /** 安装目录的绝对路径 */
  dir: string
  manifest: PluginManifest
  /** `plugin.json` 的 sha256 前 16 位 */
  hash: string
  approved: boolean
  enabled: boolean
  /** 违反自己声明的风险等级（声明 read 却改了工作区）时的警告文字 */
  suspect?: string
  toolNames: string[]
}

export interface PluginView {
  plugins: PluginRecord[]
  problems: PluginProblem[]
  notes: PluginNote[]
}

/** 给界面的形状（协议层用它，避免把 Manifest 全量吐给前端） */
export interface PluginSummaryShape {
  name: string
  version: string
  description: string
  status: PluginStatus
  toolNames: string[]
  message?: string
  path: string
}

export function pluginToolName(plugin: string, tool: string): string {
  return `${PLUGIN_PREFIX}${plugin}__${tool}`
}

/**
 * 插件工具在执行期需要宿主替它做两件事，都通过 `ToolContext` 注入。
 *
 * 为什么不闭包捕获：工具对象是**所有工作区共用**的（安装是全局的，
 * 工作区只决定"启用没启用"）。所以"改哪个工作区"必须来自 `ctx.root`，
 * "报告给哪个工作区"必须来自 `ctx` —— 闭包捕获工作区会让同一个工具
 * 在不同工作区里用错根目录，那是很难查的一类错。
 */
export interface PluginEnvApi {
  /** 按配置路径取一个密钥（`webSearch.apiKey` 这类） */
  resolveSecret: (configPath: string) => string | undefined
  /** 报告"声明与实际不符"，由调用方决定怎么停用 */
  onSuspect: (plugin: string, message: string) => void
}

/** 从对外工具名反解出插件名。不是插件工具时返回 null */
export function pluginOfTool(toolName: string): string | null {
  if (!toolName.startsWith(PLUGIN_PREFIX)) return null
  const rest = toolName.slice(PLUGIN_PREFIX.length)
  const at = rest.indexOf('__')
  return at <= 0 ? null : rest.slice(0, at)
}
