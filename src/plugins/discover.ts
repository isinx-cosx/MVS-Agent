/**
 * 已安装插件的发现（只扫一个目录）。
 *
 * ## 为什么只有 `<MVS_HOME>/plugins`
 *
 * **不做**「工作区里的插件目录」。技能可以跟着仓库走（它是纯文本，且有确认机制），
 * 插件不行：它的破坏力大得多，而"clone 一个仓库就带进来一组能跑命令的工具"
 * 是最典型的供应链入口。
 *
 * 安装 = 把目录放进 `<MVS_HOME>/plugins/<名字>/`，没有网络安装源。
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { parseManifest } from './manifest.ts'
import type { PluginProblem, PluginRecord } from './types.ts'

export interface DiscoveredPlugin {
  dir: string
  name: string
  hash: string
  record: PluginRecord | null
  problem: PluginProblem | null
}

export function pluginsDir(homeDir: string): string {
  return path.join(homeDir, 'plugins')
}

export async function discoverPlugins(homeDir: string): Promise<DiscoveredPlugin[]> {
  const root = pluginsDir(homeDir)
  let entries: string[] = []
  try {
    const list = await readdir(root, { withFileTypes: true })
    entries = list
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    /* 没有插件目录是最常见的情况，不算错误 */
    return []
  }

  const out: DiscoveredPlugin[] = []

  for (const dirName of entries) {
    const dir = path.join(root, dirName)
    const file = path.join(dir, 'plugin.json')

    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      out.push({
        dir,
        name: dirName,
        hash: '',
        record: null,
        problem: {
          path: file,
          name: dirName,
          message: '目录里没有 plugin.json',
        },
      })
      continue
    }

    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16)
    const parsed = parseManifest(raw, dirName)

    if (!parsed.ok) {
      out.push({
        dir,
        name: dirName,
        hash,
        record: null,
        problem: { path: file, name: dirName, message: parsed.message },
      })
      continue
    }

    const manifest = parsed.manifest
    out.push({
      dir,
      name: manifest.name,
      hash,
      problem: null,
      record: {
        dir,
        manifest,
        hash,
        approved: false,
        enabled: false,
        toolNames: manifest.tools.map((tool) => `plugin__${manifest.name}__${tool.name}`),
      },
    })
  }

  /* 同名插件（目录名不同但都叫同一个 name）：后到的失败，不静默覆盖 */
  const seen = new Map<string, DiscoveredPlugin>()
  for (const entry of out) {
    if (entry.record === null) continue
    const first = seen.get(entry.name)
    if (first === undefined) {
      seen.set(entry.name, entry)
      continue
    }
    entry.record = null
    entry.problem = {
      path: path.join(entry.dir, 'plugin.json'),
      name: entry.name,
      message: `插件名「${entry.name}」与 ${first.dir} 重复，这份没有被加载`,
    }
  }

  return out
}
