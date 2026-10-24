/**
 * 一个工作区的插件库：装了什么、启用了什么、以及把声明变成真工具。
 *
 * ## 为什么是「工作区一份」
 *
 * 安装是全局的（`<MVS_HOME>/plugins`），**启用**是工作区级的
 * （`<工作区>/.mvs/plugins.json`）。理由：在一个无关仓库里突然多出十个工具，
 * 模型的工具选择会明显变差，而且它会去试不该试的东西。
 *
 * ## 三个必须写清楚的诚实说明
 *
 *   1. **这里没有沙箱。** 命令型插件能做的事就是用户能做的事。
 *   2. **风险声明是声明，不是保证。** `read` 声明让它不问人、不做快照；
 *      所以对 `read` 我们做一次**轻量指纹核对**（见 `fingerprint.ts`），
 *      它是告警，不是防护。
 *   3. **密钥默认一个都不给。** 只有清单逐项声明 `env` 才注入，且不继承
 *      `process.env` 里的业务变量。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { defaultHomeDir } from '../config/store.ts'
import { failResult, okResult, type AnyTool, type ToolContext } from '../tools/types.ts'
import { resolveInsideRoot } from '../tools/paths.ts'
import { discoverPlugins } from './discover.ts'
import { diffFingerprints, fingerprintWorkspace } from './fingerprint.ts'
import { execCaptured } from './exec.ts'
import {
  PLUGIN_OUTPUT_MAX_CHARS,
  PLUGIN_TIMEOUT_DEFAULT_MS,
  PLUGIN_TOOLS_PER_WORKSPACE_MAX,
  pluginOfTool,
  type PluginNote,
  type PluginProblem,
  type PluginRecord,
  type PluginStatus,
  type PluginSummaryShape,
  type PluginToolSpec,
  type PluginEnvApi,
  type PluginView,
} from './types.ts'

interface PluginsFile {
  schema: 1
  approved: Record<string, string>
  enabled: string[]
  /** 违反自己声明的插件：名字 → 说明。停用它并要求重新确认 */
  suspect: Record<string, string>
}

const EMPTY: PluginsFile = { schema: 1, approved: {}, enabled: [], suspect: {} }

export interface PluginToolEnvironment {
  /** 按配置路径解析一个密钥（`webSearch.apiKey` 这类）。没有就返回 undefined */
  resolveSecret: (configPath: string) => string | undefined
}

export class PluginLibrary {
  #workspace: string
  #homeDir: string
  #stateFile: string
  #records: PluginRecord[] = []
  #problems: PluginProblem[] = []
  #notes: PluginNote[] = []
  #approved: Record<string, string> = {}
  #enabled: string[] = []
  #suspect: Record<string, string> = {}
  /** 因为数量上限没被加载的工具 → 说明 */
  #excluded: PluginNote[] = []

  #resolveSecret: (configPath: string) => string | undefined

  private constructor(
    workspace: string,
    homeDir: string,
    resolveSecret: (configPath: string) => string | undefined,
  ) {
    this.#workspace = workspace
    this.#homeDir = homeDir
    this.#resolveSecret = resolveSecret
    this.#stateFile = path.join(workspace, '.mvs', 'plugins.json')
  }

  static async open(
    workspace: string,
    homeDir: string = defaultHomeDir(),
    resolveSecret: (configPath: string) => string | undefined = () => undefined,
  ): Promise<PluginLibrary> {
    const library = new PluginLibrary(workspace, homeDir, resolveSecret)
    await library.reload()
    return library
  }

  get workspace(): string {
    return this.#workspace
  }

  get stateFile(): string {
    return this.#stateFile
  }

  async reload(): Promise<void> {
    const state = await this.#readState()
    this.#approved = state.approved
    this.#enabled = state.enabled
    this.#suspect = state.suspect

    const discovered = await discoverPlugins(this.#homeDir)

    this.#records = []
    this.#problems = []
    this.#notes = []

    for (const entry of discovered) {
      if (entry.problem !== null) this.#problems.push(entry.problem)
      if (entry.record === null) continue

      const record = entry.record
      const recorded = this.#approved[record.manifest.name]
      record.approved = recorded === record.hash
      record.enabled = record.approved && this.#enabled.includes(record.manifest.name)

      if (recorded !== undefined && recorded !== record.hash) {
        this.#problems.push({
          path: path.join(record.dir, 'plugin.json'),
          name: record.manifest.name,
          message: '清单已变更，需重新确认（哈希与上次确认时不一致）',
        })
      }

      const suspect = this.#suspect[record.manifest.name]
      if (suspect !== undefined) {
        record.suspect = suspect
        record.enabled = false
      }

      this.#records.push(record)
    }

    this.#records.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name))
  }

  view(): PluginView {
    return {
      plugins: [...this.#records],
      problems: [...this.#problems],
      notes: [...this.#notes, ...this.#excluded],
    }
  }

  /** 给 `/state` 的形状 */
  summaries(): PluginSummaryShape[] {
    const out: PluginSummaryShape[] = []

    for (const record of this.#records) {
      let status: PluginStatus = 'disabled'
      let message: string | undefined
      if (record.suspect !== undefined) {
        status = 'disabled'
        message = record.suspect
      } else if (!record.approved) {
        status = 'pending'
        message =
          this.#problems.find((problem) => problem.name === record.manifest.name)?.message ??
          '尚未确认（第一次发现）'
      } else if (record.enabled) {
        status = 'enabled'
      }

      out.push({
        name: record.manifest.name,
        version: record.manifest.version ?? '',
        description: record.manifest.description ?? '',
        status,
        toolNames: record.toolNames,
        ...(message === undefined ? {} : { message }),
        path: record.dir,
      })
    }

    for (const problem of this.#problems) {
      if (problem.name !== null && this.#records.some((r) => r.manifest.name === problem.name)) {
        continue
      }
      out.push({
        name: problem.name ?? path.basename(path.dirname(problem.path)),
        version: '',
        description: '',
        status: 'broken',
        toolNames: [],
        message: problem.message,
        path: problem.path,
      })
    }

    return out
  }

  /** 确认一份插件：记下当前清单哈希，并启用在当前工作区 */
  async approve(name: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const record = this.#record(name)
    if (record === undefined) return { ok: false, message: `没有名为「${name}」的插件` }

    const suspect = { ...this.#suspect }
    delete suspect[name]

    await this.#writeState({
      schema: 1,
      approved: { ...this.#approved, [name]: record.hash },
      enabled: [...new Set([...this.#enabled, name])],
      suspect,
    })
    await this.reload()
    return { ok: true }
  }

  async setEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const record = this.#record(name)
    if (record === undefined) return { ok: false, message: `没有名为「${name}」的插件` }
    if (enabled && !record.approved) {
      return { ok: false, message: `插件「${name}」还没确认，先确认再启用` }
    }

    const suspect = { ...this.#suspect }
    if (enabled) delete suspect[name]

    await this.#writeState({
      schema: 1,
      approved: this.#approved,
      enabled: enabled
        ? [...new Set([...this.#enabled, name])]
        : this.#enabled.filter((entry) => entry !== name),
      suspect,
    })
    await this.reload()
    return { ok: true }
  }

  /**
   * 报告"声明与实际不符"，并**停用**这个插件。
   *
   * 停用而不是只报警：一次谎报之后，我们不再有理由相信它的其他声明，
   * 而"继续跑但记一笔"等于让用户在不知情的情况下承担风险。
   */
  async markSuspect(name: string, message: string): Promise<void> {
    await this.#writeState({
      schema: 1,
      approved: this.#approved,
      enabled: this.#enabled.filter((entry) => entry !== name),
      suspect: { ...this.#suspect, [name]: message },
    })
    await this.reload()
  }

  /* ── 工具 ────────────────────────────────────────────────────────── */

  /**
   * 这个名字是不是「当前工作区可用」。
   *
   * 非插件工具一律放行；插件工具要求：插件已确认 + 已启用 + 没被标记为可疑。
   */
  allowsTool(name: string): boolean {
    const plugin = pluginOfTool(name)
    if (plugin === null) return true
    const record = this.#record(plugin)
    return record !== undefined && record.approved && record.enabled
  }

  /**
   * 把启用的插件声明变成真正的工具。
   *
   * 数量上限在这里生效：按插件名排序后依次纳入，超过
   * `PLUGIN_TOOLS_PER_WORKSPACE_MAX` 的**不加载**，并记一条说明 ——
   * 静默截断会让用户以为工具都装上了。
   */
  tools(): AnyTool[] {
    const out: AnyTool[] = []
    let budget = PLUGIN_TOOLS_PER_WORKSPACE_MAX
    const skipped: PluginNote[] = []

    for (const record of this.#records) {
      if (!record.enabled) continue

      for (const spec of record.manifest.tools) {
        if (budget <= 0) {
          skipped.push({
            path: path.join(record.dir, 'plugin.json'),
            message: `工作区工具数已达上限 ${PLUGIN_TOOLS_PER_WORKSPACE_MAX}，插件「${record.manifest.name}」的「${spec.name}」没有加载`,
          })
          continue
        }
        out.push(makePluginTool({ record, spec }))
        budget--
      }
    }

    this.#excluded = skipped
    return out
  }

  /**
   * 插件工具在执行期需要的能力。
   *
   * `onSuspect` 不 await：它是在**返回工具结果的同时**做停用，属于副作用，
   * 不该拖住一次调用。停用会写盘，但失败了也不影响这次结果 —— 下次 reload
   * 会再判一次。
   */
  pluginEnv(): PluginEnvApi {
    return {
      resolveSecret: (configPath) => this.#resolveSecret(configPath),
      onSuspect: (plugin, message) => {
        void this.markSuspect(plugin, message)
      },
    }
  }

  #record(name: string): PluginRecord | undefined {
    return this.#records.find((record) => record.manifest.name === name)
  }

  async #readState(): Promise<PluginsFile> {
    let raw: string
    try {
      raw = await readFile(this.#stateFile, 'utf8')
    } catch {
      return { schema: 1, approved: {}, enabled: [], suspect: {} }
    }

    try {
      const parsed = JSON.parse(raw) as Partial<PluginsFile>
      const approved: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed.approved ?? {})) {
        if (typeof value === 'string') approved[key] = value
      }
      const suspect: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed.suspect ?? {})) {
        if (typeof value === 'string') suspect[key] = value
      }
      return {
        schema: 1,
        approved,
        enabled: Array.isArray(parsed.enabled)
          ? parsed.enabled.filter((entry): entry is string => typeof entry === 'string')
          : [],
        suspect,
      }
    } catch {
      /* 状态文件坏了就当作没确认过：宁可全部退回待确认，也不要崩溃或默认放行 */
      return { schema: 1, approved: {}, enabled: [], suspect: {} }
    }
  }

  async #writeState(state: PluginsFile): Promise<void> {
    await mkdir(path.dirname(this.#stateFile), { recursive: true })
    await writeFile(this.#stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }
}

/* ── 声明 → 工具 ─────────────────────────────────────────────────────── */

interface MakeToolOptions {
  record: PluginRecord
  spec: PluginToolSpec
}

/** 插件进程能看到的系统变量白名单。业务变量一个都不给 */
const ENV_WHITELIST = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'LANG',
  'LC_ALL',
]

function baseEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of ENV_WHITELIST) {
    const value = process.env[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

function makePluginTool(options: MakeToolOptions): AnyTool {
  const { record, spec } = options
  const plugin = record.manifest.name

  return {
    name: `plugin__${plugin}__${spec.name}`,
    description: spec.description,
    risk: spec.risk,
    parameters: spec.parameters as never,

    async run(rawArgs, ctx: ToolContext) {
      /*
       * 工作区根目录来自 `ctx.root`，**不来自闭包**。
       *
       * 工具对象是所有工作区共用的（安装是全局的，工作区只决定启用与否）。
       * 闭包捕获工作区会让同一个工具在别的工作区里用错根目录 —— 那种错的
       * 表现是「在 A 仓库里跑了 B 仓库的命令」，极难查。
       */
      const workspace = ctx.root
      const pluginEnv = ctx.pluginEnv
      if (pluginEnv === undefined) {
        return failResult(
          'failed',
          `插件「${plugin}」需要宿主提供插件环境（密钥解析与违规上报），这个环境没有。`,
        )
      }

      const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Record<
        string,
        unknown
      >

      /*
       * ★ **先把路径参数解析成规范化绝对路径，再做模板替换。**
       *
       * 顺序反了就是 TOCTOU：argv 里放的是模型给的原始字符串（可能是
       * `../../x`），校验只能对着字符串猜；而且校验通过后放进去的仍然是
       * 那个原始串 —— 校验的对象和实际执行的不是同一个值。
       *
       * 越界时**进程根本不启动**：这一条有测试盯着（断言 spawn 没发生）。
       */
      const effective: Record<string, string> = {}
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string') effective[key] = value
        else if (typeof value === 'number' || typeof value === 'boolean') {
          effective[key] = String(value)
        } else if (value !== undefined && value !== null) {
          effective[key] = JSON.stringify(value)
        }
      }

      for (const key of spec.pathArgs ?? []) {
        const given = effective[key]
        if (given === undefined) {
          return failResult('invalid_args', `缺少路径参数「${key}」（清单里声明它必须过路径围栏）`)
        }
        const checked = resolveInsideRoot(workspace, given)
        if (!checked.ok) return failResult('outside_root', checked.message)
        /* 换成真实绝对路径 —— 插件拿到的就是它，不用自己再拼 */
        effective[key] = checked.absolute
      }

      const argv: string[] = []
      for (const token of spec.run.argv) {
        const missing: string[] = []
        const replaced = token.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, key: string) => {
          const value = effective[key]
          if (value === undefined) {
            missing.push(key)
            return ''
          }
          return value
        })
        if (missing.length > 0) {
          return failResult(
            'invalid_args',
            `argv 引用了没有提供的参数：${missing.join('、')}。` +
              '（绝不把字面 {{…}} 交给插件 —— 那会让它收到垃圾还照跑）',
          )
        }
        argv.push(replaced)
      }

      if (argv.length === 0) {
        return failResult('invalid_args', 'argv 为空')
      }

      const env = baseEnv()
      for (const [variable, configPath] of Object.entries(spec.env ?? {})) {
        const secret = pluginEnv.resolveSecret(configPath)
        if (secret === undefined || secret === '') {
          return failResult(
            'failed',
            `插件「${plugin}」声明需要配置里的「${configPath}」（注入为 ${variable}），但配置里没有它。` +
              '请先在设置页填好，或者让作者去掉这个声明。',
          )
        }
        env[variable] = secret
      }

      const timeoutMs = spec.run.timeoutMs ?? ctx.timeoutMs ?? PLUGIN_TIMEOUT_DEFAULT_MS
      const maxOutput = ctx.maxOutputChars ?? PLUGIN_OUTPUT_MAX_CHARS

      /*
       * 声明为 read 的工具：调用前后各取一次轻量指纹。
       * 这是**告警**，不是防护 —— 盲区写在 `fingerprint.ts` 顶部。
       */
      const watched = spec.risk === 'read'
      const before = watched ? await fingerprintWorkspace(workspace) : null

      const result = await execCaptured({
        file: argv[0] as string,
        argv: argv.slice(1),
        cwd: workspace,
        env,
        timeoutMs,
        maxOutputChars: maxOutput,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(spec.run.stdin === 'json'
          ? { stdinText: JSON.stringify({ args, resolved: effective }) }
          : {}),
      })

      if (result.spawnError !== undefined) {
        return failResult(
          'failed',
          `插件「${plugin}」的命令启动失败：${argv[0]}（${result.spawnError}）。` +
            '很可能是它依赖的命令行工具没装，或者不在 PATH 里。',
        )
      }

      let body = result.stdout
      if (spec.run.output === 'json') {
        const parsed = tryParseJson(body)
        if (parsed === null) {
          return failResult(
            'failed',
            `插件「${plugin}」的「${spec.name}」声明了 output: json，但输出不是合法 JSON。` +
              `原始输出前 200 字符：${body.slice(0, 200)}`,
          )
        }
        const envelope = parsed as { ok?: unknown; content?: unknown; data?: unknown }
        if (envelope.ok === false) {
          return failResult(
            'failed',
            typeof envelope.content === 'string' ? envelope.content : '插件报告失败',
            { data: (envelope.data ?? null) as never },
          )
        }
        body = typeof envelope.content === 'string' ? envelope.content : JSON.stringify(envelope)
      }

      if (result.timedOut) {
        return failResult(
          'timeout',
          `插件「${plugin}」的「${spec.name}」超过 ${timeoutMs}ms 未结束，已结束整个进程树。`,
          { content: compose(body, result.stderr) },
        )
      }
      if (result.aborted) {
        return failResult('aborted', '调用已被取消', { content: compose(body, result.stderr) })
      }

      /* 声明 read 却改了工作区：报警 + 停用（见 `markSuspect` 的注释） */
      let warning = ''
      if (before !== null) {
        const after = await fingerprintWorkspace(workspace)
        const diff = diffFingerprints(before, after)
        if (diff.total > 0) {
          warning =
            `\n\n⚠️ 这个插件把工具声明成 read（不写文件、不问人、不做快照），` +
            `但调用后工作区有 ${diff.total} 处变化：${diff.changed.join('、')}。` +
            '它已被停用，请在设置页重新确认。指纹只覆盖工作区，且能被刻意规避（见文档）。'
          pluginEnv.onSuspect(
            plugin,
            `声明为 read，但调用后工作区有 ${diff.total} 处变化（${diff.changed
              .slice(0, 5)
              .join('、')}）`,
          )
        }
      }

      const content = `${compose(body, result.stderr)}${warning}`
      if (result.code === 0) {
        return okResult(content, {
          plugin,
          tool: spec.name,
          exitCode: 0,
          truncated: result.truncated,
        })
      }

      return failResult(
        'failed',
        `插件「${plugin}」的「${spec.name}」退出码 ${result.code ?? `(信号 ${result.signal})`}`,
        { content },
      )
    },
  } as AnyTool
}

function compose(stdout: string, stderr: string): string {
  const parts: string[] = []
  if (stdout.trim() !== '') parts.push(stdout.trimEnd())
  if (stderr.trim() !== '') parts.push(`[stderr]\n${stderr.trimEnd()}`)
  return parts.length === 0 ? '（插件没有输出）' : parts.join('\n\n')
}

function tryParseJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
