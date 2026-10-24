/**
 * 运行时：把「工作区 → 会话」这棵树的领域逻辑收在一处。
 *
 * ## 三个设计决定
 *
 * **1. 工作区的身份是规范化路径（realpath），不是目录名。**
 * 同一个目录只能有一个节点。否则会出现两个节点、两套会话、两份恢复存储
 * 指向同一个目录 —— 那是最难排查的一类 bug。目录名只用于显示，重名无所谓。
 *
 * **2. 会话懒加载。**
 * 启动时只读每个会话的**检查点**（一个小 JSON）来算侧栏徽标，不构造完整会话、
 * 不重放事件日志。真正打开某个会话时才加载。几十个会话下这个差别很大。
 *
 * **3. 索引整份推，内容增量推。**
 * 索引变化（开工作区、建会话、状态变）很罕见且很小 → 整份推。
 * 会话内容是高频的 → 走信封增量。这样就不必发明一整套索引增量事件，
 * 也少了一整类「增量对不上」的 bug。
 */

import { createHash, randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import {
  ConfigStore,
  defaultHomeDir,
  maskApiKey,
  maskResolved,
  resolveConfig,
  PROFILES,
  type ConfigOverrides,
  type ResolvedConfig,
} from '../config/index.ts'
import { StateStore, defaultState, type AppState, type SessionRecord } from '../config/state.ts'
import { OpenAICompatibleClient } from '../model/openai-compatible.ts'
import { DEFAULT_COMPACTION } from '../context/types.ts'
import { probeContextLength } from '../model/probe.ts'
import type { ModelClient } from '../model/types.ts'
import { Policy } from '../policy/index.ts'
import {
  alertOf,
  worstAlert,
  type AppStateView,
  type Envelope,
  type RevertOutcome,
  type ServerFrame,
  type SessionAlert,
  type SessionStatus,
  type SettingsView,
  type SessionSummary,
  type SkillStatus,
  type SkillSummary,
  type PluginSummary,
  type TransactionSummary,
  type WorkspaceSummary,
} from '../protocol/types.ts'
import { createRecovery, RecoveryGuard, type RecoveryManager } from '../recovery/index.ts'
import { PluginLibrary } from '../plugins/index.ts'
import { SkillLibrary } from '../skills/index.ts'
import { createDefaultRegistry, JobRegistry, type ToolRegistry } from '../tools/index.ts'
import { isMaskedApiKey, type LocalModelConfig, type ModelConfig } from '../config/types.ts'
import { LocalModelSupervisor, missingConfig, type LocalModelStatus } from './local-model.ts'
import { SessionStore } from './persistence.ts'
import { Session, type ModelSelection } from './session.ts'

/** 每个工作区一个会话目录，放在工作区**之外** —— agent 碰不到运行时自己的状态 */
export function defaultSessionDir(workspace: string, sessionId: string): string {
  const base = process.env.MVS_SESSION_DIR ?? path.join(defaultHomeDir(), 'sessions')
  const workspaceId = createHash('sha256').update(workspace).digest('hex').slice(0, 16)
  return path.join(base, workspaceId, sessionId)
}


/**
 * 后台作业的日志目录。**放在工作区之外** —— 和会话目录同一个理由：
 * agent 不该能通过文件工具读到自己作业的日志，那是一条绕开注册表的旁路。
 * 它还会被无限追加，留在工作区里也会污染用户的 git status。
 */
export function jobsDirFor(workspace: string): string {
  const base = process.env.MVS_JOB_DIR ?? path.join(defaultHomeDir(), 'jobs')
  const workspaceId = createHash('sha256').update(workspace).digest('hex').slice(0, 16)
  return path.join(base, workspaceId)
}

interface WorkspaceEntry {
  path: string
  recovery: RecoveryManager
  /** 后台作业，按工作区一份。见 `jobs.ts` 顶部那段关于恢复层缺口的说明 */
  jobs: JobRegistry
  executor: RecoveryGuard
  /**
   * 技能库，按工作区一份。
   *
   * 和 `jobs` 同级，理由是同一个：技能的确认状态存在
   * `<工作区>/.mvs/skills.json`，它天生属于这个工作区，
   * 换个工作区就是另一套技能。
   */
  skills: SkillLibrary
  /**
   * 插件库，按工作区一份。
   *
   * 注意「安装」与「启用」的层次不同：插件装在 `<MVS_HOME>/plugins`（全机器共享），
   * 而启用状态存在 `<工作区>/.mvs/plugins.json`。所以这个对象里既有全局信息
   * （装了哪些），也有本工作区的信息（启用了哪些）。
   */
  plugins: PluginLibrary
}

interface SessionEntry {
  record: SessionRecord
  store: SessionStore
  /** 懒加载。undefined = 还没打开过 */
  session: Session | null
  /** 未加载时的状态，从检查点读出来。加载之后由会话自己提供 */
  cached: {
    status: SessionStatus
    turn: number
    step: number
    pendingTool?: string
    interruptedTool?: string
  }
  /** 上次广播给客户端的告警级别，用来判断「值不值得推一份新索引」 */
  lastAlert: SessionAlert
}

export interface RuntimeOptions {
  config?: ConfigStore
  state?: StateStore
  /** 命令行传进来的覆盖值。**让 Runtime 成为配置的唯一事实来源**，避免两处各解析一次 */
  overrides?: ConfigOverrides
  /** 窗口探测。测试里可关掉 */
  probe?: boolean
  /**
   * 模型客户端工厂。
   *
   * 默认按解析出的配置建 `OpenAICompatibleClient`。测试注入脚本化的假模型，
   * 以后接第二家形状不同的端点也从这里换 —— 会话本身不关心模型怎么来的。
   */
  modelFactory?: (resolved: ResolvedConfig) => ModelClient
}

export class Runtime {
  #config: ConfigStore
  #stateStore: StateStore
  #registry: ToolRegistry = createDefaultRegistry()
  #overrides: ConfigOverrides

  /**
   * **供应商库的原始快照**（`config.providers`）。
   *
   * ## 为什么要在这里存一份
   *
   * `#resolved`（`ResolvedConfig`）只装**当前生效**的那一份 —— 那是模型层
   * 需要的东西。但设置页面要的是**整库**（用户要能看见、能编辑别的供应商），
   * 而 `maskResolved()` 是从 `#resolved` 派生的，所以它天然拿不到其余那些。
   *
   * 于是「加了一个供应商 → 保存成功 → 界面上看不到」：写入那条路是通的
   * （文件里确实有），**只是读的那条路少了一段**。这条注释就是那次事故的记录。
   *
   * ⚠️ 这里面**可能含明文密钥** —— `#settingsView()` 出去之前必须逐个打码。
   */
  #providers: Record<string, ModelConfig> = {}
  /** `config.activeProvider`。undefined = 用 `model` 段那份 */

  #workspaces = new Map<string, WorkspaceEntry>()
  #sessions = new Map<string, SessionEntry>()
  /** 正在构造中的会话。见 `ensureSession` —— 它防的是一次崩溃，不是一个性能问题 */
  #loading = new Map<string, Promise<Session | undefined>>()

  #listeners = new Set<(frame: ServerFrame) => void>()
  #resolved: ResolvedConfig
  /**
   * 本地模型服务（`llama-server`）的监管器。
   *
   * 它管的是**进程**，不是「当前用哪个模型」—— 换模型是配置的事，
   * 而它是「按配置把那个进程拉起来并盯着」。
   */
  #localModel = new LocalModelSupervisor(undefined)
  /**
   * 最近一次生效的**原始**配置。
   *
   * 和 `#resolved` 的区别：那个是解析+探测之后的结果（模型、窗口、密钥来源），
   * 而有些字段**解析之后就不在了** —— `localModel` 的启动参数就是这种，
   * 它们是「怎么把进程拉起来」的信息，不是「当前用哪个模型」。
   */
  #localModelConfig: LocalModelConfig | undefined
  #windowTokens = DEFAULT_COMPACTION.windowTokens
  #windowSource = '保守默认'
  #warnings: string[] = []
  #appState: AppState = defaultState()
  #probe: boolean
  #modelFactory: ((resolved: ResolvedConfig) => ModelClient) | null

  constructor(options: RuntimeOptions = {}) {
    this.#config = options.config ?? new ConfigStore()
    this.#stateStore = options.state ?? new StateStore()
    this.#overrides = options.overrides ?? {}
    this.#probe = options.probe ?? true
    this.#modelFactory = options.modelFactory ?? null
    this.#resolved = resolveConfig({ config: { version: 1 }, overrides: this.#overrides })
  }

  /** 解析后的生效配置。**打码后的版本在 `state().config` 里** */
  get resolved(): ResolvedConfig {
    return this.#resolved
  }

  get configPath(): string {
    return this.#config.configPath
  }

  get statePath(): string {
    return this.#stateStore.path
  }

  get warnings(): string[] {
    return [...this.#warnings]
  }

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  async init(): Promise<{ warnings: string[] }> {
    const warnings: string[] = []

    const loadedConfig = await this.#config.load()
    warnings.push(...loadedConfig.warnings)
    const stateLoaded = await this.#stateStore.load()
    warnings.push(...stateLoaded.warnings)
    this.#appState = stateLoaded.state

    await this.#applyConfig(loadedConfig.config)

    // 恢复工作区：目录可能已经被删了，那样就静默跳过并报警
    for (const record of this.#appState.workspaces) {
      try {
        await this.#mountWorkspace(record.path)
      } catch (err) {
        warnings.push(`工作区打不开，已跳过：${record.path}（${messageOf(err)}）`)
      }
    }

    // 恢复会话索引：只读检查点，不加载完整会话
    for (const record of this.#appState.sessions) {
      if (!this.#workspaces.has(record.workspace)) continue
      this.#registerSession(record)
    }

    /*
     * ★ 自动启动本地模型。
     *
     * ⚠️ **故意不 await。** 载入 20 GB 要几十秒，阻塞在这里会让守护进程的
     * 引导迟迟不返回 —— 而那时界面还没起来，用户看到的是一个空白页，
     * 完全不知道后面有人在等一个模型。所以这里只**发起**，
     * 状态由 `/local-model` 反映，界面自己轮询。
     */
    this.#localModel.autoStart()

    this.#warnings = warnings
    return { warnings }
  }

  /** 读配置 → 解析 → 探测窗口。配置变化时可以再调用一次 */
  async #applyConfig(config: AppStateConfig): Promise<void> {
    this.#resolved = resolveConfig({ config, overrides: this.#overrides })
    this.#warnings.push(...this.#resolved.warnings)

    /*
     * 供应商库的原始快照。`#resolved` 只装当前生效那一份，而设置页面要整库 ——
     * 不缓存的话「加供应商」会出现"写入成功、界面看不到"。
     */
    this.#providers = { ...(config.providers ?? {}) }

    /*
     * 把本地模型的配置交给监管器。
     *
     * ⚠️ **这里只更新配置，不重启进程。** 改端口之类的参数时，
     * 一个正在载入 20 GB 的进程被无声杀掉是最糟的行为 —— 用户只是想改个数字，
     * 结果模型没了。要让它按新参数跑，显式点「重启」。
     */
    this.#localModel.update(config.localModel)
    this.#localModelConfig = config.localModel

    const probe =
      this.#resolved.contextWindow === undefined && this.#probe
        ? await probeContextLength({
            baseUrl: this.#resolved.baseUrl,
            model: this.#resolved.model,
            ...(this.#resolved.apiKey === undefined ? {} : { apiKey: this.#resolved.apiKey }),
          }).catch(() => null)
        : null

    this.#windowTokens =
      this.#resolved.contextWindow ?? probe?.contextLength ?? DEFAULT_COMPACTION.windowTokens

    this.#windowSource =
      this.#resolved.contextWindow !== undefined
        ? '由你声明'
        : probe?.contextLength !== undefined
          ? `探测到：${probe.evidence ?? probe.source}`
          : `保守默认 —— ${probe?.error ?? '未探测'}`
  }

  /**
   * 只改**模型相关的几项**，其余设置原样保留。
   *
   * ## 为什么不能直接把补丁丢给 `applyConfig`
   *
   * `applyConfig(input)` 走的是 `ConfigStore.save` → `normalizeConfig`，
   * 而 `normalizeConfig` 对**缺失的字段填默认值**。所以传一个
   * `{ model: { model: 'x' } }` 进去，**权限模式、上下文设置、端口全会被重置** ——
   * 用户只是想换个模型，结果工作区的写入权限也变了。那种事不会报错，
   * 只会某天安静地出问题。
   *
   * 所以这里**先把现有配置读出来、合并、再整体保存**。
   * 合并放在服务端是有意的：只有这里知道完整配置长什么样。
   *
   * @param patch - 只写想改的字段。`contextWindow: null` 表示「清掉，回到自动探测」
   */
  async updateModel(patch: {
    profile?: string
    baseUrl?: string
    model?: string
    contextWindow?: number | null
    /**
     * API 密钥。**空串 = 清掉**（和 `contextWindow: null` 同一个语义：
     * "显式地不要它了"和"这次不改它"必须分得开）。
     *
     * ⚠️ 这一项**缺失了很久**，而缺的后果不是报错、是"设置页里那个密钥框
     * 改了存不进去"。所以垫片那边一度只能如实回一条「不接受 apiKey，请手改
     * config.json」—— 那不是设计，那是这一项没做。
     */
    apiKey?: string
    /**
     * 当前供应商下的**可选模型目录**。**空数组 = 清掉**。
     *
     * 和上面的 `model` 是两件事：`model` 是"现在用哪个"，这是"有哪些"。
     * 只有 `model` 的话，界面上「添加模型」加出来的第二行**无处可放** ——
     * 那正是"加了、保存了、没了"的根因。
     */
    models?: string[]
    /**
     * 供应商库的**合并式**更新：只覆盖提到的 route，没提到的原样保留。
     *
     * 合并而不是整体替换，是因为界面一次只改一个供应商 ——
     * 整体替换的话，另一个供应商的密钥会被这次无关的保存顺手抹掉。
     */
    providers?: Record<string, Record<string, unknown>>
    /** 要删掉的 route。**和 `providers` 分开**，见上面那条注释 */
    removeProviders?: string[]
    /** 当前生效的 route。**空串 = 清掉**（回到用 `model` 段） */
    activeProvider?: string
    /**
     * 采样温度。**`null` = 清掉**（回到"不设"），与 `contextWindow` 同一个语义 ——
     * "显式地不要它了"和"这次不改它"必须分得开。
     *
     * 不设 = 请求里不发这个字段，由引擎用自己的默认值（见配置类型的注释）。
     */
    temperature?: number | null
    /** 单次回复的输出上限。**`null` = 清掉**。不设 = 无上限（刻意如此） */
    maxTokens?: number | null
    /**
     * **只用来定位"改哪一个供应商"**，不影响"当前用的是谁"。
     *
     * 原来只有 `activeProvider` 一个字段，而它同时干了两件事：定位 + 切换。
     * 后果很具体：设置页做成卡片、"修改"一个没在用的供应商时，**必然把它切成当前** ——
     * 用户只想改个地址，正在用的模型却被换掉了，而他看不出发生过什么。
     *
     * 分开之后：`route` 定位，`activeProvider` 切换（不传就不切换）。
     */
    route?: string
  }): Promise<{ ok: boolean; message?: string }> {
    /*
     * ⚠️ **越界值在这里就拒掉，不要指望归一化那层。**
     *
     * `normalizeConfig` 对非法值的行为是"警告 + 忽略" —— 那对读配置是对的
     * （不能因为一个坏字段就让整个守护进程起不来），但对**用户刚点的保存**是错的：
     * 界面会显示"已保存"，而配置里什么都没变。这类"成功但没生效"最难查。
     */
    if (patch.temperature !== undefined && patch.temperature !== null) {
      const value = patch.temperature
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
        return { ok: false, message: `温度必须是 0~2 之间的数，收到 ${JSON.stringify(value)}` }
      }
    }
    if (patch.maxTokens !== undefined && patch.maxTokens !== null) {
      const value = patch.maxTokens
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        return { ok: false, message: `输出上限必须是正整数，收到 ${JSON.stringify(value)}` }
      }
    }

    const loaded = await this.#config.load()
    const current = loaded.config

    /*
     * ⚠️ **写入要落到「当前生效的那份」上。**
     *
     * 界面上编辑的可能是 `providers` 里的某一个，而不是 `model` 段。
     * `activeProvider` 指向谁就改谁 —— 否则会出现"改的是 A 的地址，
     * 写进了 B"这种最难查的一类错。
     */
    const activeRoute =
      patch.route !== undefined
        ? patch.route === ''
          ? undefined
          : patch.route
        : patch.activeProvider === ''
          ? undefined
          : (patch.activeProvider ?? current.activeProvider)
    const inLibrary = activeRoute !== undefined && current.providers?.[activeRoute] !== undefined

    const nextModel: Record<string, unknown> = inLibrary
      ? { ...(current.providers?.[activeRoute as string] ?? {}) }
      : { ...(current.model ?? {}) }
    if (patch.baseUrl !== undefined) nextModel.baseUrl = patch.baseUrl
    if (patch.model !== undefined) nextModel.model = patch.model
    if (patch.apiKey !== undefined) nextModel.apiKey = patch.apiKey
    if (patch.models !== undefined) nextModel.models = patch.models
    if (patch.contextWindow === null) {
      delete nextModel.contextWindow
    } else if (patch.contextWindow !== undefined) {
      nextModel.contextWindow = patch.contextWindow
    }
    /* 生成参数：`null` = 删掉（回到"不设"）；不传 = 别动 */
    if (patch.temperature === null) {
      delete nextModel.temperature
    } else if (patch.temperature !== undefined) {
      nextModel.temperature = patch.temperature
    }
    if (patch.maxTokens === null) {
      delete nextModel.maxTokens
    } else if (patch.maxTokens !== undefined) {
      nextModel.maxTokens = patch.maxTokens
    }

    /* 供应商库：先合上这次写的，再删掉要删的 */
    const nextProviders: Record<string, unknown> = { ...(current.providers ?? {}) }
    if (inLibrary) {
      const route = activeRoute as string
      guardCredentialOrigin(
        nextModel as Record<string, unknown>,
        current.providers?.[route] as Record<string, unknown> | undefined,
        `providers.${route}`,
      )
      nextProviders[route] = nextModel
    }
    if (patch.providers !== undefined) {
      for (const [route, value] of Object.entries(patch.providers)) {
        const merged: Record<string, unknown> = {
          ...((nextProviders[route] as Record<string, unknown>) ?? {}),
          ...value,
        }
        guardCredentialOrigin(
          merged,
          nextProviders[route] as Record<string, unknown> | undefined,
          `providers.${route}`,
        )
        nextProviders[route] = merged
      }
    }
    /*
     * ★ **`mvs`（MVS Agent）不允许被删除。**
     *
     * 界面侧已经把它放进了 `base`（内置），所以**不显示**删除按钮
     * （见垫片 `describeSettingsNamespace`）。但**外观不是能力** ——
     * 绕过界面直接发 `removeProviders: ['mvs']` 照样能删掉它。
     *
     * 这里挡在服务端，并且**不静默**：打一条警告说明是谁在删、为什么拒绝。
     * 这是一条**策略**而不是不变量 —— `mvs` 是"这个 Agent 自己的那份配置"，
     * 删掉它会让进程级兜底失去名字。将来要允许删的话，改这里的判断即可。
     */
    for (const route of patch.removeProviders ?? []) {
      if (route === MVS_PROVIDER_ROUTE) {
        console.warn(
          `[config] 拒绝删除「${MVS_PROVIDER_ROUTE}」（MVS Agent 是内置供应商，不允许删除）`,
        )
        continue
      }
      delete nextProviders[route]
    }

    /* `model` 段同样有密钥，同样要过守卫（它不是供应商，但是进程级兜底） */
    if (!inLibrary) {
      guardCredentialOrigin(
        nextModel as Record<string, unknown>,
        current.model as Record<string, unknown> | undefined,
        'model',
      )
    }

    const nextActive =
      patch.activeProvider === ''
        ? undefined
        : (patch.activeProvider ?? current.activeProvider)

    const next = {
      ...current,
      ...(patch.profile === undefined ? {} : { profile: patch.profile }),
      ...(inLibrary ? {} : { model: nextModel }),
      ...(Object.keys(nextProviders).length === 0 ? { providers: undefined } : { providers: nextProviders }),
      ...(nextActive === undefined ? { activeProvider: undefined } : { activeProvider: nextActive }),
    }

    return await this.applyConfig(next)
  }

  /** 模型配置页要的东西：预设列表、当前值、以及**实际生效的窗口** */
  modelConfigView(): {
    profile: string
    profiles: { id: string; baseUrl: string; model: string; windowTokens: number }[]
    model: { baseUrl: string; model: string; contextWindow?: number }
    window: { tokens: number; source: string }
  } {
    const profiles = Object.entries(PROFILES).map(([id, preset]) => ({
      id,
      baseUrl: preset.baseUrl,
      model: preset.model,
      windowTokens: preset.windowTokens,
    }))
    return {
      profile: this.#resolved.profileName,
      profiles,
      model: {
        baseUrl: this.#resolved.baseUrl,
        model: this.#resolved.model,
        ...(this.#resolved.contextWindow === undefined
          ? {}
          : { contextWindow: this.#resolved.contextWindow }),
      },
      window: { tokens: this.#windowTokens, source: this.#windowSource },
    }
  }

  /**
   * 本地模型服务的状态。**只读，没有副作用** —— 界面每次刷新都会调它。
   *
   * 会顺手**纠正**「我们以为在跑但其实死了」的状态，但那纠正的是我们自己的
   * 记录，不碰任何进程。
   */
  async localModelStatus(): Promise<LocalModelStatus & { config: LocalModelConfig | undefined; missing: string[] }> {
    const config = this.#localModelConfig
    const status = await this.#localModel.inspect()
    return { ...status, config, missing: missingConfig(config) }
  }

  /**
   * 启动本地模型。**同步返回**（只落状态、后台载入）—— 见 `LocalModelSupervisor.start`。
   *
   * 别把它改回 async 然后在路由里 await：那样 `POST /local-model` 会挂 45 秒
   * 到 5 分钟才回响应，浏览器那边表现为请求卡死。这个行为我实测撞到过。
   */
  startLocalModel(): LocalModelStatus {
    return this.#localModel.start()
  }

  /** 停掉**我们起的**那个。外部实例不动 */
  async stopLocalModel(): Promise<LocalModelStatus> {
    return await this.#localModel.stop()
  }

  /** 配置被改（UI 或命令行）后调用。**新会话立刻用新配置；已开的会话下次调用时跟上** */
  async reloadConfig(): Promise<{ warnings: string[] }> {
    const warnings: string[] = []
    const loaded = await this.#config.load()
    warnings.push(...loaded.warnings)
    await this.#applyConfig(loaded.config)
    this.#broadcast({ kind: 'state', state: this.state() })
    return { warnings }
  }

  /**
   * 保存新配置（来自 UI 或命令行）。
   *
   * 打码占位符的还原在 `ConfigStore.save` 里处理 —— 客户端回传
   * `••••••••` 表示「我没改密钥」，那一层会保留原值。
   */
  async applyConfig(input: unknown): Promise<{ ok: boolean; message?: string }> {
    try {
      const result = await this.#config.save(input)
      await this.#applyConfig(result.config)
      for (const warning of result.warnings) this.#warnings.push(warning)
      this.#broadcast({ kind: 'state', state: this.state() })
      return { ok: true }
    } catch (err) {
      return { ok: false, message: messageOf(err) }
    }
  }

  // -------------------------------------------------------------------------
  // 工作区
  // -------------------------------------------------------------------------

  /**
   * 打开一个工作区。
   *
   * ⚠️ **这是扩大爆炸半径的操作。** 多工作区把「这个 daemon 只能碰一个目录」
   * 变成了「能碰列表里的任何目录」。关掉这个能力并不真正提升安全性
   * （用户本来就跑着这个 daemon），所以我们的做法是**让它可见**：
   * 留审计、首次打开明示、界面上常驻绝对路径。
   */
  async openWorkspace(inputPath: string): Promise<WorkspaceSummary> {
    const canonical = canonicalize(inputPath)
    const existing = this.#workspaces.get(canonical)

    if (existing !== undefined) {
      // 已经开着：只更新「最近打开」，不重复留审计
      this.#appState = await this.#stateStore.update((state) => {
        const record = state.workspaces.find((w) => w.path === canonical)
        if (record !== undefined) record.lastOpenedAt = new Date().toISOString()
      })
      this.#broadcast({ kind: 'state', state: this.state() })
      return this.#workspaceSummary(canonical)
    }

    await this.#mountWorkspace(canonical)

    const now = new Date().toISOString()
    this.#appState = await this.#stateStore.update((state) => {
      state.workspaces.push({ path: canonical, addedAt: now, lastOpenedAt: now })
      state.audit.push({
        at: now,
        action: 'workspace_opened',
        detail: canonical,
      })
    })

    this.#broadcast({ kind: 'state', state: this.state() })
    return this.#workspaceSummary(canonical)
  }

  /**
   * ⚠️ **这是删除，不是"关闭"。**
   *
   * 原来的注释写着"从索引里移除、不是删除、是忘记" —— **那句话骗过人**（包括
   * 写界面的人，他据此把它列进了"只差一个入口"的清单）。
   *
   * 事实是：工作区**和它名下全部对话**都会从索引里消失，界面上再也找不回来。
   * 目录里的文件确实一个都不动（那本来就不是我们的东西），但**对话是我们的** ——
   * 所以它必须和 `deleteSession` 一个标准：**日志挪进回收站**，而不是留在原地
   * 当孤儿（留在原地的意思是：界面上没了，磁盘上还在，而没有任何命令能找回来）。
   */
  async closeWorkspace(inputPath: string): Promise<void> {
    const canonical = canonicalize(inputPath)
    const entry = this.#workspaces.get(canonical)
    if (entry === undefined) return

    /*
     * 先算出**全部**会话，不只是已加载的那些。
     *
     * 只按 `#sessions` 走会漏：重启之后没人打开过的会话不在内存里，但它们的索引
     * 条目照样会被删掉 —— 那样日志就永远留在磁盘上没人认领了。
     */
    const doomed = this.#appState.sessions
      .filter((s) => s.workspace === canonical)
      .map((s) => s.sessionId)

    // 先把这个工作区下已加载的会话卸掉，避免后台还在跑
    for (const [id, session] of this.#sessions) {
      if (session.record.workspace !== canonical) continue
      session.session?.abort()
      this.#sessions.delete(id)
    }

    // ⚠️ 后台作业也必须收掉。它们是 **detached** 的，工作区从索引里移走了
    // 不等于那些进程会停 —— 不收就等于「关掉工作区之后，它的 dev server 还在
    // 往那个目录里写文件」，而界面上已经看不到它了。
    await entry.jobs.dispose()

    /* 日志进回收站 —— 与 `deleteSession` 同一个去处，同一个标准 */
    const trash = path.join(this.#stateStore.dir, 'trash', 'sessions')
    await mkdir(trash, { recursive: true })
    for (const id of doomed) {
      await rename(defaultSessionDir(canonical, id), path.join(trash, `${id}-${Date.now()}`)).catch(() => {
        // 目录可能已经被手工清掉了，不是问题
      })
    }

    this.#workspaces.delete(canonical)

    this.#appState = await this.#stateStore.update((state) => {
      state.workspaces = state.workspaces.filter((w) => w.path !== canonical)
      state.sessions = state.sessions.filter((s) => s.workspace !== canonical)
    })

    this.#broadcast({ kind: 'state', state: this.state() })
  }

  async #mountWorkspace(canonical: string): Promise<void> {
    if (this.#workspaces.has(canonical)) return

    const recovery = createRecovery({ root: canonical })
    await recovery.init()

    // 后台作业也是**每个工作区一份**：作业的 cwd 落在这个工作区里，它写的东西
    // 也属于这个工作区。放在工作区这一层，才能让「有作业在跑 → 撤销不可信」
    // 这条判断落在正确的范围上（别的工作区在跑东西，不影响这里的归属）。
    const jobs = new JobRegistry(jobsDirFor(canonical))
    await jobs.init()

    /*
     * 技能库也按工作区一份。
     *
     * 这一步会读磁盘（扫两个目录、算哈希），但它只在**挂载工作区**时跑一次；
     * 之后 `state()` 用的是缓存的视图，不会每次 `/state` 都扫一遍。
     * 装完 `npm test` 里有一条专门盯「/state 不读盘」的行为差异时可以参考。
     */
    const skills = await SkillLibrary.open(canonical)

    /*
     * 插件库：和技能一样每工作区一份。
     *
     * `resolveSecret` 是闭包捕获当前解析后的配置 —— 插件声明 `env` 时才会用到它，
     * 而且每次调用现取，所以用户在设置页改完密钥不用重启。
     */
    const plugins = await PluginLibrary.open(canonical, undefined, (configPath) =>
      this.#resolveSecret(configPath),
    )

    /* 把安装的插件变成注册表里的工具（全局一份，工具本身不绑定工作区） */
    this.#syncPluginTools(plugins)

    this.#workspaces.set(canonical, {
      path: canonical,
      recovery,
      jobs,
      executor: new RecoveryGuard(this.#registry, recovery),
      skills,
      plugins,
    })
  }

  /**
   * 换掉注册表里的插件工具。
   *
   * 任何一个工作区的插件库拿到的**工具集合都一样**：安装是全局的，
   * 而"这个工作区启用没有"是在会话层按 `allowsTool()` 过滤的。
   * 所以这里传哪个 library 都等价 —— 传当前这个只是省得再造一个。
   */
  #syncPluginTools(plugins: PluginLibrary): void {
    this.#registry.replacePluginTools(plugins.tools())
  }

  /**
   * 按配置路径取一个字符串（插件 `env` 声明用）。
   *
   * 只做只读遍历，不做任何掩码还原：配置里存的就是真值，
   * 而"给不给"由插件清单声明 + 用户确认决定。
   */
  #resolveSecret(configPath: string): string | undefined {
    const parts = configPath.split('.')
    let cursor: unknown = this.#resolved
    for (const part of parts) {
      if (typeof cursor !== 'object' || cursor === null) return undefined
      cursor = (cursor as Record<string, unknown>)[part]
    }
    return typeof cursor === 'string' && cursor !== '' ? cursor : undefined
  }

  // -------------------------------------------------------------------------
  // 会话
  // -------------------------------------------------------------------------

  async createSession(workspaceInput: string, title?: string): Promise<SessionSummary> {
    const canonical = canonicalize(workspaceInput)
    if (!this.#workspaces.has(canonical)) {
      await this.openWorkspace(canonical)
    }

    const sessionId = randomUUID()
    const now = new Date().toISOString()
    const record: SessionRecord = {
      sessionId,
      workspace: canonical,
      title: title ?? '新会话',
      createdAt: now,
      updatedAt: now,
    }

    // 先把磁盘目录建好，再登记进索引 —— 顺序反了会出现「索引里有、磁盘上没有」
    const store = new SessionStore(defaultSessionDir(canonical, sessionId), sessionId)
    await store.init()

    this.#appState = await this.#stateStore.update((state) => {
      state.sessions.push(record)
    })
    this.#registerSession(record, store)

    this.#broadcast({ kind: 'state', state: this.state() })
    return this.#sessionSummary(sessionId)!
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const entry = this.#sessions.get(sessionId)
    if (entry === undefined) return
    const clean = title.trim() === '' ? '未命名会话' : title.trim()
    entry.record.title = clean
    entry.record.updatedAt = new Date().toISOString()

    this.#appState = await this.#stateStore.update((state) => {
      const record = state.sessions.find((s) => s.sessionId === sessionId)
      if (record !== undefined) {
        record.title = clean
        record.updatedAt = entry.record.updatedAt
      }
    })
    this.#broadcast({ kind: 'state', state: this.state() })
  }

  /**
   * 从索引里移除一个会话。
   *
   * ⚠️ **数据不是删掉，是挪进回收站。** 会话目录被移到
   * `~/.mvs-agent/trash/sessions/`。不可逆的删除在我们整套设计里
   * 都是需要额外理由的操作，这里不该破例。
   */
  async deleteSession(sessionId: string): Promise<void> {
    const entry = this.#sessions.get(sessionId)
    if (entry === undefined) return

    entry.session?.abort()
    this.#sessions.delete(sessionId)

    const trash = path.join(this.#stateStore.dir, 'trash', 'sessions')
    await mkdir(trash, { recursive: true })
    await rename(entry.store.dir, path.join(trash, `${sessionId}-${Date.now()}`)).catch(() => {
      // 目录可能已经被手工清掉了，不是问题
    })

    this.#appState = await this.#stateStore.update((state) => {
      state.sessions = state.sessions.filter((s) => s.sessionId !== sessionId)
    })
    this.#broadcast({ kind: 'state', state: this.state() })
  }

  #registerSession(record: SessionRecord, existingStore?: SessionStore): void {
    const store = existingStore ?? new SessionStore(defaultSessionDir(record.workspace, record.sessionId), record.sessionId)
    this.#sessions.set(record.sessionId, {
      record,
      store,
      session: null,
      cached: { status: 'idle', turn: 0, step: 0 },
      lastAlert: 'none',
    })
  }

  /**
   * 惰性加载：启动时读检查点就够算徽标了，真正打开才构造完整会话。
   *
   * ⚠️ **必须是单飞的（single-flight）。** 这不是优化，是正确性。
   *
   * 界面选中一个会话时，两条路是**同一瞬间**发出的：
   *   - WS 上声明 `watch` → 服务端 `ensureSession`
   *   - HTTP 拉 `/projection` → 服务端 `ensureSession`
   *
   * 没有这道门，同一个会话会被构造两次、`init()` 两次，于是两次并发写同一个
   * 检查点。实测的后果不是"数据有点乱"，而是**整个守护进程退出**：
   * 两次写撞上同一个临时文件名，一个 rename 移走它，另一个 ENOENT。
   *
   * 后来 `writeFileAtomic` 的临时名也改成逐次唯一了（那道防线该有），但这里
   * 仍然要单飞 —— 让同一个会话被加载两次本身就是错的，不该靠"写文件恰好不撞"
   * 来兜。
   */
  async ensureSession(sessionId: string): Promise<Session | undefined> {
    const entry = this.#sessions.get(sessionId)
    if (entry === undefined) return undefined
    if (entry.session !== null) return entry.session

    // 已经有人在建了：复用同一个 promise，别再建第二个
    const pending = this.#loading.get(sessionId)
    if (pending !== undefined) return pending

    const loading = this.#loadSession(sessionId, entry).finally(() => {
      this.#loading.delete(sessionId)
    })
    this.#loading.set(sessionId, loading)
    return loading
  }

  async #loadSession(sessionId: string, entry: SessionEntry): Promise<Session | undefined> {
    const workspace = this.#workspaces.get(entry.record.workspace)
    if (workspace === undefined) return undefined

    await entry.store.init()
    const policy = new Policy({ mode: this.#resolved.defaultMode })

    const session = new Session({
      sessionId,
      workspace: entry.record.workspace,
      model: this.#modelClient(),
      modelName: this.#resolved.model,
      registry: this.#registry,
      policy,
      executor: workspace.executor,
      // 后台作业注册表也传进去 —— 它要进 ToolContext，工具才拿得到
      jobs: workspace.jobs,
      /*
       * 技能库：同样要进 ToolContext，`search_skills` / `use_skill` 才拿得到。
       *
       * 注意它**不随会话变**：一个工作区一份，所有会话共用同一个确认状态。
       * 这是刻意的 —— 确认过一份技能，在这个工作区里所有会话都应该能用它，
       * 否则用户会觉得自己刚才那次确认"没生效"。
       */
      skills: workspace.skills,
      /* 插件：会话层用它过滤工具声明 + 给插件工具注入环境 */
      plugins: workspace.plugins,
      /*
       * 网络搜索的配置，从 `config.json` 读出来后注入。
       *
       * ⚠️ **工具不自己去读配置文件** —— 那条路会让「工具能不能碰到
       * `~/.mvs-agent/config.json`」变成一个隐式依赖，而这个项目里路径权限
       * 是明着设计的（`resolveInsideRoot`，工作区外一律拒）。
       *
       * 没配就不传：`web_fetch` 照常可用，`web_search` 明确报"没配"。
       */
      ...(this.#resolved.webSearch === undefined ? {} : { webSearch: this.#resolved.webSearch }),
      store: entry.store,
      system: `你是 MVS Agent。工作目录是 ${entry.record.workspace}。`,
      context: { windowTokens: this.#windowTokens, ...this.#resolved.context },
      /*
       * 生成参数（后端配置）。两个都可能缺 —— 缺了就不发对应字段。
       *
       * ⚠️ 这里**只读一次**：它是进程级配置，跟 `context` 一样在会话构造时定下。
       * 要改就得重启 daemon（或走日后的配置面板）。刻意不每个请求重取 ——
       * 温度在执行中途变化会让同一轮对话的采样行为前后不一致。
       */
      ...(this.#resolved.temperature === undefined && this.#resolved.maxTokens === undefined
        ? {}
        : {
            generation: {
              ...(this.#resolved.temperature === undefined
                ? {}
                : { temperature: this.#resolved.temperature }),
              ...(this.#resolved.maxTokens === undefined
                ? {}
                : { maxTokens: this.#resolved.maxTokens }),
            },
          }),
      // ★ 让会话每次调模型前重新取一次当前配置。
      // 这样「UI 里改了 key / 换了模型」能立刻生效，不需要重启 daemon；
      // 而换模型时令牌估算的校准会被重置 —— 分词器变了，旧系数是错的。
      modelProvider: {
        current: (selection) => this.#currentModelFor(selection),
      },
    })

    const init = await session.init()
    for (const warning of init.warnings) this.#warnings.push(warning)

    /*
     * ★ **把记下的会话级选择交回去。**
     *
     * 两个来源：内存里的 `#sessionSelections`（本次进程里选过）和
     * **会话记录里的 `model`**（上次进程留下来的 —— 这条是"跑完重启还在"的关键→）。
     */
    const remembered =
      this.#sessionSelections.get(sessionId) ??
      (entry.record.model === undefined
        ? undefined
        : {
            ...(entry.record.model.provider === undefined
              ? {}
              : { provider: entry.record.model.provider }),
            model: entry.record.model.model,
          })
    if (remembered !== undefined) {
      this.#sessionSelections.set(sessionId, remembered)
      session.selectModel(remembered.provider ?? '', remembered.model)
    }

    session.subscribe((envelope) => this.#onSessionEvent(sessionId, envelope))
    entry.session = session
    entry.cached = { ...session.runtimeState() }
    return session
  }

  #onSessionEvent(sessionId: string, envelope: Envelope): void {
    const entry = this.#sessions.get(sessionId)
    if (entry === null || entry === undefined) return

    // 内容增量：原样转发
    this.#broadcast({ kind: 'event', envelope })

    // 首条用户消息 → 自动起标题。**截在语义边界**，不硬切到半个词
    if (envelope.event.type === 'turn_started' && entry.record.title === '新会话') {
      void this.renameSession(sessionId, deriveTitle(envelope.event.input))
    }

    // 索引只在**告警级别变化**时才推。每来一个 token 都推一份索引
    // 会把有用的信号淹掉，而且完全没有必要
    const state = entry.session?.runtimeState()
    if (state !== undefined) {
      entry.cached = { ...state }
      const alert = alertOf(state.status)
      if (alert !== entry.lastAlert) {
        entry.lastAlert = alert
        this.#broadcast({ kind: 'state', state: this.state() })
      }
    }
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  state(): AppStateView {
    return {
      workspaces: [...this.#workspaces.keys()].map((p) => this.#workspaceSummary(p)),
      sessions: [...this.#sessions.keys()].map((id) => this.#sessionSummary(id)!).filter(Boolean),
      config: this.#settingsView(),
      // 窗口和它的来源一起给。界面只说一个数字，等于把「这个值是猜的还是量到的」
      // 藏起来了 —— 而它决定了压缩什么时候触发。
      window: { tokens: this.#windowTokens, source: this.#windowSource },
      skills: this.#allSkillSummaries(),
      plugins: this.#allPluginSummaries(),
    }
  }

  /* ── 插件 ─────────────────────────────────────────────────────────── */

  /** 所有工作区的插件，拍平成一张表（和技能同一个理由：确认是逐个的） */
  #allPluginSummaries(): PluginSummary[] {
    const out: PluginSummary[] = []
    for (const workspace of this.#workspaces.values()) {
      for (const summary of workspace.plugins.summaries()) {
        out.push({ workspace: workspace.path, ...summary })
      }
    }
    return out.sort(
      (a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name),
    )
  }

  /**
   * 重新扫描插件目录。
   *
   * 做三件事，顺序有讲究：
   *   1. 每个工作区重读自己的启用状态（`plugins.json` 可能被外部改过）
   *   2. 重扫安装目录（可能刚放进来一个新插件）
   *   3. **换掉注册表里的插件工具** —— 不换的话，新插件的工具不会出现在
   *      模型手里，而旧插件的工具还留着
   */
  async reloadPlugins(workspaceInput?: string): Promise<boolean> {
    const targets =
      workspaceInput === undefined
        ? [...this.#workspaces.values()]
        : [this.#workspaceOf(workspaceInput)].filter(
            (entry): entry is WorkspaceEntry => entry !== undefined,
          )

    if (targets.length === 0) return false

    for (const workspace of targets) await workspace.plugins.reload()

    const first = [...this.#workspaces.values()][0]
    if (first !== undefined) this.#syncPluginTools(first.plugins)

    this.#broadcast({ kind: 'state', state: this.state() })
    return true
  }

  async approvePlugin(
    workspaceInput: string,
    name: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const workspace = this.#workspaceOf(workspaceInput)
    if (workspace === undefined) return { ok: false, message: `未知工作区：${workspaceInput}` }
    const result = await workspace.plugins.approve(name)
    this.#syncPluginTools(workspace.plugins)
    this.#broadcast({ kind: 'state', state: this.state() })
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  }

  async setPluginEnabled(
    workspaceInput: string,
    name: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; message?: string }> {
    const workspace = this.#workspaceOf(workspaceInput)
    if (workspace === undefined) return { ok: false, message: `未知工作区：${workspaceInput}` }
    const result = await workspace.plugins.setEnabled(name, enabled)
    this.#broadcast({ kind: 'state', state: this.state() })
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  }

  /* ── 技能 ─────────────────────────────────────────────────────────── */

  /**
   * 把每个工作区的技能拍平成一张表。
   *
   * 里面包含三种东西，一种都不能少：
   *   · 可用的（approved）
   *   · 待确认的（pending）—— 不列出来，用户永远不知道新仓库带了技能
   *   · 加载失败的（broken）—— 不列出来，「技能消失了」就成了一个谜
   *
   * `broken` 的条目不是从 `view.skills` 来的（那些是加载成功的），
   * 而是从 `view.problems` 里补齐 —— 所以这两段不能合并。
   */
  #allSkillSummaries(): SkillSummary[] {
    const out: SkillSummary[] = []

    for (const workspace of this.#workspaces.values()) {
      const view = workspace.skills.view()

      /* 同名 problem 给 pending 的条目当说明（「内容已变更，需重新确认」之类） */
      const reasons = new Map<string, string>()
      for (const problem of view.problems) {
        if (problem.name !== null) reasons.set(problem.name, problem.message)
      }

      for (const skill of view.skills) {
        const status: SkillStatus = !skill.enabled
          ? 'disabled'
          : skill.approved
            ? 'approved'
            : 'pending'
        const message =
          status === 'pending' ? (reasons.get(skill.name) ?? '尚未确认（第一次发现）') : undefined
        out.push({
          workspace: workspace.path,
          name: skill.name,
          category: skill.category,
          description: skill.description,
          source: skill.source,
          status,
          path: skill.path,
          ...(message === undefined ? {} : { message }),
        })
      }

      for (const problem of view.problems) {
        /* 已经在上面作为 pending 出现的，不重复列 */
        if (problem.name !== null && view.skills.some((skill) => skill.name === problem.name)) continue
        out.push({
          workspace: workspace.path,
          name: problem.name ?? path.basename(path.dirname(problem.path)),
          category: '',
          description: '',
          source: problem.path.startsWith(workspace.path) ? 'project' : 'user',
          status: 'broken',
          message: problem.message,
          path: problem.path,
        })
      }
    }

    return out.sort(
      (a, b) => a.workspace.localeCompare(b.workspace) || a.name.localeCompare(b.name),
    )
  }

  /** 重新扫描某个工作区的技能目录。返回 false = 没有这个工作区 */
  async reloadSkills(workspaceInput: string): Promise<boolean> {
    const workspace = this.#workspaceOf(workspaceInput)
    if (workspace === undefined) return false
    await workspace.skills.reload()
    this.#broadcast({ kind: 'state', state: this.state() })
    return true
  }

  /** 确认一份技能（记下当前哈希）。这是**人**的动作，模型没有对应的工具 */
  async approveSkill(
    workspaceInput: string,
    name: string,
  ): Promise<{ ok: boolean; message?: string }> {
    const workspace = this.#workspaceOf(workspaceInput)
    if (workspace === undefined) return { ok: false, message: `未知工作区：${workspaceInput}` }
    const result = await workspace.skills.approve(name)
    this.#broadcast({ kind: 'state', state: this.state() })
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  }

  /** 停用/启用一份技能。停用只是让它不出现在清单里，不删文件 */
  async setSkillEnabled(
    workspaceInput: string,
    name: string,
    enabled: boolean,
  ): Promise<{ ok: boolean; message?: string }> {
    const workspace = this.#workspaceOf(workspaceInput)
    if (workspace === undefined) return { ok: false, message: `未知工作区：${workspaceInput}` }
    const result = await workspace.skills.setEnabled(name, enabled)
    this.#broadcast({ kind: 'state', state: this.state() })
    return result.ok ? { ok: true } : { ok: false, message: result.message }
  }

  /** 按路径找一个已挂载的工作区。路径不存在或没挂载都返回 undefined */
  #workspaceOf(input: string): WorkspaceEntry | undefined {
    try {
      return this.#workspaces.get(canonicalize(input))
    } catch {
      return undefined
    }
  }

  /**
   * 设置面板要的形状。
   *
   * 从 `maskResolved` 的结果**挑**字段，而不是直接把它当 `SettingsView` 用。
   * 两者的差别是实质的：`MaskedConfig` 是「配置文件的打码快照」，
   * `SettingsView` 是「界面需要的东西」—— 前者多出来的字段（profile、
   * includeUsage、server.port）界面根本不显示，而后者要的 `paths` 前者没有。
   * 直接把前者断言成后者，多出来的字段会悄悄穿过边界，少掉的字段则要到运行时才发现。
   */
  #settingsView(): SettingsView {
    const masked = maskResolved(this.#resolved)
    return {
      model: {
        baseUrl: masked.model.baseUrl ?? '',
        model: masked.model.model ?? '',
        /*
         * 可选模型目录。**和 `providers` 是同一类补丁。**
         *
         * 少了它，「添加模型」的现象是"加了一行、保存成功、刷新只剩一个" ——
         * 因为读的那一侧不知道还有别的。列表用 `#resolved.models`：
         * 它已经把 `model` 排在第一、去过重，和 `providerEntries` 同一个来源。
         */
        models: this.#resolved.models,
        apiKey: masked.model.apiKey,
        apiKeyIsPlaintext: masked.model.apiKeyIsPlaintext,
        ...(masked.model.apiKeySourceVar === undefined
          ? {}
          : { apiKeySourceVar: masked.model.apiKeySourceVar }),
        ...(masked.model.contextWindow === undefined
          ? {}
          : { contextWindow: masked.model.contextWindow }),
        /*
         * 生成参数也要流出去 —— 设置页要靠它**显示当前值**。
         * 只写不读的话，界面只能显示空框，用户没法知道现在是"0.5"还是"没设"。
         */
        ...(masked.model.temperature === undefined
          ? {}
          : { temperature: masked.model.temperature }),
        ...(masked.model.maxTokens === undefined ? {} : { maxTokens: masked.model.maxTokens }),
      },
      permissions: { defaultMode: masked.permissions.defaultMode },
      // ContextConfig 的字段是 Required 的（normalizeConfig 填过默认值），直接透传
      context: masked.context,

      /*
       * ★ **供应商库。** 设置页面靠它列出所有供应商 —— 只有 `model` 那一份的话，
       * 界面上永远只有一个，加出来的"看不见"（而文件里其实有）。
       *
       * ⚠️ **每个供应商的密钥都要打码。** 这里流出去的是给浏览器看的形状，
       * 明文密钥永远不出这个边界 —— 和 `model.apiKey` 是同一条规矩。
       * 漏掉一个的话，那个供应商的明文密钥会随 `/state` 发给页面。
       */
      providers: Object.fromEntries(
        Object.entries(this.#providers).map(([route, cfg]) => [
          route,
          /*
           * ⚠️ **逐字段挑，不要 `...cfg`。**
           *
           * 存储形状（`ModelConfig`）和视图形状（`ModelProviderView`）是两套名字：
           * 直接摊出去会有两个后果，而且都不报错：
           *
           *   1. `models` 存的是 DSH 原形状 `{ id, name?, contextWindow? }[]`，
           *      而视图约定是 `string[]` —— 对象数组会原样流到页面。
           *   2. 存储用 `displayName`，视图和垫片出站那侧读的是 `label`。
           *      少了映射，界面上每个供应商都退回显示 route。
           *
           * 和上面 `#settingsView` 的注释是同一条纪律：两个形状不一样时，
           * 摊开写，别指望 spread 帮你对齐。
           */
          {
            ...(cfg.baseUrl === undefined ? {} : { baseUrl: cfg.baseUrl }),
            /* 协议：存下来就带出去，界面才能如实往返（不再每次跳回默认值） */
            ...(cfg.api === undefined ? {} : { api: cfg.api }),
            ...(cfg.model === undefined ? {} : { model: cfg.model }),
            /*
             * 生成参数也要带出去 —— 设置页的表单按**当前供应商**预填，
             * 少一个字段，那个框就永远是空的，用户分不清"没设"和"读不到"。
             */
            ...(cfg.temperature === undefined ? {} : { temperature: cfg.temperature }),
            ...(cfg.maxTokens === undefined ? {} : { maxTokens: cfg.maxTokens }),
            ...(cfg.models === undefined
              ? {}
              : { models: cfg.models.map((entry) => entry.id) }),
            ...(cfg.displayName === undefined ? {} : { label: cfg.displayName }),
            ...(cfg.apiKey === undefined || cfg.apiKey === ''
              ? {}
              : { apiKey: maskApiKey(cfg.apiKey), apiKeyIsPlaintext: true }),
            ...(cfg.apiKeyEnv === undefined ? {} : { apiKeyEnv: cfg.apiKeyEnv }),
            ...(cfg.contextWindow === undefined ? {} : { contextWindow: cfg.contextWindow }),
            ...(cfg.includeUsage === undefined ? {} : { includeUsage: cfg.includeUsage }),
          },
        ]),
      ),
      activeProvider: this.#resolved.activeProvider,

      // 诊断信息。configPath 是**已经存在**的 getter（CLI 那边在用），
      // 这里顺手让它对界面也可见：用户问「配置到底在哪」不该去翻文档。
      paths: { home: defaultHomeDir(), config: this.configPath },
    }
  }

  #workspaceSummary(canonical: string): WorkspaceSummary {
    const sessions = [...this.#sessions.values()].filter((s) => s.record.workspace === canonical)
    const alerts = sessions.map((s) => alertOf(this.#stateOf(s).status))
    const record = this.#appState.workspaces.find((w) => w.path === canonical)
    const now = new Date().toISOString()

    return {
      path: canonical,
      name: path.basename(canonical) || canonical,
      sessionCount: sessions.length,
      // 折叠时把最紧急的信号上浮 —— 否则折叠就等于把提醒藏起来
      alert: worstAlert(alerts),
      addedAt: record?.addedAt ?? now,
      lastOpenedAt: record?.lastOpenedAt ?? now,
    }
  }

  #sessionSummary(sessionId: string): SessionSummary | undefined {
    const entry = this.#sessions.get(sessionId)
    if (entry === undefined) return undefined
    const state = this.#stateOf(entry)

    return {
      sessionId,
      workspace: entry.record.workspace,
      title: entry.record.title,
      status: state.status,
      alert: alertOf(state.status),
      turn: state.turn,
      step: state.step,
      ...(state.pendingTool === undefined ? {} : { pendingTool: state.pendingTool }),
      ...(state.interruptedTool === undefined ? {} : { interruptedTool: state.interruptedTool }),
      createdAt: entry.record.createdAt,
      updatedAt: entry.record.updatedAt,
    }
  }

  #stateOf(entry: SessionEntry): SessionEntry['cached'] {
    return entry.session?.runtimeState() ?? entry.cached
  }

  /** 在已加载的会话里按会话 id 取。**不去加载** —— 命令处理自己决定要不要加载 */
  getLoaded(sessionId: string): Session | undefined {
    return this.#sessions.get(sessionId)?.session ?? undefined
  }

  getSessionSummary(sessionId: string): SessionSummary | undefined {
    return this.#sessionSummary(sessionId)
  }

  getWorkspacePath(sessionId: string): string | undefined {
    return this.#sessions.get(sessionId)?.record.workspace
  }

  // -------------------------------------------------------------------------
  // 撤销
  //
  // 恢复层是**每个工作区一份**，会话和工作区是多对一 —— 所以入口按会话进，
  // 真正执行时回到工作区。这样界面只需要知道自己正看着哪个会话。
  // -------------------------------------------------------------------------

  #recoveryFor(sessionId: string): RecoveryManager | undefined {
    const workspace = this.getWorkspacePath(sessionId)
    if (workspace === undefined) return undefined
    return this.#workspaces.get(workspace)?.recovery
  }

  /**
   * 列出可撤销的事务。**不加载会话** —— 界面刷新时要用它给每张工具卡找回撤销按钮，
   * 而为了画一个按钮把整个会话读起来是浪费。
   */
  /**
   * 这个会话的可撤销事务，新的在前。
   *
   * `withPaths` 默认 **false**：投影是**每次变化都整份推**的，而一次大改动的路径
   * 数组可以有几千条 —— 为了列表上一个数字把每次推送都撑大不划算。
   * 用户点开某一条要看"到底改了哪些文件"时，再按需要。
   *
   * ⚠️ 顺序要说清楚：**先能看见改了什么，才谈得上决定要不要撤**。
   * （这条函数原来的下游注释写反了 —— 它说"路径在按了撤销之后的报告里"。）
   */
  async listTransactions(
    sessionId: string,
    withPaths = false,
  ): Promise<TransactionSummary[] | undefined> {
    const recovery = this.#recoveryFor(sessionId)
    if (recovery === undefined) return undefined
    const transactions = await recovery.list()
    // 新的在前 —— 人想撤的几乎总是刚发生的那个
    return transactions
      .slice()
      .reverse()
      .map((txn) => ({
        id: txn.id,
        tool: txn.tool,
        summary: txn.summary,
        startedAt: txn.startedAt,
        finishedAt: txn.finishedAt,
        added: txn.changes.added.length,
        modified: txn.changes.modified.length,
        removed: txn.changes.removed.length,
        /*
         * 三个数组**原样**给出（不去重、不排序）—— `diffSnapshots` 已经排过序，
         * 这里再动一次只会让"界面看到的顺序"和"撤销时的顺序"不一致。
         */
        ...(withPaths
          ? {
              paths: {
                added: [...txn.changes.added],
                modified: [...txn.changes.modified],
                removed: [...txn.changes.removed],
              },
            }
          : {}),
        ...(txn.restoredFrom === undefined ? {} : { restoredFrom: txn.restoredFrom }),
      }))
  }

  /**
   * 这个会话所在工作区的后台作业。
   *
   * 返回 `undefined` 只表示**会话不存在**；没有作业时返回空数组。
   * 这个区分重要：界面要能把「没有作业」和「问错了对象」分开显示。
   */
  listJobs(sessionId: string): Array<{
    id: string
    command: string
    running: boolean
    pid: number | null
    startedAt: string
  }> | undefined {
    const workspace = this.getWorkspacePath(sessionId)
    if (workspace === undefined) return undefined
    const entry = this.#workspaces.get(workspace)
    if (entry === undefined) return undefined
    return entry.jobs.list().map((job) => ({
      id: job.id,
      command: job.command,
      running: job.exit === null,
      pid: job.pid,
      startedAt: job.startedAt,
    }))
  }

  /**
   * 撤销一次事务。
   *
   * 返回 `undefined` 只表示**会话不存在**；撤销本身失败会作为 outcome 返回，
   * 而不是抛错 —— 「文件之后被改过，所以我没动它」是一个正常结果，不是异常。
   */
  async revert(
    sessionId: string,
    txnId: string,
    force = false,
  ): Promise<RevertOutcome | undefined> {
    const recovery = this.#recoveryFor(sessionId)
    if (recovery === undefined) return undefined

    const report = await recovery.restore(txnId, { force })

    // 恢复层的报告 → 协议形状。只做一次映射，落盘的和回给调用方的必须是同一份，
    // 否则界面看到的和日志里记的会不一样。
    const outcome: RevertOutcome = {
      txnId: report.transactionId,
      restoreTxnId: report.restoreTransactionId,
      ok: report.ok,
      message: report.message,
      restored: report.restored,
      deleted: report.deleted,
      skipped: report.skipped.map((s) => ({ path: s.path, reason: s.reason })),
      notCovered: report.notCovered,
    }

    // 结果要落盘，否则刷新之后「我撤过没有」就没有答案
    const session = await this.ensureSession(sessionId)
    if (session !== undefined) await session.recordRevert(outcome)

    return outcome
  }

  // -------------------------------------------------------------------------

  subscribe(listener: (frame: ServerFrame) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #broadcast(frame: ServerFrame): void {
    for (const listener of this.#listeners) listener(frame)
  }

  #modelClient(): ModelClient {
    return this.#modelClientFor(this.#resolved)
  }

  #modelClientFor(resolved: ResolvedConfig): ModelClient {
    if (this.#modelFactory !== null) return this.#modelFactory(resolved)
    return new OpenAICompatibleClient({
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      ...(resolved.apiKey === undefined ? {} : { apiKey: resolved.apiKey }),
      includeUsage: resolved.includeUsage,
    })
  }

  /**
   * 一次模型调用的「当前模型」——**会话级选择优先**。
   *
   * ## 为什么选择是会话级的
   *
   * DSH 的设计里 `modelSelection` 是**每个会话**的投影，由该会话自己的
   * `model/selection` / `request/header` 事件推导
   * （`dsh-api-session-controller/lib/types/model-selection-projection.js`）。
   *
   * 而这里以前把「会话里选模型」实现成**写全局 `config.json`** —— 于是在一个
   * 会话里选个模型会把所有会话都改掉，界面上还看不出发生了什么。那是这个功能
   * 一直"不对"的根源。现在：**选择只影响这个会话，绝不碰配置文件。**
   *
   * 没选过、或 route 不在 `providers` 里（含垫片合成的 `mvs`，它表示
   * "用 `model` 段"）时，原样用进程级配置 —— 与以前的行为逐字一致。
   */
  #currentModelFor(selection?: ModelSelection): {
    client: ModelClient
    modelName: string
    windowTokens: number
  } {
    const route = selection?.provider
    const library = route === undefined ? undefined : this.#providers[route]
    const chosen =
      selection === undefined || selection.model === '' ? this.#resolved.model : selection.model

    if (library === undefined) {
      /* 只换了模型名（或 route 是合成的 `mvs`）：端点沿用进程级配置 */
      return {
        client: this.#modelClientFor({ ...this.#resolved, model: chosen }),
        modelName: chosen,
        windowTokens: this.#windowTokens,
      }
    }

    return {
      client: this.#modelClientFor({
        ...this.#resolved,
        baseUrl: library.baseUrl ?? this.#resolved.baseUrl,
        model: chosen,
        ...(library.apiKey === undefined ? {} : { apiKey: library.apiKey }),
      }),
      modelName: chosen,
      /* 那个供应商自己声明过窗口就听它的，否则沿用探测出来的那个 */
      windowTokens: library.contextWindow ?? this.#windowTokens,
    }
  }

  /**
   * **一个会话**选中一个模型（DSH 的 `modelSelection` 语义）。
   *
   * 只改那个会话 —— **不碰配置文件、不影响别的会话**。
   *
   * 记在 Runtime 上而不是只交给会话对象：会话是**惰性实例化**的，
   * 没跑过消息的会话还没有对象。要求它有，就会把"在一个新会话里选模型"
   * 变成「未知会话」——**那是我上一版引入的 bug**。
   *
   * 返回 `false` 只在参数为空时（真的没法执行），不表示"会话不存在"。
   */
  async selectSessionModel(sessionId: string, provider: string, model: string): Promise<boolean> {
    const trimmed = model.trim()
    if (sessionId === '' || trimmed === '') return false
    const selection: ModelSelection = {
      ...(provider === '' ? {} : { provider }),
      model: trimmed,
    }
    this.#sessionSelections.set(sessionId, selection)
    /* 已经实例化了就立刻生效；没有的话建的时候会用上 */
    this.#sessions.get(sessionId)?.session?.selectModel(provider, trimmed)

    /*
     * ★★ **必须落盘。**
     *
     * 原来这个选择**只活在内存里** —— 守护进程一重启就没了，现象正是
     * 「切了模型、切走再回来又变回 MVS Agent」（而这一轮我重启了几十次）。
     * DSH 那边这个选择是**会话的 durable 属性**（由 `model/selection` 事件推导），
     * 所以放在会话记录里、跟着 `state.json` 走，语义是对的。
     */
    const entry = this.#sessions.get(sessionId)
    if (entry !== undefined) {
      const at = new Date().toISOString()
      entry.record.model = selection
      entry.record.updatedAt = at
      this.#appState = await this.#stateStore.update((state) => {
        const record = state.sessions.find((s) => s.sessionId === sessionId)
        if (record !== undefined) {
          record.model = selection
          record.updatedAt = at
        }
      })
      this.#broadcast({ kind: 'state', state: this.state() })
    }
    return true
  }

  /**
   * **会话级模型选择**：`sessionId → { provider, model }`。
   *
   * ⚠️ 为什么不能只调 `entry.session.selectModel`：
   * 会话对象是**惰性实例化**的 —— 没被碰过的会话在 `#sessions` 里只有记录、
   * 没有 `session`。直接要求它存在的话，"在一个还没跑过消息的会话里选模型"
   * 会回「未知会话」并被界面当成失败（**这正是我上一版引入的 bug**）。
   *
   * 所以选择记在**这里**（Runtime 级），建会话时再交回去 ——
   * 「先选后建」和「先建后选」两条路都成立。
   */
  #sessionSelections = new Map<string, ModelSelection>()

  windowInfo(): { windowTokens: number; source: string } {
    return { windowTokens: this.#windowTokens, source: this.#windowSource }
  }

  async dispose(): Promise<void> {
    for (const entry of this.#sessions.values()) entry.session?.abort()
    this.#sessions.clear()

    // ⚠️ **必须把后台作业杀干净。** 它们是 detached 的，守护进程退出**不会**
    // 带走它们 —— 不杀就等于用户每关一次界面，机器上就多留一堆还在跑的
    // 构建/服务进程，而且它们还在往工作区里写文件。
    // 这条在 Ctrl+C 那条路径上也走得到（serve.ts 的 shutdown 会调 dispose）。
    await Promise.all([...this.#workspaces.values()].map((entry) => entry.jobs.dispose()))

    this.#workspaces.clear()
  }
}

// ---------------------------------------------------------------------------
// 凭据的信任边界
// ---------------------------------------------------------------------------

/**
 * 内置供应商的 route —— **MVS Agent 自己那一份配置**。
 *
 * 它由 `normalizeConfig` 从 `model` 段落成真实条目；界面把它当"内置"
 * （不显示删除按钮），服务端也**拒绝删除**它（见 `updateModel`）。
 */
const MVS_PROVIDER_ROUTE = 'mvs'

/**
 * **换了主机就把旧凭据丢掉。**
 *
 * ## 为什么
 *
 * `apiKey` 是「发给某个端点」的信任凭据。把 `baseUrl` 换到别的主机、而凭据
 * 跟着走过去 —— 那是把一把云密钥交给一个新端点。**实测发生过**：DeepSeek 的
 * 密钥被留在了 `https://127.0.0.1:8000/v1` 上（只要那儿有东西在听，
 * 这把密钥就会被发过去）。
 *
 * ## 为什么是"丢掉"而不是"拒绝写入"
 *
 * 界面（DSH 的模型设置页）保存供应商时**从不**携带明文密钥 —— 密钥走
 * `credentials/set` 单独一条。所以"要求同一次请求带新密钥"等于**永远改不了主机**。
 * 正确做法：允许改，但把旧凭据**清掉**并明确报警，让用户为新端点重新填一次。
 *
 * 主机（scheme + host + port）相同、只改路径的情况**不清** —— 那还是同一个端点。
 */
function guardCredentialOrigin(
  next: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  where: string,
): void {
  const before = typeof previous?.baseUrl === 'string' ? previous.baseUrl : ''
  const after = typeof next.baseUrl === 'string' ? next.baseUrl : ''
  if (before === '' || after === '') return
  if (originOf(before) === originOf(after)) return

  const hadKey = typeof previous?.apiKey === 'string' && previous.apiKey !== ''
  const hadEnv = typeof previous?.apiKeyEnv === 'string' && previous.apiKeyEnv !== ''
  if (!hadKey && !hadEnv) return

  /*
   * 这次请求明确给了一个**新**密钥 → 那是用户为新端点填的，放行。
   * ⚠️ 打码占位符**不算**新密钥（它只是"我没改"的记号）。
   */
  const nextKey = typeof next.apiKey === 'string' ? next.apiKey : ''
  if (nextKey !== '' && !isMaskedApiKey(nextKey) && nextKey !== previous?.apiKey) return

  delete next.apiKey
  delete next.apiKeyEnv
  console.warn(
    `[config] ${where} 的端点换了主机（${originOf(before)} → ${originOf(after)}），` +
      `旧凭据已清掉 —— 换主机就是换信任边界，密钥不该跟着走。请为新端点重新填写密钥。`,
  )
}

/** `https://host:port/path` → `https://host:port`；解析不了就退回原字符串 */
function originOf(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return value
  }
}

type AppStateConfig = Parameters<typeof resolveConfig>[0]['config']

/**
 * 规范化路径。
 *
 * **realpath 而不是 resolve** —— 符号链接、大小写、`..` 都会导致同一个目录
 * 出现两种拼写。按「拼写」去重会得到两个节点、两套会话、两份恢复存储
 * 指向同一个目录。目录还不存在时退回 resolve。
 */
export function canonicalize(input: string): string {
  const absolute = path.resolve(input)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** 从第一条用户消息起标题。**截在语义边界**（换行或标点），不硬切到半个词 */
export function deriveTitle(input: string, maxLength = 24): string {
  const flattened = input.trim().replace(/\s+/g, ' ')
  if (flattened === '') return '新会话'
  if (flattened.length <= maxLength) return flattened

  // 优先在标点处断开
  const boundary = flattened.slice(0, maxLength + 6).search(/[。！？，、；：.!?,;:]/)
  if (boundary > 0) return flattened.slice(0, boundary)

  // 退而求其次：在空格处断
  const space = flattened.lastIndexOf(' ', maxLength)
  if (space > maxLength / 2) return flattened.slice(0, space)

  return `${flattened.slice(0, maxLength)}…`
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
