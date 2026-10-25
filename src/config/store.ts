/**
 * 配置的读写。
 *
 * ## ★★ 硬规则：**MVS Agent 的配置不得被隐式改写**
 *
 * 用户原话：「MVS Agent 的配置又被改了，**不能改，不能改**」。
 *
 * 这个文件是**唯一**写 `config.json` 的地方，所以规则落在这里：
 * 配置只能因为**用户明确的一次配置动作**而改变；任何「顺手写回」「同步一下」
 * 「为了让界面好看」都**不允许**碰它。
 *
 * 能到达这里的只有三条路（见 `docs/现状-全貌.md` 的「硬规则」一节）：
 *   · `POST /model-config` → `Runtime.updateModel`（设置页保存、密钥）
 *   · `POST /command {type:'set_config'}` → `Runtime.applyConfig`（目前无人发送）
 *   · `mvs config` 命令行
 *
 * **守护进程自己从不主动写** —— 启动/本地模型启动/窗口探测走的是私有的
 * `#applyConfig`（只在内存生效、不落盘）。改动这个文件时请先读那一节。
 *
 * 四条绝对不允许发生（都真实发生过）：掩码落盘销毁密钥、`activeProvider` 悬空被丢、
 * 一次操作改所有会话、改 A 供应商却动到全局默认。
 *
 * 另有三条不显眼但会咬人的规则：
 *
 * 1. **坏配置不能让 daemon 起不来。** 解析失败就报警 + 退回默认值 + 继续跑。
 * 2. **但也不能把坏文件静默覆盖掉。** 有人在文件里手写了一个逗号错误，
 *    结果 UI 一保存就把他整个文件冲了 —— 所以保存前先备份成 `.broken-<时间>`。
 * 3. **打码占位符 = 不要动这个密钥。** 前端拿不到明文密钥，保存时必须能表达
 *    「我没改它」。没有这条，UI 每保存一次别的字段就把密钥抹掉一次 ——
 *    而且**每个供应商都要还原，不能只还原 `model` 段**（`providers.<route>.apiKey`
 *    曾经因此被 4 个字符的掩码覆盖销毁，真密钥不可恢复）。
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './atomic.ts'
import { migrate, type Migration } from './migrate.ts'
import {
  API_KEY_MASK,
  CONFIG_VERSION,
  defaultConfig,
  isMaskedApiKey,
  type AppConfig,
  type ModelConfig,
  type ModelDefinition,
} from './types.ts'

/** `MVS_HOME` 覆盖整个状态根目录，测试和便携部署都用得上 */
export function defaultHomeDir(): string {
  return process.env.MVS_HOME ?? path.join(os.homedir(), '.mvs-agent')
}

export interface LoadResult {
  config: AppConfig
  warnings: string[]
  /** 文件新建了（首次运行） */
  created: boolean
  /** 文件存在但解析失败 —— 保存时先备份 */
  broken: boolean
}

export interface SaveResult {
  config: AppConfig
  warnings: string[]
}

export class ConfigStore {
  #dir: string
  /** 上次加载时文件是坏的 → 保存前先把它留一份 */
  #brokenBackupNeeded = false
  #listeners = new Set<(config: AppConfig) => void>()

  constructor(dir: string = defaultHomeDir()) {
    this.#dir = path.resolve(dir)
  }

  get dir(): string {
    return this.#dir
  }

  get configPath(): string {
    return path.join(this.#dir, 'config.json')
  }

  get statePath(): string {
    return path.join(this.#dir, 'state.json')
  }

  async load(): Promise<LoadResult> {
    const warnings: string[] = []
    await mkdir(this.#dir, { recursive: true })

    if (!existsSync(this.configPath)) {
      const config = defaultConfig() as AppConfig
      await writeFileAtomic(this.configPath, `${JSON.stringify(config, null, 2)}\n`)
      return { config, warnings, created: true, broken: false }
    }

    let raw: string
    try {
      raw = await readFile(this.configPath, 'utf8')
    } catch (err) {
      warnings.push(`读不到配置文件：${messageOf(err)}，已退回默认值`)
      return { config: defaultConfig() as AppConfig, warnings, created: false, broken: false }
    }

    let parsed: unknown
    try {
      // 剥掉 PowerShell / 记事本可能塞进来的 UTF-8 BOM
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
    } catch (err) {
      // ★ 坏配置不能让 daemon 起不来。但要说清楚是哪个文件、错在哪。
      warnings.push(
        `${this.configPath} 不是合法 JSON（${messageOf(err)}），已退回默认值。` +
          `保存时会先把它备份成 .broken-* 再覆盖，不会静默丢掉你的内容。`,
      )
      this.#brokenBackupNeeded = true
      return { config: defaultConfig() as AppConfig, warnings, created: false, broken: true }
    }

    /*
     * ⚠️ 版本比程序新时必须**拒绝启动**，不能"警告一下照常跑"。
     *
     * 旧代码读不懂新字段：它会把不认识的字段丢掉，而下一次保存就写回一份
     * 缺字段的配置 —— 那一步之后数据永久没了。所以这里把 `DataTooNewError`
     * 转成一条带文件路径的致命错误，让 `Runtime.init` 与 `serve.ts` 走"起不来"。
     */
    let checked
    try {
      checked = normalizeConfig(parsed)
    } catch (err) {
      if (err instanceof Error && err.name === 'DataTooNewError') {
        throw new Error(`配置文件无法使用（${path.join(this.#dir, 'config.json')}）：${err.message}`)
      }
      throw err
    }
    warnings.push(...checked.warnings)
    return { config: checked.config, warnings, created: false, broken: false }
  }

  /**
   * 保存。
   *
   * `incoming` 通常来自网络（UI 保存），所以**必须校验**。
   * 而且要把打码占位符还原成原来的密钥。
   */
  async save(incoming: unknown): Promise<SaveResult> {
    const warnings: string[] = []
    const existing = await this.#readExisting()

    const checked = normalizeConfig(incoming)
    warnings.push(...checked.warnings)
    const config = checked.config

    /*
     * ★ **打码占位符 = 「我没改密钥，别动它」。**
     *
     * ## 为什么必须逐个供应商都还原（这是一次真实的数据销毁）
     *
     * 出站时密钥被换成 `••••`（见 `maskResolved` / `maskApiKey`）；界面把值原样
     * 传回来时，**掩码不能当真密钥存**。原来这段只处理了 `config.model.apiKey`
     * ——**没处理 `providers.<route>.apiKey`**
     *
     * 后果是实测发生过的：在设置页保存一次别的字段，供应商的**真密钥被 4 个字符的
     * 掩码覆盖销毁**（`apiKey` 长度从 35 变成 4），而界面上一切正常。
     * 这就是「MVS Agent 的配置又被改了」里最伤人的那一种 —— **不可恢复**。
     *
     * 所以：**每个供应商都要还原**，不能只还原 `model` 段那一个。
     */
    if (config.model !== undefined && isMaskedApiKey(config.model.apiKey)) {
      config.model.apiKey = existing?.model?.apiKey
    }
    if (config.providers !== undefined) {
      for (const [route, value] of Object.entries(config.providers)) {
        if (!isMaskedApiKey(value.apiKey)) continue
        const previous = existing?.providers?.[route]?.apiKey
        if (previous === undefined) {
          /*
           * 之前就没有这个密钥 → **不能把掩码留下**。留下的话，它会被当成
           * 真的密钥发出去（发给哪家都不知道）。如实清掉。
           */
          delete value.apiKey
        } else {
          value.apiKey = previous
        }
      }
    }

    if (this.#brokenBackupNeeded) {
      const backup = `${this.configPath}.broken-${Date.now()}`
      try {
        await rename(this.configPath, backup)
        warnings.push(`原配置无法解析，已备份为 ${path.basename(backup)}`)
        this.#brokenBackupNeeded = false
      } catch (err) {
        warnings.push(`备份坏配置失败：${messageOf(err)}`)
      }
    }

    await writeFileAtomic(this.configPath, `${JSON.stringify(config, null, 2)}\n`)

    /*
     * ★ **来源记录：谁在什么时候改了配置的哪些键。**
     *
     * ## 为什么非要有这个
     *
     * 「配置文件怎么自己变了」在这条链路上一直无法回答 —— 因为**能写它的地方
     * 有五条**（`/model-config`、`/command set_config`、CLI、热更新），
     * 而它们最终都汇到这一个函数。没有来源记录时，只能靠**文件指纹**反推是谁
     * （比较改了哪些字段、留了什么值），那是猜测，不是证据。
     *
     * 打一条带**调用栈**的日志之后，"哪里改的"就变成可回答的问题：
     *
     *   · 日志里有这次写入 → 看栈，直接是哪个调用方
     *   · 文件变了但日志里没有 → **外部写入者**（手改、别的进程），
     *     而且能精确到秒
     *
     * ## 只记键名，不记值
     *
     * 配置里有密钥。所以这里只记录**变化的键路径**和值的**类型/长度**，
     * 明文一个字节都不打。
     */
    try {
      const changes = changedKeys(
        (existing ?? {}) as unknown as Record<string, unknown>,
        config as unknown as Record<string, unknown>,
      )
      const stack = new Error('config-save').stack ?? ''
      const frames = stack
        .split('\n')
        .slice(2, 5)
        .map((line) => line.trim())
        .join(' ← ')
      console.info(
        `[config] 写入 ${path.basename(this.configPath)}：` +
          `${changes.length === 0 ? '（值没有变化）' : changes.join(', ')}` +
          `\n         调用方：${frames}`,
      )
      for (const warning of warnings) console.info(`[config] 警告：${warning}`)
    } catch (error) {
      /* 来源记录失败绝不能影响保存本身 */
      console.warn('[config] 来源记录失败：', error)
    }

    for (const listener of this.#listeners) listener(config)
    return { config, warnings }
  }

  /** 配置变化订阅。运行时用它做热更新 */
  subscribe(listener: (config: AppConfig) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async #readExisting(): Promise<AppConfig | null> {
    try {
      const raw = await readFile(this.configPath, 'utf8')
      return normalizeConfig(JSON.parse(raw.replace(/^\uFEFF/, ''))).config
    } catch {
      return null
    }
  }
}

// ---------------------------------------------------------------------------

export interface NormalizeResult {
  config: AppConfig
  warnings: string[]
}

/**
 * 校验并归一化。
 *
 * **为了容忍手写，只挑出能认的字段并逐项检查类型，不认识的就丢掉并报警** ——
 * 而不是整个拒绝。这样用户写错一个字段不会让配置全废。
 */
/**
 * 两个配置对象之间**变化了哪些键路径** —— 供 `ConfigStore.save` 的来源记录用。
 *
 * ⚠️ **密钥类字段只报长度，不报内容。** 配置里有明文密钥，日志会被复制粘贴，
 * 明文一个字节都不能进去。
 */
function changedKeys(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = '',
  out: string[] = [],
): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    if (out.length > 24) return out
    const path = prefix === '' ? key : `${prefix}.${key}`
    const a = before[key]
    const b = after[key]

    if (/apikey/i.test(key)) {
      const la = typeof a === 'string' ? a.length : -1
      const lb = typeof b === 'string' ? b.length : -1
      if (la !== lb) out.push(`${path}(长度 ${la} → ${lb})`)
      continue
    }

    const aObj = a !== null && typeof a === 'object' && !Array.isArray(a)
    const bObj = b !== null && typeof b === 'object' && !Array.isArray(b)
    if (aObj && bObj) {
      changedKeys(a as Record<string, unknown>, b as Record<string, unknown>, path, out)
      continue
    }

    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const show = (value: unknown): string => {
        if (value === undefined) return '（无）'
        const text = JSON.stringify(value)
        if (text === undefined) return String(value)
        return text.length > 60 ? `${text.slice(0, 57)}…` : text
      }
      out.push(`${path}: ${show(a)} → ${show(b)}`)
    }
  }
  return out
}

/**
 * 配置的迁移表。
 *
 * **现在是空的** —— v1 就是当前版本。留这个常量是为了以后改字段时有明确落点：
 * 加一条 `{ from: 1, describe, apply }`、把 `CONFIG_VERSION` 提到 2，就够了。
 */
export const CONFIG_MIGRATIONS: readonly Migration[] = []
export function normalizeConfig(rawInput: unknown): NormalizeResult {
  const warnings: string[] = []
  const config: AppConfig = { version: CONFIG_VERSION }

  if (!isRecord(rawInput)) {
    warnings.push('配置根节点不是对象，已忽略全部内容')
    return { config, warnings }
  }

  /*
   * 版本：**旧 → 迁移，新 → 抛错**。
   *
   * 原来的写法是"版本不等于当前就记一条 warning，然后照常解析" —— 那对
   * "更新版本写的配置"是**确定性的数据丢失**：旧代码不认识新字段，解析出来
   * 的对象再被保存一次，那些字段就永久没了。所以更新版本必须抛 `DataTooNewError`，
   * 由 `ConfigStore.load` 决定拒绝启动。
   */
  const migrated = migrate({
    kind: 'config',
    current: CONFIG_VERSION,
    raw: rawInput,
    migrations: CONFIG_MIGRATIONS,
  })

  if (migrated.applied.length > 0) {
    warnings.push(
      `配置从 v${migrated.from} 迁移到 v${CONFIG_VERSION}（${migrated.applied.join('；')}）`,
    )
  }

  /*
   * 下面全部读**迁移后**的对象（`input`）。
   *
   * ⚠️ 这一点很容易漏：如果还去读 `rawInput`，一条"把字段改名"的迁移就只改了
   * 版本号，字段值仍然是迁移前的样子 —— 而那正是迁移最容易出错的地方。
   */
  const input = isRecord(migrated.data) ? migrated.data : rawInput

  if (typeof input.profile === 'string' && input.profile !== '') config.profile = input.profile

  /*
   * 一份模型配置的逐字段校验。
   *
   * 抽成函数是因为 `model` 段和 `providers.<route>` 里那些**形状完全一样** ——
   * 抄两份的话，加一个字段时必然漏掉一边，而现象是"供应商里的那个设置
   * 保存不了，model 段里的可以"，很难查到。
   */
  const readModelConfig = (source: Record<string, unknown>, where: string): ModelConfig => {
    const out: ModelConfig = {}
    if (typeof source.baseUrl === 'string') out.baseUrl = source.baseUrl
    /* `baseURL` 是 DSH 的拼法（大写 URL）—— 两边都认，免得手写配置的人踩这个 */
    if (typeof source.baseURL === 'string') out.baseUrl = source.baseURL
    if (typeof source.model === 'string') out.model = source.model
    if (typeof source.apiKey === 'string') out.apiKey = source.apiKey
    if (typeof source.apiKeyEnv === 'string') out.apiKeyEnv = source.apiKeyEnv
    if (typeof source.api === 'string' && source.api !== '') out.api = source.api
    if (typeof source.includeUsage === 'boolean') out.includeUsage = source.includeUsage
    /*
     * 单价：**只认非负有限数**，写错了就说清是哪一项、值是多少。
     *
     * 这里故意不做"写错就当没填"的静默处理：用户填单价就是为了看成本，
     * 而一个被悄悄忽略的单价会让他以为成本算的是那个价。
     */
    if (isRecord(source.pricing)) {
      const pricing: NonNullable<ModelConfig['pricing']> = {}
      const fields = ['inputPerMTok', 'outputPerMTok', 'cachedInputPerMTok'] as const
      for (const field of fields) {
        const value = source.pricing[field]
        if (value === undefined) continue
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          pricing[field] = value
        } else {
          warnings.push(
            `${where}.pricing.${field} 必须是非负数（每百万 token 的价格），` +
              `实际是 ${JSON.stringify(value)}，已忽略`,
          )
        }
      }
      const currency = source.pricing.currency
      if (typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency)) {
        pricing.currency = currency.toUpperCase()
      } else if (currency !== undefined) {
        warnings.push(
          `${where}.pricing.currency 必须是三字母货币代码（如 USD），` +
            `实际是 ${JSON.stringify(currency)}，已忽略（按 USD 算）`,
        )
      }
      if (
        pricing.inputPerMTok !== undefined ||
        pricing.outputPerMTok !== undefined ||
        pricing.cachedInputPerMTok !== undefined
      ) {
        out.pricing = pricing
      }
    } else if (source.pricing !== undefined) {
      warnings.push(`${where}.pricing 必须是对象，实际是 ${JSON.stringify(source.pricing)}，已忽略`)
    }
    /*
     * 生成参数：**范围要在这里校验，不能原样透传**。
     *
     * 温度写成 -1、上限写成 0，服务端会拒绝这次请求 —— 而错误会出现在"某一轮对话
     * 失败"这种离病因很远的地方（用户会以为是模型或网络的问题）。所以宁可在读配置
     * 时就拦住，并说清是哪一项、值是多少。
     */
    if (source.temperature !== undefined) {
      const value = source.temperature
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2) {
        out.temperature = value
      } else {
        warnings.push(
          `${where}.temperature 必须是 0~2 之间的数，实际是 ${JSON.stringify(value)}，已忽略`,
        )
      }
    }
    if (source.maxTokens !== undefined) {
      const value = source.maxTokens
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        out.maxTokens = value
      } else {
        warnings.push(`${where}.maxTokens 必须是正整数，实际是 ${JSON.stringify(value)}，已忽略`)
      }
    }
    /* `label` 是旧拼法，`displayName` 是 DSH 的。两个都收，存成 DSH 那个 */
    if (typeof source.displayName === 'string' && source.displayName !== '') {
      out.displayName = source.displayName
    } else if (typeof source.label === 'string' && source.label !== '') {
      out.displayName = source.label
    }

    if (source.contextWindow !== undefined) {
      const value = source.contextWindow
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
        out.contextWindow = value
      } else {
        warnings.push(`${where}.contextWindow 必须是正整数，实际是 ${JSON.stringify(value)}，已忽略`)
      }
    }

    /*
     * `models`：**接受两种形状**。
     *
     *   · `{ id, name?, contextWindow? }[]`  —— DSH 界面发的，也是我们存回去的
     *   · `'id'[]`                            —— 手写配置的人自然会这么写
     *
     * 只认一种的话另一种会被静默丢掉 —— 而"静默丢掉"正是这一轮所有难查的
     * bug 的共同形状。两种都认，统一存成规范的那一种。
     */
    if (source.models !== undefined) {
      if (Array.isArray(source.models)) {
        const seen = new Set<string>()
        const list: ModelDefinition[] = []
        for (const entry of source.models) {
          let id: string | undefined
          let name: string | undefined
          let contextWindow: number | undefined
          if (typeof entry === 'string') {
            id = entry
          } else if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
            const item = entry as Record<string, unknown>
            if (typeof item.id === 'string') id = item.id
            if (typeof item.name === 'string' && item.name !== '') name = item.name
            if (
              typeof item.contextWindow === 'number' &&
              Number.isInteger(item.contextWindow) &&
              item.contextWindow > 0
            ) {
              contextWindow = item.contextWindow
            }
          }
          if (id === undefined) continue
          const trimmed = id.trim()
          /* 去重：重复的模型名在界面上会渲染成两行一样的 */
          if (trimmed === '' || seen.has(trimmed)) continue
          seen.add(trimmed)
          list.push({
            id: trimmed,
            ...(name === undefined ? {} : { name }),
            ...(contextWindow === undefined ? {} : { contextWindow }),
          })
        }
        out.models = list
      } else {
        warnings.push(`${where}.models 必须是数组，实际是 ${JSON.stringify(source.models)}，已忽略`)
      }
    }

    return out
  }

  const model: AppConfig['model'] = isRecord(input.model) ? readModelConfig(input.model, 'model') : {}
  if (Object.keys(model).length > 0) config.model = model

  /*
   * 供应商库。
   *
   * route 的合法性**在这里就挡住**：它以小写字母开头，而它同时被用来派生
   * 凭据名（`credentials/set`）。放进一个带斜杠或大写的 route 会让后面
   * 每一步都要重新校验一次，不如在入口拒掉。
   */
  if (isRecord(input.providers)) {
    const providers: Record<string, ModelConfig> = {}
    for (const [route, value] of Object.entries(input.providers)) {
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(route)) {
        warnings.push(`providers 里的「${route}」不是合法的 route（小写字母开头，只含小写字母/数字/连字符），已忽略`)
        continue
      }
      if (!isRecord(value)) {
        warnings.push(`providers.${route} 必须是一个对象，已忽略`)
        continue
      }
      providers[route] = readModelConfig(value, `providers.${route}`)
    }
    if (Object.keys(providers).length > 0) config.providers = providers
  }

  /*
   * ★ **把 `mvs` 落成一个真正的供应商条目。**
   *
   * ## 它以前是什么，为什么不对
   *
   * `mvs` 原来只是垫片**合成**的一条（背后就是这份配置的 `model` 段）。
   * 后果有两条，都是这条迁移要消掉的：
   *
   *   1. 设置页里那张「MVS Agent」卡片，改的其实是**进程级默认模型** ——
   *      用户以为在改"一个供应商"，实际改的是**所有会话的兜底**。
   *      他看到的"改一个、别的都跟着变"就是这么来的。
   *   2. `activeProvider: 'mvs'` 因为"`providers` 里没有它"被下面的守卫丢掉
   *      —— 内存说 mvs、磁盘没这个键。
   *
   * ## 现在
   *
   * 从 `model` 段复制一份（**值完全一样，行为等价**），它就和别的供应商
   * 一视同仁了：选它是会话级选择，改它只改它自己。
   *
   * `model` 段**继续保留** —— 它是"没有任何会话级选择时"的进程级兜底。
   */
  if (config.providers === undefined) config.providers = {}
  if (
    config.providers.mvs === undefined &&
    config.model !== undefined &&
    Object.keys(config.model).length > 0
  ) {
    config.providers.mvs = { ...config.model, displayName: 'MVS Agent' }
  }
  /* `activeProvider` 缺省就等于"用 mvs"（`resolveConfig` 就是这么报的）—— 那就如实写上 */
  if (config.activeProvider === undefined && config.providers.mvs !== undefined) {
    config.activeProvider = 'mvs'
  }

  /*
   * `activeProvider` 只在**它确实指向一个存在的 route** 时才留下。
   *
   * 留下一个悬空的引用会让每次启动都警告一次，而那个警告永远修不掉 ——
   * 因为用户根本不知道要去哪改。悬空时直接当没设（等价于用 `model` 段）。
   */
  if (typeof input.activeProvider === 'string' && input.activeProvider !== '') {
    if (config.providers?.[input.activeProvider] !== undefined) {
      config.activeProvider = input.activeProvider
    } else {
      warnings.push(
        `activeProvider 指的是「${input.activeProvider}」，但 providers 里没有它 —— 已忽略（仍用 model 段）`,
      )
    }
  }

  if (isRecord(input.server)) {
    const port = input.server.port
    const token = input.server.requireToken
    const server: { port?: number; requireToken?: boolean } = {}

    if (typeof port === 'number' && Number.isInteger(port) && port >= 0 && port <= 65535) {
      server.port = port
    } else if (port !== undefined) {
      warnings.push(`server.port 必须是 0–65535 的整数，实际是 ${JSON.stringify(port)}，已忽略`)
    }

    /*
     * `server.requireToken` 只认布尔值。
     *
     * 类型写错时**不静默退回默认** —— 默认现在是"要求令牌"，而用户写这个键
     * 通常是想关掉它。写错一个单词就从"关"变成"开"，还会让人以为配置生效了。
     */
    if (typeof token === 'boolean') {
      server.requireToken = token
    } else if (token !== undefined) {
      warnings.push(
        `server.requireToken 必须是 true 或 false，实际是 ${JSON.stringify(token)}，` +
          '已忽略（仍按默认：要求令牌）',
      )
    }

    if (server.port !== undefined || server.requireToken !== undefined) config.server = server
  }

  if (isRecord(input.permissions)) {
    const mode = input.permissions.defaultMode
    if (mode === 'read-only' || mode === 'workspace-write' || mode === 'full-access') {
      config.permissions = { defaultMode: mode }
    } else if (mode !== undefined) {
      warnings.push(`permissions.defaultMode 不是已知模式（${JSON.stringify(mode)}），已忽略`)
    }
  }

  /*
   * localModel —— 本地模型服务的启动配置。
   *
   * 逐字段校验，**坏的那个字段单独丢、其余照收**。整块丢掉的话，用户改错一个
   * 数字会把模型路径也一起弄没，而那时界面上显示的是「没配」—— 和真实原因
   * （某一行写错了）隔得很远。
   */
  if (isRecord(input.localModel)) {
    const source = input.localModel
    const localModel: NonNullable<AppConfig['localModel']> = {}
    const texts: Array<
      'serverPath' | 'modelPath' | 'alias' | 'cacheTypeK' | 'cacheTypeV' | 'reasoning' | 'reasoningFormat'
    > = [
      'serverPath',
      'modelPath',
      'alias',
      'cacheTypeK',
      'cacheTypeV',
      'reasoning',
      'reasoningFormat',
    ]
    for (const key of texts) {
      const value = source[key]
      if (typeof value === 'string' && value !== '') localModel[key] = value
      else if (value !== undefined && value !== '') {
        warnings.push(`localModel.${key} 必须是非空字符串，实际是 ${JSON.stringify(value)}，已忽略`)
      }
    }

    if (typeof source.autoStart === 'boolean') localModel.autoStart = source.autoStart
    if (typeof source.flashAttention === 'boolean') localModel.flashAttention = source.flashAttention

    /*
     * ⚠️ `gpuLayers` / `cpuMoeLayers` / `cacheRam` 都**允许 0**，而且 0 是有意义的：
     *   gpuLayers 0    = 全在 CPU（慢，但显存全空出来）
     *   cpuMoeLayers 0 = 专家全上 GPU（只有显存装得下才可行）
     *   cacheRam 0     = KV 不进 RAM
     * 用「非零才算填了」那种写法会把 0 当成没填，于是服务端用自己的默认值 ——
     * 一次静默的改配置。
     */
    for (const key of ['port', 'ctxSize', 'gpuLayers', 'cpuMoeLayers', 'cacheRam', 'parallel'] as const) {
      const value = source[key]
      if (value === undefined) continue
      const min = key === 'port' || key === 'ctxSize' || key === 'parallel' ? 1 : 0
      if (typeof value === 'number' && Number.isInteger(value) && value >= min) {
        localModel[key] = value
      } else {
        warnings.push(
          `localModel.${key} 必须是不小于 ${min} 的整数，实际是 ${JSON.stringify(value)}，已忽略`,
        )
      }
    }

    // reasoningBudget 允许负数（= 不限），所以单独校验
    if (source.reasoningBudget !== undefined) {
      const value = source.reasoningBudget
      if (typeof value === 'number' && Number.isInteger(value)) {
        localModel.reasoningBudget = value
      } else {
        warnings.push(
          `localModel.reasoningBudget 必须是整数（负数 = 不限），实际是 ${JSON.stringify(value)}，已忽略`,
        )
      }
    }

    if (Array.isArray(source.extraArgs)) {
      const args = source.extraArgs.filter((a): a is string => typeof a === 'string' && a !== '')
      if (args.length > 0) localModel.extraArgs = args
      else if (source.extraArgs.length > 0) {
        warnings.push('localModel.extraArgs 全是非字符串项，已忽略')
      }
    }

    if (Object.keys(localModel).length > 0) config.localModel = localModel
  }

  /*
   * webSearch —— 网络搜索后端。
   *
   * ## 逐字段校验，不认的整个丢掉
   *
   * `provider` 是**这一段的开关**：没有它的话整个 `webSearch` 不生效。
   * 那是有意的 —— 半配好的搜索后端（有 provider 没密钥、有密钥没 provider）
   * 只会让 `web_search` 在**运行时**神秘失败，不如当成没配。
   *
   * ⚠️ 千万别忘了把 `webSearch` 加进下面的 `known` 集合。
   *   `localModel` 当初就是这么漏的：解析写好了但没进 `known`，
   *   于是每次启动都报「不认识的字段」并被**整个忽略** ——
   *   而现象是"配了没用"，看不出是这一行的问题。
   */
  if (isRecord(input.webSearch)) {
    const source = input.webSearch
    const provider = source.provider
    const KNOWN_PROVIDERS = ['tavily', 'brave', 'searxng']
    if (typeof provider !== 'string' || !KNOWN_PROVIDERS.includes(provider)) {
      warnings.push(
        `webSearch.provider 必须是 ${KNOWN_PROVIDERS.join(' / ')} 之一，` +
          `实际是 ${JSON.stringify(provider)}，这一段已忽略`,
      )
    } else {
      const webSearch: NonNullable<AppConfig['webSearch']> = {
        provider: provider as NonNullable<AppConfig['webSearch']>['provider'],
      }
      for (const key of ['apiKey', 'apiKeyEnv', 'baseUrl'] as const) {
        const value = source[key]
        if (typeof value === 'string' && value !== '') webSearch[key] = value
        else if (value !== undefined) {
          warnings.push(`webSearch.${key} 必须是非空字符串，实际是 ${JSON.stringify(value)}，已忽略`)
        }
      }
      const maxResults = source.maxResults
      if (typeof maxResults === 'number' && Number.isInteger(maxResults) && maxResults > 0) {
        /* 上限 20 和工具里的 clamp 对齐 —— 两处不一致的话用户会以为设了 100 就是 100 */
        webSearch.maxResults = Math.min(20, maxResults)
      } else if (maxResults !== undefined) {
        warnings.push(`webSearch.maxResults 必须是正整数，实际是 ${JSON.stringify(maxResults)}，已忽略`)
      }
      config.webSearch = webSearch
    }
  }

  if (isRecord(input.context)) {
    const context: AppConfig['context'] = {}
    const ratio = input.context.triggerRatio
    if (typeof ratio === 'number' && ratio > 0 && ratio <= 1) {
      context.triggerRatio = ratio
    } else if (ratio !== undefined) {
      warnings.push(`context.triggerRatio 必须在 (0, 1] 内，实际是 ${JSON.stringify(ratio)}，已忽略`)
    }

    for (const key of [
      'outputReserveTokens',
      'keepRecentTurns',
      'toolResultThresholdChars',
      'toolResultHeadChars',
      'toolResultTailChars',
    ] as const) {
      const value = input.context[key]
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        context[key] = value
      } else if (value !== undefined) {
        warnings.push(`context.${key} 必须是非负整数，实际是 ${JSON.stringify(value)}，已忽略`)
      }
    }
    if (Object.keys(context).length > 0) config.context = context
  }

  /*
   * 不认识的顶层字段：只提示，不当错误。
   *
   * ⚠️ **加了新字段一定要来这里加上。** 忘了的后果是：配置照常生效
   * （上面各段各自读各自的），但每次启动都多一句「不认识的字段」——
   * 于是真出问题时那句警告已经没人看了，而且测试里那条
   * 「默认配置本身是合法且能通过的」会先挂，指着一个和真实原因无关的地方。
   */
  const known = new Set([
    'version',
    'profile',
    'model',
    'server',
    'permissions',
    'context',
    'localModel',
    /*
     * ⚠️ 加了新的配置段**必须**加到这里来。
     *
     * 漏了的话现象是：解析逻辑写得完全正确，但配置**被整个忽略**，
     * 而且每次启动多一句「不认识的字段」。`localModel` 就这么漏过一次。
     */
    'webSearch',
    /* 供应商库 + 当前生效的那个（见 `providers` 那段注释） */
    'providers',
    'activeProvider',
  ])
  for (const key of Object.keys(input)) {
    if (!known.has(key)) warnings.push(`配置里有不认识的字段「${key}」，已忽略`)
  }

  return { config, warnings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export { API_KEY_MASK }
