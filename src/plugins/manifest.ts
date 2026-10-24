/**
 * 清单解析与校验。
 *
 * 原则和技能的 frontmatter 一致：**不合规就整份拒绝**，不半懂不懂地放行。
 * 一个"看起来能用、其实是空壳"的插件最坏 —— 它的工具出现在模型手里，
 * 调起来失败，而用户以为自己装好了。
 *
 * 校验分四类，每一类都必须给出**具体的**消息（哪个字段、实际值、上限）：
 *   1. 结构：schema / 字段类型
 *   2. 命名：插件名、工具名、拼出来的对外名
 *   3. 体积：描述长度、参数属性数、参数序列化长度、工具数
 *   4. 执行：argv 形态、禁止 shell、pathArgs 必须指向已声明的参数
 */

import {
  isPluginRisk,
  PLUGIN_DESCRIPTION_MAX,
  PLUGIN_NAME_MAX,
  PLUGIN_PARAMS_MAX_CHARS,
  PLUGIN_PARAMS_MAX_PROPS,
  PLUGIN_TIMEOUT_MAX_MS,
  PLUGIN_TOOL_FULL_NAME_MAX,
  PLUGIN_TOOL_NAME_MAX,
  PLUGIN_TOOLS_MAX,
  pluginToolName,
  type PluginManifest,
  type PluginToolSpec,
} from './types.ts'

const NAME_RE = /^[a-z0-9-]+$/

export type ManifestResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; message: string }

/**
 * 解析一份清单。
 *
 * `dirName` 是插件目录名：**插件名必须等于目录名**，不猜也不纠正。
 * 两者不一致时，用户在设置页看到的名字和磁盘上的位置对不上，
 * 而这种错只能靠人肉翻目录才发现。
 */
export function parseManifest(raw: string, dirName: string): ManifestResult {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (err) {
    return { ok: false, message: `plugin.json 不是合法 JSON：${messageOf(err)}` }
  }

  if (!isObject(value)) return { ok: false, message: 'plugin.json 的根节点必须是对象' }

  /* 禁止 shell：出现在任何位置都直接拒绝，而不是忽略 */
  const shellHit = findKey(value, 'shell')
  if (shellHit !== null) {
    return {
      ok: false,
      message:
        `清单里出现了 shell 字段（${shellHit}）。插件**不允许**用 shell：` +
        '一旦有 shell，argv 里的 {{参数}} 就从"一个字符串参数"变成"一段可以被注入的脚本"。',
    }
  }

  if (value['schema'] !== 1) {
    return { ok: false, message: `schema 必须是 1，实际是 ${JSON.stringify(value['schema'])}` }
  }

  const name = typeof value['name'] === 'string' ? value['name'] : ''
  if (name === '') return { ok: false, message: '缺少 name' }
  if (!NAME_RE.test(name)) {
    return { ok: false, message: `name 只能用小写字母、数字、连字符，实际是「${name}」` }
  }
  if (name.length > PLUGIN_NAME_MAX) {
    return { ok: false, message: `name 是 ${name.length} 字符，上限 ${PLUGIN_NAME_MAX}` }
  }
  if (name !== dirName) {
    return {
      ok: false,
      message: `name 必须等于目录名：目录是「${dirName}」，清单里写的是「${name}」`,
    }
  }

  const version = value['version']
  if (version !== undefined && typeof version !== 'string') {
    return { ok: false, message: 'version 必须是字符串' }
  }

  const description = value['description']
  if (description !== undefined && typeof description !== 'string') {
    return { ok: false, message: 'description 必须是字符串' }
  }
  if (typeof description === 'string' && description.length > PLUGIN_DESCRIPTION_MAX) {
    return {
      ok: false,
      message: `description 是 ${description.length} 字符，上限 ${PLUGIN_DESCRIPTION_MAX}`,
    }
  }

  const toolsRaw = value['tools']
  if (!Array.isArray(toolsRaw)) return { ok: false, message: 'tools 必须是数组' }
  if (toolsRaw.length === 0) return { ok: false, message: 'tools 不能为空（至少一个工具）' }
  if (toolsRaw.length > PLUGIN_TOOLS_MAX) {
    return { ok: false, message: `tools 有 ${toolsRaw.length} 个，上限 ${PLUGIN_TOOLS_MAX}` }
  }

  const tools: PluginToolSpec[] = []
  const seen = new Set<string>()

  for (let index = 0; index < toolsRaw.length; index++) {
    const parsed = parseTool(toolsRaw[index], name, index)
    if (!parsed.ok) return { ok: false, message: parsed.message }
    if (seen.has(parsed.tool.name)) {
      return { ok: false, message: `工具名重复：「${parsed.tool.name}」` }
    }
    seen.add(parsed.tool.name)
    tools.push(parsed.tool)
  }

  return {
    ok: true,
    manifest: {
      schema: 1,
      name,
      ...(typeof version === 'string' ? { version } : {}),
      ...(typeof description === 'string' ? { description } : {}),
      tools,
    },
  }
}

type ToolResult = { ok: true; tool: PluginToolSpec } | { ok: false; message: string }

function parseTool(raw: unknown, plugin: string, index: number): ToolResult {
  const where = `tools[${index}]`
  if (!isObject(raw)) return { ok: false, message: `${where} 必须是对象` }

  const name = typeof raw['name'] === 'string' ? raw['name'] : ''
  if (name === '') return { ok: false, message: `${where} 缺少 name` }
  if (!NAME_RE.test(name)) {
    return { ok: false, message: `${where}.name 只能用小写字母、数字、连字符，实际是「${name}」` }
  }
  if (name.length > PLUGIN_TOOL_NAME_MAX) {
    return {
      ok: false,
      message: `${where}.name 是 ${name.length} 字符，上限 ${PLUGIN_TOOL_NAME_MAX}`,
    }
  }

  const full = pluginToolName(plugin, name)
  if (full.length > PLUGIN_TOOL_FULL_NAME_MAX) {
    return {
      ok: false,
      message: `对外工具名「${full}」是 ${full.length} 字符，上限 ${PLUGIN_TOOL_FULL_NAME_MAX}`,
    }
  }

  const description = typeof raw['description'] === 'string' ? raw['description'] : ''
  if (description.trim() === '') {
    return { ok: false, message: `${where} 缺少 description（模型靠它判断该不该用）` }
  }
  if (description.length > PLUGIN_DESCRIPTION_MAX) {
    return {
      ok: false,
      message: `${where}.description 是 ${description.length} 字符，上限 ${PLUGIN_DESCRIPTION_MAX}`,
    }
  }

  const risk = typeof raw['risk'] === 'string' ? raw['risk'] : ''
  if (!isPluginRisk(risk)) {
    return {
      ok: false,
      message: `${where}.risk 必须是 read / write / execute / network 之一，实际是「${risk}」`,
    }
  }

  const params = raw['parameters']
  if (!isObject(params)) return { ok: false, message: `${where}.parameters 必须是对象` }
  if (params['type'] !== 'object') {
    return { ok: false, message: `${where}.parameters.type 必须是 "object"` }
  }
  const props = params['properties']
  if (props !== undefined) {
    if (!isObject(props)) {
      return { ok: false, message: `${where}.parameters.properties 必须是对象` }
    }
    const count = Object.keys(props).length
    if (count > PLUGIN_PARAMS_MAX_PROPS) {
      return {
        ok: false,
        message: `${where}.parameters 有 ${count} 个属性，上限 ${PLUGIN_PARAMS_MAX_PROPS}`,
      }
    }
  }
  const serializedLength = JSON.stringify(params).length
  if (serializedLength > PLUGIN_PARAMS_MAX_CHARS) {
    return {
      ok: false,
      message: `${where}.parameters 序列化后 ${serializedLength} 字符，上限 ${PLUGIN_PARAMS_MAX_CHARS}`,
    }
  }

  const pathArgsRaw = raw['pathArgs']
  let pathArgs: string[] = []
  if (pathArgsRaw !== undefined) {
    if (!Array.isArray(pathArgsRaw) || pathArgsRaw.some((entry) => typeof entry !== 'string')) {
      return { ok: false, message: `${where}.pathArgs 必须是字符串数组` }
    }
    pathArgs = pathArgsRaw as string[]
    const declared = isObject(props) ? Object.keys(props) : []
    for (const key of pathArgs) {
      if (!declared.includes(key)) {
        return {
          ok: false,
          message: `${where}.pathArgs 里的「${key}」没有在 parameters.properties 里声明`,
        }
      }
    }
  }

  const envRaw = raw['env']
  let env: Record<string, string> = {}
  if (envRaw !== undefined) {
    if (!isObject(envRaw)) return { ok: false, message: `${where}.env 必须是对象` }
    for (const [key, value] of Object.entries(envRaw)) {
      if (typeof value !== 'string') {
        return { ok: false, message: `${where}.env.${key} 必须是配置路径字符串` }
      }
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
        return { ok: false, message: `${where}.env 的键「${key}」必须是全大写下划线的变量名` }
      }
      env[key] = value
    }
  }

  const run = raw['run']
  if (!isObject(run)) return { ok: false, message: `${where}.run 必须是对象` }
  if (run['type'] !== 'command') {
    return { ok: false, message: `${where}.run.type 必须是 "command"（v1 只有这一种）` }
  }
  const argv = run['argv']
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, message: `${where}.run.argv 必须是非空数组` }
  }
  if (argv.some((entry) => typeof entry !== 'string')) {
    return { ok: false, message: `${where}.run.argv 的每个元素都必须是字符串` }
  }
  const tokens = argv as string[]
  if (tokens.some((token) => token.includes('\0'))) {
    return { ok: false, message: `${where}.run.argv 不能含 NUL 字符` }
  }

  const timeoutMs = run['timeoutMs']
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
  ) {
    return { ok: false, message: `${where}.run.timeoutMs 必须是正整数` }
  }
  if (typeof timeoutMs === 'number' && timeoutMs > PLUGIN_TIMEOUT_MAX_MS) {
    return {
      ok: false,
      message: `${where}.run.timeoutMs 是 ${timeoutMs}，上限 ${PLUGIN_TIMEOUT_MAX_MS}`,
    }
  }

  const stdin = run['stdin']
  if (stdin !== undefined && stdin !== 'json' && stdin !== 'none') {
    return { ok: false, message: `${where}.run.stdin 只能是 "json" 或 "none"` }
  }
  const output = run['output']
  if (output !== undefined && output !== 'text' && output !== 'json') {
    return { ok: false, message: `${where}.run.output 只能是 "text" 或 "json"` }
  }

  return {
    ok: true,
    tool: {
      name,
      description,
      risk,
      parameters: params,
      ...(pathArgs.length === 0 ? {} : { pathArgs }),
      ...(Object.keys(env).length === 0 ? {} : { env }),
      run: {
        type: 'command',
        argv: tokens,
        ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
        ...(stdin === undefined ? {} : { stdin }),
        ...(output === undefined ? {} : { output }),
      },
    },
  }
}

/** 深度找某个键（用来抓"藏在任何位置的 shell"） */
function findKey(value: unknown, key: string, at = '$'): string | null {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const hit = findKey(value[i], key, `${at}[${i}]`)
      if (hit !== null) return hit
    }
    return null
  }
  if (!isObject(value)) return null
  for (const [k, v] of Object.entries(value)) {
    if (k === key) return `${at}.${k}`
    const hit = findKey(v, key, `${at}.${k}`)
    if (hit !== null) return hit
  }
  return null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
