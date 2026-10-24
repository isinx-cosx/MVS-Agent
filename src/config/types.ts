/**
 * 配置的契约。
 *
 * ## 两个文件，不能合并
 *
 * ```
 * config.json   人写的。模型、端口、默认权限。极少变
 * state.json    程序写的。工作区列表、会话列表、审计。常变
 * ```
 *
 * 合并会出事：daemon 每建一个会话就要重写一次状态文件，而那次写入会覆盖掉
 * 用户刚编辑的模型配置。理由和 `events.jsonl` / `checkpoint.json` 分开是同一条——
 * **写入频率不同的东西不该放一个文件里。**
 *
 * ## 模型是全局的，权限模式是会话的
 *
 * 「API 一次配置到处使用」是一条明确的产品要求。但权限模式反过来：
 * 同一个人在这个仓库想只读、在那个仓库想读写，是合理需求。
 * 而为了换个目录就重填一次 API key 不是。
 */

import type { PermissionMode } from '../policy/types.ts'

/**
 * 一个可选的模型。**形状照抄 DSH 的 pi-ai provider profile**，不是我们发明的。
 *
 * 抄的理由很具体：设置页是 DSH 的代码，它读写的就是这套名字。我们换一套的话
 * 每次往返都要翻译，而**翻译层漏一个字段的表现是"填了没用"** ——
 * 那正是这一轮返工的原因。
 */
export interface ModelDefinition {
  id: string
  name?: string
  contextWindow?: number
}

export interface ModelConfig {
  /** OpenAI 兼容端点 */
  baseUrl?: string
  /**
   * **当前生效**的模型名。请求里发的就是它。
   *
   * 它必须出现在 `models` 里（`models` 不填时视为只有它一个）。
   */
  model?: string
  /**
   * 这个供应商下**可以选**的模型。
   *
   * ## 形状照抄 DSH —— **不是字符串数组**
   *
   * DSH 的 provider profile 里 `models` 是 `{ id, name?, contextWindow? }[]`。
   * 我第一版按直觉写成 `string[]`，于是界面发来的对象数组进不了这个槽，
   * 而现象是「加了模型、保存成功、刷新只剩一个」。
   *
   * 运行期只需要 id（`resolveConfig` 把它摊平成 `string[]`），
   * 但**配置里要存原形状** —— 界面读回去的是它，`name` 丢了它就得重编。
   */
  models?: ModelDefinition[]
  /**
   * 界面上显示的名字。**DSH 的字段名，不是 `label`。**
   *
   * 不填时界面用 route（`providers` 的键）。
   */
  displayName?: string
  /**
   * **协议。** DSH 的 `api` 字段：
   * `openai-completions` / `openai-responses` / `anthropic-messages`。
   *
   * ⚠️ 我第一版**收下但不存**，理由是"我们的守护进程只会说 OpenAI 兼容的那种"。
   * 那是个错的取舍：**用户选了协议、我们丢了、然后按默认的发** ——
   * 现象就是"这个供应商填了没用"。收下就要存；做不到就说做不到，
   * 不能假装收下了。
   */
  api?: string
  /**
   * **凭据引用名**（形如 `<ROUTE>_API_KEY`，由 route 派生 —— 见垫片的
   * `deriveKeyRef`，那条规则也是照抄 DSH 的）。
   *
   * ⚠️ DSH 的语义是：**这里存"去哪找密钥"，不是密钥本身。**
   *
   * 我第一版把它映射进了 `apiKey`（那个槽装的是明文密钥），于是把
   * `DEEPSEEK_API_KEY` 这个**名字**当成密钥发给了端点 —— 401 的来源之一。
   */
  apiKeyEnv?: string
  /**
   * 直接写密钥明文。
   *
   * ⚠️ **明文落盘。** Node 没有跨平台的凭据 API（Windows 要 DPAPI，得写 native
   * 或调 PowerShell，在零依赖前提下都不划算）。与其做一个看起来安全、
   * 实际只是混淆的方案，不如存明文并把这件事说清楚。
   *
   * 界面上填的密钥最终落到这里 —— 引用名（`apiKeyEnv`）由 `credentials/set`
   * 那一步同时写下，两者是**一件事的两个视图**。
   */
  apiKey?: string
  /**
   * 上下文窗口。
   *
   * 不填则启动时**探测**（vLLM / OpenRouter / Ollama / llama.cpp 会给），
   * 探不到再退回内置表，最后是保守默认。总之绝不假装知道。
   */
  contextWindow?: number
  /** 是否请求 usage 尾包。部分兼容网关会拒绝这个字段 */
  includeUsage?: boolean
  /**
   * 采样温度。**不填就不发这个字段** —— 由引擎/服务端自己决定默认值，
   * 比我们在中间替它猜一个更诚实。
   */
  temperature?: number
  /**
   * 单次回复的输出上限（token）。**默认不设**（不填就不发 `max_tokens`）。
   *
   * ⚠️ 刻意不给默认值：模型重复输出是**模型层的事实**，拿上限把它盖掉只会让人
   * 看不出模型坏了。这个字段是给人自己用的。
   */
  maxTokens?: number
}

export interface ServerConfig {
  port?: number
}

export interface PermissionsConfig {
  /** 新会话的初始模式。**已存在会话的模式由会话自己的 checkpoint 决定** */
  defaultMode?: PermissionMode
}

export interface ContextConfig {
  triggerRatio?: number
  outputReserveTokens?: number
  keepRecentTurns?: number
  toolResultThresholdChars?: number
  toolResultHeadChars?: number
  toolResultTailChars?: number
}

/**
 * 本地模型服务（llama.cpp 的 `llama-server`）的启动配置。
 *
 * ## 为什么要有这个
 *
 * 模型文件（20 GB 那种）不可能每次都手打一长串参数去起。参数里 `--ctx-size`
 * 和 KV 量化直接决定**内存够不够**，打错了不是报错、是**换页变慢** —— 那种问题
 * 很难归因。所以把这套参数收进配置，由守护进程管起来。
 *
 * ## 三个「不是必需就不做」的取舍
 *
 * 1. **不填 `modelPath` 就什么都不做。** 不是「默认起一个」—— 20 GB 的进程
 *    不该在没有明确指示的情况下被拉起来。
 * 2. **端口上已经有人了就不抢。** 你自己起的实例，守护进程只报告、不接管
 *    （见 `LocalModelState` 的 `external`）。
 * 3. **`extraArgs` 是逃生口，不是主入口。** 常用参数都给了具名字段，
 *    因为具名字段能在界面上解释、能被校验；`extraArgs` 只是给没覆盖到的旗标留的路。
 */
export interface LocalModelConfig {
  /**
   * 守护进程启动时自动拉起。
   *
   * 只有 `modelPath` 也填了才有意义 —— 见上面第 1 条。
   */
  autoStart?: boolean
  /** `llama-server` 可执行文件。不填则按常见位置找（Ollama 自带的那份） */
  serverPath?: string
  /** GGUF 模型文件的绝对路径。**不填 = 这个功能整个不启用** */
  modelPath?: string
  /** 监听端口。要和 `model.baseUrl` 里的端口一致 */
  port?: number
  /**
   * 对外暴露的模型名。
   *
   * ⚠️ 不给的话 `llama-server` 拿**模型文件的完整路径**当模型 id，
   * 那个名字没法写进 `model.model`（换路径就失效）。
   */
  alias?: string
  /** `--ctx-size` / `-c`。**它和 ncmoe 是一对，改一个必须重调另一个** */
  ctxSize?: number
  /** KV cache 的量化类型：`f16` / `q8_0` / `q4_0`。128K 上下文下这个决定成败 */
  cacheTypeK?: string
  cacheTypeV?: string
  /** `-fa`。KV 量化在多数构建上要求它开着 */
  flashAttention?: boolean
  /**
   * `-ngl`：多少层上 GPU。
   *
   * ⚠️ **对 MoE 模型，这个几乎总是 999（全上）。** 它管的是**非专家**部分 ——
   * attention、嵌入、norm —— 那些很小但算得最频繁。
   * 真正占地方的是专家张量，那个由 `cpuMoeLayers` 单独控。
   *
   * 我第一版写 0（全在 CPU），理由是「显存留给小模型」—— 那是我自己编的约束，
   * 代价是**一点 GPU 都没用上**：载入 155 秒，12 GB 显存空着。
   */
  gpuLayers?: number
  /**
   * `-ncmoe N`：**前 N 层的专家权重留在 CPU**。
   *
   * ## 这是 MoE 部署里唯一真正要紧的那个旋钮
   *
   * 20 GB 里约 85% 是专家张量（256 专家 × 41 层）。12 GB 的卡装不下，
   * 所以大部分必须留 CPU、每个 token 从内存流式读。但**不是留得越多越好**：
   *
   *   N 大  → 省显存、但 CPU 侧读得多 → 慢
   *   N 小  → 快、但显存被挤满 → **专家层在 PCIe 上反复换入换出 → 断崖式崩掉**
   *
   * 实测（RTX 5070 12GB + 32GB DDR5）：
   *
   *     ncmoe 20 → 69.78 tok/s   ← 512 上下文下的最优
   *     ncmoe 16 → 33.89 tok/s   ← 断崖
   *     ncmoe 12 → 26.07 tok/s
   *
   * ## ⚠️ 换上下文必须重扫这个值
   *
   * 同样的 ncmoe 20，在 **8192** 上下文下从 69.78 崩到 **27.65** ——
   * 因为 KV cache 吃掉了本该留给专家的显存。这是那条记录里最重要的发现。
   *
   * 128K 下的实测（Qwen3.6）：24=43.15（只剩 121 MiB，危险）、
   * **26=45.06（1063 MiB 余量，最好）**、28=40.30（余量多 11% 但慢 11%）。
   */
  cpuMoeLayers?: number
  /**
   * `-cram N`：KV cache 放 RAM 的兆字节数。
   *
   * 把 KV 挪出显存，等于把显存腾给专家层 —— 和 `cpuMoeLayers` 是一对。
   */
  cacheRam?: number
  /**
   * `--parallel`。
   *
   * ⚠️ **单用户场景必须设 1。** 默认是多 slot，会把显存切成几份，
   * 而显存在这里是最稀缺的资源。
   */
  parallel?: number
  /**
   * `--reasoning`：`on` / `off` / `auto`。
   *
   * ⚠️ **默认 `on`（思考模式默认开启）。** 不填就是开着的；
   * 要关掉得显式写 `"off"`。
   *
   * 注意这和 `Venture-main/run-35b.ps1 -Agent` 预设是反的 —— 那份脚本默认关掉，
   * 理由是「agent 每次调用都要为思考 token 付钱」。那个理由成立，
   * 但这里按用户的要求把默认值定成开。
   */
  reasoning?: string
  /**
   * `--reasoning-format`。**默认 `deepseek`**，和 `reasoning` 成对。
   *
   * 它把思考放进 `reasoning_content`，`content` 保持干净 ——
   * 不设的话思考内容会混进正文，而下游把它当回答解析就会出错。
   */
  reasoningFormat?: string
  /** `--reasoning-budget`：思考 token 上限。负数 = 不限 */
  reasoningBudget?: number
  /** 额外命令行参数。逃生口，见文件头第 3 条 */
  extraArgs?: string[]
}

/**
 * 网络搜索后端。
 *
 * ## 为什么它不是「一个开关」而是一份配置
 *
 * 搜网页这件事**没有免密钥又能长期稳定的公共接口** —— 这是一个事实，不是取舍。
 * 所以这里不预设一个「默认能用」的后端：**没配就是不能用**，
 * 而工具会**明确说是没配**，不去刮某个搜索引擎的 HTML 凑答案。
 *
 * （那条原则是从 DSH 的 web 搜索实现里抄的，它的原话是
 *   "absence of those blocks is an error rather than a prose-scraping fallback"
 *  —— 搜不到要报错，不要退化成解析网页正文。刮 HTML 的接口随对方改版就碎，
 *   而**碎的方式是"偶尔返回垃圾"**，那种错误模型分辨不出来。）
 */
export interface WebSearchConfig {
  /**
   * 后端。不填 = `web_search` 不可用（`web_fetch` 不受影响，它不需要密钥）。
   *
   * - `tavily`    —— 专为 agent 做的搜索 API，返回干净的结构化结果
   * - `brave`     —— Brave Search API
   * - `searxng`   —— **自建实例**，不需要密钥。要填 `baseUrl`
   */
  provider?: 'tavily' | 'brave' | 'searxng'
  /** API 密钥。`searxng` 不需要 */
  apiKey?: string
  /** 从哪个环境变量读密钥。和 `model.apiKeyEnv` 同一个机制 */
  apiKeyEnv?: string
  /** `searxng` 必填（你的实例地址）；另两个可以覆盖默认端点 */
  baseUrl?: string
  /** 一次返回几条。默认 5 */
  maxResults?: number
}

export interface AppConfig {
  version: number
  /** 命名预设：ollama / deepseek / fake。作为兜底默认值 */
  profile?: string
  /**
   * **当前生效**的那份模型配置。
   *
   * 优先级：`providers[activeProvider]` → 本字段 → profile 预设。
   * 也就是说 `activeProvider` 没设时它仍然是全部，**老配置一行都不用改**。
   */
  model?: ModelConfig
  /**
   * 命名的模型供应商库。
   *
   * ## 为什么需要它
   *
   * 界面上「添加模型提供商」是**一个正常功能**，而之前它无处可存 ——
   * 垫片收到 `providers.<新route>` 之后走了「不认识的路径就跳过」，
   * 然后照样回 `ok`。用户看到的是"创建成功、然后它不见了"。
   *
   * 键是 route（小写字母开头的标识符，用于派生凭据名），值是那份配置。
   *
   * ⚠️ 这里面**包括**当前生效的那个 —— route 为 `mvs` 的那份就是
   * 「本机直连」的默认供应商。`model` 和它是同步的（见 `resolve.ts`）。
   */
  providers?: Record<string, ModelConfig>
  /** `providers` 里哪一个是当前生效的。不填 = 用 `model` */
  activeProvider?: string
  server?: ServerConfig
  permissions?: PermissionsConfig
  context?: ContextConfig
  localModel?: LocalModelConfig
  webSearch?: WebSearchConfig
}

export const CONFIG_VERSION = 1

/**
 * 密钥打码占位符。
 *
 * **它同时是协议的一部分**：客户端回传这个值时，服务端保留原密钥。
 * 没有这条规则，UI 每保存一次别的字段就会把密钥抹掉一次。
 */
export const API_KEY_MASK = '••••••••'

export function isMaskedApiKey(value: unknown): boolean {
  return value === API_KEY_MASK
}

/** 给前端看的形状：密钥永远不出明文，只给「有没有」和打码后的尾巴 */
export interface MaskedConfig {
  version: number
  profile?: string
  model: {
    baseUrl?: string
    model?: string
    /** 打码形式，例如 `sk-…8f3a`；没有密钥时为空 */
    apiKey: string
    apiKeyEnv?: string
    contextWindow?: number
    includeUsage?: boolean
    /**
     * 生成参数。**只在这两个值真的设过时才有** —— 没设就是"由引擎决定"。
     *
     * 界面要把"没设"显示成**空框**而不是 0：0 是一个合法且完全不同的取值
     * （温度为 0 是确定性的，和"交给引擎"不是一回事）。
     */
    temperature?: number
    maxTokens?: number
    /** 密钥是不是明文存在配置文件里 —— UI 要把这件事显示出来 */
    apiKeyIsPlaintext: boolean
    /**
     * 当前生效的密钥来自哪个环境变量。
     *
     * 和 `apiKeyEnv`（配置里**要求**从哪读）不是一回事：那个是意图，这个是事实。
     * 两者不一致时（比如 MVS_API_KEY 压过了 apiKeyEnv），用户必须能看出来。
     */
    apiKeySourceVar?: string
  }
  server: { port: number }
  permissions: { defaultMode: PermissionMode }
  context: Required<ContextConfig>
}

/**
 * 默认配置。
 *
 * ⚠️ `webSearch` 在 `Omit` 里 —— **它是可选的，而且"没配"是合法状态**。
 *
 * 不放进 `Omit` 的话 `Required<…>` 会要求它必须有值，于是不得不给一个
 * "默认后端"。而**搜索没有免密钥又能用的默认后端** —— 编一个出来的后果是
 * `web_search` 看起来可用、实际每次失败。宁可它明确地"没配"。
 */
export function defaultConfig(): Required<
  Omit<AppConfig, 'model' | 'localModel' | 'webSearch' | 'providers' | 'activeProvider'>
> & {
  model: ModelConfig
  localModel: LocalModelConfig
  webSearch?: WebSearchConfig
  providers?: Record<string, ModelConfig>
  activeProvider?: string
} {
  return {
    version: CONFIG_VERSION,
    profile: 'ollama',
    model: {},
    server: { port: 3080 },
    permissions: { defaultMode: 'workspace-write' },
    context: {},
    /*
     * 默认**空**，而且 `autoStart` 不打开。
     *
     * 一个 20 GB 的进程不该在用户没明确指示的情况下被拉起来 ——
     * 填了 `modelPath` 才算指示，那时才看 `autoStart`。
     */
    localModel: {},
  }
}

/** 只保留尾巴几位。**任何地方显示密钥都必须走这里** */
export function maskApiKey(key: string): string {
  if (key === '') return ''
  if (key.length <= 8) return API_KEY_MASK
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}
