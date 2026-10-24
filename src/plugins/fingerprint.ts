/**
 * 轻量指纹：用来核对"声明为 read 的插件到底有没有动工作区"。
 *
 * ## 它是什么
 *
 * 遍历工作区，记 `相对路径 → mtime:size`。**不做内容哈希、不存 blob。**
 * 调用前后各取一次，比较两份索引。
 *
 * ## 为什么不用整树内容快照
 *
 * 那个恢复层已经在做了，代价是读全部文件内容。而这里要回答的问题更弱：
 * "有没有东西变了"。元数据就够，成本低一个数量级。
 *
 * ## 盲区（必须如实记录，不要以为它是防护）
 *
 * 抓不住：
 *
 *   · 内容变了但**大小相同、mtime 被改回原值**（`utimes` 一条命令就能做到）
 *   · 某些文件系统 mtime 精度只有 1 到 2 秒，同一窗口内的修改可能落在同一刻度
 *   · 删除后重建成同大小、同 mtime 的文件
 *   · **工作区之外的一切**（`~/.bashrc`、`/etc/hosts`、系统临时目录…）——
 *     指纹只扫工作区
 *   · **异步副作用**：调用返回后由 fork 出去的后台进程才去改文件，比对时还没发生
 *   · 网络请求、外部服务状态
 *
 * 抓得住：
 *
 *   · 内容变了且大小变了
 *   · 内容变了且 mtime 变了（绝大多数正常写入）
 *   · 新增/删除文件（集合本身变了；父目录的 mtime 也会变）
 *
 * ## 结论
 *
 * 指纹是**便宜的告警**，不是防护。它抓得住误声明与投机，抓不住刻意伪造。
 * 真正的防线是：风险等级（要不要问人）、整树快照（撤得回）、权限熔断。
 * 任何"声明 read 就一定没写东西"的说法都是错的，这里不做这种承诺。
 */

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'

/** 相对路径 → `mtimeMs:size` */
export type WorkspaceFingerprint = Map<string, string>

/** 这些目录不扫：它们是 VCS/依赖的噪音，而且会吞掉大量时间 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.venv', '__pycache__'])

/** 扫描上限。超过就停 —— 这只是一种告警机制，不该把一次工具调用拖成几十秒 */
const MAX_ENTRIES = 20_000

export async function fingerprintWorkspace(root: string): Promise<WorkspaceFingerprint> {
  const out: WorkspaceFingerprint = new Map()
  await walk(root, root, out)
  return out
}

async function walk(root: string, dir: string, out: WorkspaceFingerprint): Promise<void> {
  if (out.size >= MAX_ENTRIES) return

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (out.size >= MAX_ENTRIES) return
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full).split(path.sep).join('/')

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walk(root, full, out)
      continue
    }
    if (!entry.isFile()) continue

    try {
      const info = await stat(full)
      out.set(rel, `${Math.round(info.mtimeMs)}:${info.size}`)
    } catch {
      /* 读不到元数据的文件（权限、竞态删除）就跳过：它不该让整次核对失败 */
    }
  }
}

/**
 * 两份指纹的差异。
 *
 * 返回**变化了哪些路径**（新增、删除、修改都算），最多列 20 条 ——
 * 告警只要足以定位，不需要全量清单（全量清单会把工具结果撑爆）。
 */
export function diffFingerprints(
  before: WorkspaceFingerprint,
  after: WorkspaceFingerprint,
): { changed: string[]; total: number } {
  const changed: string[] = []

  for (const [rel, stamp] of after) {
    const previous = before.get(rel)
    if (previous !== stamp) changed.push(rel)
  }
  for (const rel of before.keys()) {
    if (!after.has(rel)) changed.push(rel)
  }

  const unique = [...new Set(changed)].sort()
  return { changed: unique.slice(0, 20), total: unique.length }
}
