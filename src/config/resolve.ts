/**
 * 配置解析：把「文件 + 环境变量 + 命令行」压成一个生效值。
 *
 * 优先级（后者覆盖前者）：
 *
 * ```
 * profile 预设  →  config.json  →  环境变量  →  命令行参数
 * ```
 *
 * 这个方向是刻意的：**文件是常态，环境变量是部署覆盖，命令行是一次性调试。**
 * 越临时的越优先，和 git / npm / docker 的通行直觉一致。
 */

import {
  API_KEY_MASK,
  defaultConfig,
  maskApiKey,
  type AppConfig,
  type MaskedConfig,
  type ModelConfig,
  type WebSearchConfig,
} from './types.ts'
import type { PermissionMode } from '../policy/types.ts'

export interface Profile {
  baseUrl: string
  model: string
  apiKeyEnv?: string
  includeUsage: boolean
  /** 保守的窗口默认。真正生效值还要经过探测 */
  windowTokens: number
}

/**
 * 命名预设。
 *
 * 窗口值**刻意取保守**：默认值的作用是「不要因为猜错而炸掉」，
 * 而不是「尽量少压缩」。声明或探测到的值总能覆盖它。
 */
export const PROFILES: Record<string, Profile> = {
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    includeUsage: false,
    windowTokens: 32_768,
  },
  /**
   * **llama.cpp 的 `llama-server`**。
   *
   * 和 `ollama` 是两种东西：Ollama 自己管模型、自己起进程；`llama-server`
   * 是**你已经把它跑起来了**，我们只是连上去。所以这里 `model` 是启动时
   * 用 `-m` 指定的那个模型对外暴露的名字（`/v1/models` 里回的那个 id）。
   *
   * ## 窗口值为什么直接写 131072
   *
   * 这个字段的注释写着「保守的窗口默认，真正生效值还要经过探测」，
   * 而探测那层**已经支持 llama.cpp** —— `src/model/probe.ts` 的第三个策略
   * 就是打 `/props` 读 `n_ctx`。所以这里的值只是**探测失败时的兜底**。
   *
   * 写 131072 是因为那是 `llama-server` 的实际配置（实测 `--ctx-size 131072`）。
   * 兜底值写小了不会错，但会**平白多压缩几次**；写大了才会出事。
   * 所以兜底取**实测值**，让探测去纠偏。
   *
   * ⚠️ 上下文不是免费的：128K 的 KV cache 在 fp16 下约 **10 GB**。
   * 服务端那边要用 `--cache-type-k q8_0 --cache-type-v q8_0` 压到 ~5 GB，
   * 否则内存会紧到换页，那时表现是「变慢」而不是「报错」。
   */
  llama: {
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'qwen3.6',
    /*
     * ⚠️ **这里原先是 `false`，是一个过时的保守默认。**
     *
     * `includeUsage` 决定请求里带不带 `stream_options.include_usage` —— 不带的话
     * 端点不回 usage 尾包，于是**拿不到真实 token 数**，连带两件事一起坏掉：
     *
     *   · 上下文估算永远得不到校准（`contextCalibration.samples` 一直是 0）；
     *   · 界面上的"缓存命中率"和"token/秒"永远没有数据。
     *
     * 实测本机 llama-server b11323 **支持**它：带上之后最后一帧会给出
     * `usage.prompt_tokens_details.cached_tokens` 与 `timings.predicted_per_second`。
     * 所以这个默认值改掉了 —— 保守的代价这里是"功能永远不工作"，不值。
     */
    includeUsage: true,
    windowTokens: 131_072,
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    includeUsage: true,
    windowTokens: 64_000,
  },
  fake: {
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'fake',
    includeUsage: true,
    windowTokens: 8_192,
  },
}

/** 命令行 / 环境变量传进来的覆盖值。全部可选 */
export interface ConfigOverrides {
  profile?: string
  /**
   * 指定用 `providers` 里哪个 route，压过配置文件的 `activeProvider`。
   *
   * 有它才让「切供应商」不需要改配置文件 —— CLI 一次性的 `--provider X`
   * 和界面上点一下切换，走的是同一条路。
   */
  provider?: string
  baseUrl?: string
  model?: string
  apiKey?: string
  apiKeyEnv?: string
  contextWindow?: number
  port?: number
  defaultMode?: PermissionMode
  context?: AppConfig['context']
}

/**
 * 密钥来源。**要显示给用户看** —— 「我的 key 到底从哪来的」是个真问题。
 *
 * 注意 `environment` 这一档不够用：`MVS_API_KEY` 和 `apiKeyEnv` 指向的变量
 * （比如 `DEEPSEEK_API_KEY`）都归到它，而这两者的排查方式完全不同 —— 一个是
 * 「谁设了这个专用变量」，另一个是「配置里写的是哪个变量名」。所以配一个
 * `apiKeySourceVar` 把**具体是哪个变量**记下来。
 */
export type ApiKeySource = 'command-line' | 'environment' | 'config-plaintext' | 'none'

export interface ResolvedConfig {
  profileName: string
  baseUrl: string
  model: string
  apiKey?: string
  apiKeySource: ApiKeySource
  /** 来源是 `environment` 时，**具体是哪个环境变量**。变量名不是秘密 */
  apiKeySourceVar?: string
  includeUsage: boolean
  /** 采样温度。`undefined` = 不设，请求里不发这个字段 */
  temperature?: number
  /** 输出上限。`undefined` = 不设（**默认就是无上限**，见配置类型上的注释） */
  maxTokens?: number
  /** 只有用户显式声明过才有值。undefined = 交给探测 */
  contextWindow?: number
  /**
   * 当前生效的供应商 route。
   *
   * 不填时概念上仍是 `mvs`（「本机直连」那个默认供应商）——
   * 界面要用它标出"哪个是选中的"，所以这里给一个确定的值而不是 undefined。
   */
  activeProvider: string
  /**
   * **这个供应商下可以选的模型**，`model` 一定在里面且排第一。
   *
   * 它和 `model` 是两件事：`model` 是"现在用哪个"，这是"有哪些"。
   * 界面上那个模型选择器读的就是它 —— 之前只有 `model` 一个字段，
   * 所以「添加模型」加出来的第二行**无处可放**，只能被丢掉。
   */
  models: string[]
  port: number
  defaultMode: PermissionMode
  context: AppConfig['context']
  /**
   * 网络搜索。**缺省是合法状态**，而且那是默认值。
   *
   * 缺省时 `web_search` 明确报"没配"；`web_fetch` 不受影响
   * （它不需要密钥，也不该被这件事拖住）。
   */
  webSearch?: WebSearchConfig
  warnings: string[]
}

export interface ResolveOptions {
  config: AppConfig
  overrides: ConfigOverrides
  /** 读环境变量。注入点，测试用 */
  env?: Record<string, string | undefined>
}

export function resolveConfig(options: ResolveOptions): ResolvedConfig {
  const env = options.env ?? process.env
  const warnings: string[] = []
  const file = options.config
  const overrides = options.overrides

  /*
   * ⚠️ **先把「当前生效的那份模型配置」解出来。**
   *
   * 三个来源，后者盖前者：
   *
   *     providers[activeProvider]   →  file.model   →   profile 预设
   *
   * `activeProvider` 没设时**整个 `providers` 不参与** —— 所以老配置
   * 一行都不用改，行为和以前一模一样。
   *
   * 指了一个不存在的 route 时**退回 `model` 并警告**：只报警不改名的话，
   * 后面所有显示都会说「用的是那个不存在的」，而显示的和实际用的不一致
   * 正是这个项目一直在避免的那类谎报。
   */
  const activeRoute = overrides.provider ?? file.activeProvider
  const fromLibrary = activeRoute === undefined ? undefined : file.providers?.[activeRoute]
  if (activeRoute !== undefined && fromLibrary === undefined) {
    warnings.push(
      `activeProvider 指的是「${activeRoute}」，但 providers 里没有它 —— 已退回 model 段`,
    )
  }
  /*
   * 合并而不是替换：`model` 段里可能有 `providers[route]` 没写的字段
   * （比如只有 `model` 段设了 `includeUsage`）。**替换的话那些设置会
   * 在切供应商时静默消失** —— 而那看起来像"界面把设置弄丢了"。
   */
  const effective: ModelConfig = { ...file.model, ...(fromLibrary ?? {}) }

  // profile 未知时退回 ollama，**并且把生效的名字也改成 ollama**。
  // 只报警不改名的话，后面所有显示都会说「用的是 does-not-exist」——
  // 显示的和实际用的不一致，正是我们一直在避免的那类谎报。
  const requestedProfile = overrides.profile ?? file.profile ?? 'ollama'
  const known = PROFILES[requestedProfile] !== undefined
  const profileName = known ? requestedProfile : 'ollama'
  const profile: Profile = PROFILES[profileName]!
  if (!known) {
    warnings.push(`未知的 profile「${requestedProfile}」，已退回「${profileName}」`)
  }

  const baseUrl = overrides.baseUrl ?? env.MVS_BASE_URL ?? effective.baseUrl ?? profile.baseUrl

  // 只在**什么都没配**的时候提示。选了 profile 或用配置文件指定了端点都属于「配过了」，
  // 每次启动都警告一遍只会变成噪音，噪音会让人忽略真正的警告。
  const profileFromFallback = overrides.profile === undefined && file.profile === undefined
  if (
    profileFromFallback &&
    overrides.baseUrl === undefined &&
    env.MVS_BASE_URL === undefined &&
    effective.baseUrl === undefined
  ) {
    warnings.push(
      `还没有配置模型端点，在用内置预设「${profileName}」的默认值 ${baseUrl}。` +
        `改掉它：mvs config set model.baseUrl <你的端点>`,
    )
  }

  const model = overrides.model ?? env.MVS_MODEL ?? effective.model ?? profile.model

  // ── 密钥：按来源优先级找，并**记住它是从哪来的** ──────────────────────
  //
  // 优先级：命令行 > MVS_API_KEY > apiKeyEnv 指向的变量 > 文件里的明文
  //
  // **apiKeyEnv 排在明文之前是有意的**：它是一条明确的指令「从那里读」，
  // 不该被一份遗留的明文密钥悄悄压过去。而且它更安全，优先它是更对的默认。
  let apiKey: string | undefined
  let apiKeySource: ApiKeySource = 'none'
  let apiKeySourceVar: string | undefined

  const plaintext = effective.apiKey
  const hasPlaintext =
    plaintext !== undefined && plaintext !== '' && plaintext !== API_KEY_MASK
  const envName = overrides.apiKeyEnv ?? effective.apiKeyEnv ?? profile.apiKeyEnv
  const fromNamedEnv = envName === undefined ? undefined : env[envName]

  if (overrides.apiKey !== undefined && overrides.apiKey !== '') {
    apiKey = overrides.apiKey
    apiKeySource = 'command-line'
  } else if (env.MVS_API_KEY !== undefined && env.MVS_API_KEY !== '') {
    apiKey = env.MVS_API_KEY
    apiKeySource = 'environment'
    apiKeySourceVar = 'MVS_API_KEY'
  } else if (fromNamedEnv !== undefined && fromNamedEnv !== '') {
    apiKey = fromNamedEnv
    apiKeySource = 'environment'
    apiKeySourceVar = envName
    if (hasPlaintext) {
      warnings.push(
        `配置里同时写了 apiKey（明文）和 apiKeyEnv=${envName} —— **用的是 ${envName}**，建议把明文那份删掉`,
      )
    }
  } else if (hasPlaintext) {
    apiKey = plaintext
    apiKeySource = 'config-plaintext'
    if (envName !== undefined) {
      warnings.push(`配置指定从 ${envName} 读密钥，但它是空的 —— 已退回文件里的明文密钥`)
    }
  } else if (envName !== undefined) {
    warnings.push(
      `配置里指定从环境变量 ${envName} 读密钥，但它是空的 —— 请求会因为鉴权失败被拒`,
    )
  }

  const includeUsage = effective.includeUsage ?? profile.includeUsage
  /*
   * 生成参数：**只从用户显式声明的地方取**（配置文件 / 覆盖项），
   * 没有内置默认值。
   *
   * 理由：温度和输出上限都是"替模型做决定"的东西。我们不给默认值 ——
   * 不填就不发这两个字段，让引擎/服务端用它自己的默认；这比在中间猜一个诚实。
   */
  const temperature = effective.temperature
  const maxTokens = effective.maxTokens

  // 只有显式声明或预设里明确的窗口才传下去；否则 undefined 表示「去探测」
  const contextWindow = overrides.contextWindow ?? effective.contextWindow

  const port = overrides.port ?? file.server?.port ?? 3080

  const defaultMode =
    overrides.defaultMode ??
    file.permissions?.defaultMode ??
    (defaultConfig().permissions as { defaultMode: 'workspace-write' }).defaultMode

  /*
   * 网络搜索。
   *
   * 密钥解析**照模型那一套**（环境变量 → 配置文件明文），因为对用户来说
   * "我的密钥从哪来"这个问题不该有两种答案。
   *
   * 没配 `webSearch` 时**整个字段不出现**（而不是给个空壳）—— "没配"和
   * "配了个空的"在下游是两件事：前者该明确不可用，后者是配置写错了。
   */
  const webSearchFile = file.webSearch
  let webSearch: WebSearchConfig | undefined
  if (webSearchFile !== undefined && webSearchFile.provider !== undefined) {
    const namedEnv = webSearchFile.apiKeyEnv
    const fromNamedEnv = namedEnv === undefined ? undefined : env[namedEnv]
    const key =
      fromNamedEnv !== undefined && fromNamedEnv !== ''
        ? fromNamedEnv
        : webSearchFile.apiKey !== undefined && webSearchFile.apiKey !== ''
          ? webSearchFile.apiKey
          : undefined
    webSearch = {
      provider: webSearchFile.provider,
      ...(key === undefined ? {} : { apiKey: key }),
      ...(webSearchFile.baseUrl === undefined ? {} : { baseUrl: webSearchFile.baseUrl }),
      ...(webSearchFile.maxResults === undefined ? {} : { maxResults: webSearchFile.maxResults }),
    }
    /*
     * 配了后端但没密钥 → **启动时就警告**，不要等工具调用时才失败。
     *
     * 那会发生在模型已经决定要用它的时候，用户看到的是"工具报错"，
     * 而不是"我配置漏了一项"。提前说，问题就在它变成故障之前。
     * （`searxng` 例外：自建实例通常不需要密钥。）
     */
    if (key === undefined && webSearchFile.provider !== 'searxng') {
      warnings.push(
        `webSearch 配了 ${webSearchFile.provider} 后端，但没有可用的密钥` +
          `（apiKey 为空、apiKeyEnv${namedEnv === undefined ? ' 未填' : ` 指向的 ${namedEnv} 也没有值`}）`,
      )
    }
  }

  return {
    profileName,
    baseUrl,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
    apiKeySource,
    ...(apiKeySourceVar === undefined ? {} : { apiKeySourceVar }),
    includeUsage,
    /* 生成参数：没设就不进这个对象，会话据此决定"发不发这个字段" */
    ...(temperature === undefined ? {} : { temperature }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    port,
    defaultMode,
    context: { ...file.context, ...overrides.context },
    /*
     * 网络搜索。和模型密钥**走同一套解析规则**（明文 → 环境变量），
     * 因为对用户来说"我的密钥从哪来"这个问题不该有两种答案。
     *
     * `webSearch` 整个缺省是合法的，而且那是默认状态 —— 见类型上的注释。
     */
    ...(webSearch === undefined ? {} : { webSearch }),
    /*
     * 供应商 route 与可选模型。
     *
     * `models` 的**顺序和去重**在这里定：`model`（现在用的）排第一，
     * 后面接 `models` 里其余那些。这样界面上"当前那个"永远在最前面，
     * 而列表是空的时候也至少有它一个 —— 不会出现"供应商下面一个模型都没有"
     * 那种看起来像坏了的空状态。
     */
    activeProvider: fromLibrary === undefined ? 'mvs' : (activeRoute as string),
    models: (() => {
      /*
       * ★ 这里就是那次**摊平**。
       *
       * 配置里存的是 DSH 的原形状（`{ id, name?, contextWindow? }[]`，见
       * `config/types.ts` 里 `models` 的注释：形状必须存原样，否则界面读回去
       * 时 `name` 已经丢了），而运行期只需要 id。
       *
       * ⚠️ 漏掉摊平的表现很具体：对象过不了 `typeof entry === 'string'`，
       * 于是**除当前那一个之外的模型全部消失** —— 界面上就是
       * 「加了一行、保存成功、刷新只剩一个」。
       *
       * 上面那段注释承诺过「顺序和去重都在这里定」，所以两件事都在这里做：
       * 当前那个排第一，其余保持原序去重。
       */
      const listed = Array.isArray(effective.models) ? effective.models : []
      const rest: string[] = []
      for (const entry of listed) {
        const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
        if (id === '' || id === model || rest.includes(id)) continue
        rest.push(id)
      }
      return model === '' ? rest : [model, ...rest]
    })(),
    warnings,
  }
}

/**
 * 给前端看的形状。
 *
 * **明文密钥永远不出这个边界。** 只给打码后的尾巴、以及「它是不是明文存在文件里」
 * ——后者是 UI 必须显示出来的，因为那是用户该知道的风险。
 */
export function maskResolved(resolved: ResolvedConfig): MaskedConfig {
  const plaintext = resolved.apiKeySource === 'config-plaintext'
  return {
    version: 1,
    ...(resolved.profileName === undefined ? {} : { profile: resolved.profileName }),
    model: {
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      apiKey: resolved.apiKey === undefined ? '' : maskApiKey(resolved.apiKey),
      apiKeyIsPlaintext: plaintext,
      // 变量名要传出去：它是「我的 key 从哪来」这个问题的一半答案，而它本身
      // 不是秘密。只给一个 'environment' 的话，用户没法区分「专用变量」
      // 和「配置里 apiKeyEnv 指的那个变量」—— 两者的排查方式完全不同。
      ...(resolved.apiKeySourceVar === undefined
        ? {}
        : { apiKeySourceVar: resolved.apiKeySourceVar }),
      ...(resolved.contextWindow === undefined ? {} : { contextWindow: resolved.contextWindow }),
      includeUsage: resolved.includeUsage,
    },
    server: { port: resolved.port },
    permissions: { defaultMode: resolved.defaultMode },
    context: {
      triggerRatio: resolved.context?.triggerRatio ?? 0.9,
      outputReserveTokens: resolved.context?.outputReserveTokens ?? 4_096,
      keepRecentTurns: resolved.context?.keepRecentTurns ?? 4,
      toolResultThresholdChars: resolved.context?.toolResultThresholdChars ?? 8_192,
      toolResultHeadChars: resolved.context?.toolResultHeadChars ?? 4_096,
      toolResultTailChars: resolved.context?.toolResultTailChars ?? 1_024,
    },
  }
}

/** 解析结果里「模型身份」的指纹。变了就说明该重置校准 */
export function modelIdentity(resolved: ResolvedConfig): string {
  return `${resolved.baseUrl}|${resolved.model}`
}

export { API_KEY_MASK }
export type { MaskedConfig }
