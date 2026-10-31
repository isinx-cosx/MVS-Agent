/**
 * 结构化的删除与移动 —— **`run_command` 不该承担改文件系统的职责**。
 *
 * ## 为什么需要这一对工具
 *
 * `rm -rf` 在策略上只能被 `ask`（提示一行动态拼接的字符串），而它拿到的东西
 * 比这个工具少三样：
 *
 *   · **路径围栏**：`rm` 可以写任何路径；这里每条都过 `resolveInsideRoot`
 *   · **可显示的影响面**：审批卡能列出"3 个路径、共 1 247 个文件、86 MB"
 *   · **可撤销**：这是在恢复层的边界**之内**发生的（一次事务），而 `rm` 只有
 *     在工作区内、且不在排除目录、且不超过单文件上限时才可撤
 *
 * ## 删除为什么还要 `recursive` 与 `why`
 *
 * - `recursive`：目录删除不可逆，不接受默认递归（和 `delete_file` 同一条取舍）
 * - `why`：这句话会进审批卡与审计 —— 用户看到的不是一串路径，而是"为什么删"
 *
 * ## 上限
 *
 * 一次最多 `MAX_PATHS` 条路径。这不是安全边界，是让"删一个目录树"与
 * "删一百个分散位置"这两件事在卡上可读。
 */

import { lstat, rm, rename, stat } from 'node:fs/promises'
import path from 'node:path'

import { resolveInsideRoot } from './paths.ts'
import { failResult, okResult, type Tool, type ToolResult } from './types.ts'

/** 一次调用最多处理几条路径 */
const MAX_PATHS = 200

interface DeletePathsArgs {
  paths: string[]
  why: string
  /** 路径里有目录时必须显式给 true */
  recursive?: boolean
  /** 目录干跑：只算数量和大小，不删 */
  dryRun?: boolean
}

interface MovePathArgs {
  from: string
  to: string
  why: string
  /** 目标已存在时是否覆盖。默认不覆盖 */
  overwrite?: boolean
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 递归数一个目录下的文件数与字节数。用于"影响面" */
async function measure(target: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const stack = [target]
  while (stack.length > 0) {
    const dir = stack.pop()!
    let items
    try {
      items = await import('node:fs/promises').then((fs) => fs.readdir(dir, { withFileTypes: true }))
    } catch {
      continue
    }
    for (const item of items) {
      const abs = path.join(dir, item.name)
      if (item.isDirectory()) {
        stack.push(abs)
        continue
      }
      files += 1
      try {
        bytes += (await stat(abs)).size
      } catch {
        /* 数不到就少算，别为此失败 */
      }
    }
  }
  return { files, bytes }
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export const deletePathsTool: Tool<DeletePathsArgs> = {
  name: 'delete_paths',
  description:
    '删除文件或目录（要删东西就用这个，不要用 run_command 里的 rm/del）。' +
    '每条路径都必须在工作区内；路径里有目录时必须显式给 recursive: true；' +
    '删除会进恢复层事务，可以撤销。why 会显示给用户。',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        minItems: 1,
        maxItems: MAX_PATHS,
        description: `要删除的路径（相对工作区根目录），一次最多 ${MAX_PATHS} 条`,
      },
      why: { type: 'string', minLength: 1, description: '为什么删 —— 会显示给用户，要具体' },
      recursive: {
        type: 'boolean',
        description: '路径里有目录时必须显式设为 true，否则拒绝',
      },
      dryRun: {
        type: 'boolean',
        description: '只统计会删掉多少文件、多大，不真的删',
      },
    },
    required: ['paths', 'why'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    if (!Array.isArray(args.paths) || args.paths.length === 0) {
      return failResult('invalid_args', 'paths 不能为空：要删什么得说清楚')
    }
    if (args.paths.length > MAX_PATHS) {
      return failResult(
        'invalid_args',
        `一次最多删 ${MAX_PATHS} 条路径，收到 ${args.paths.length} 条。请分批，或者删它们的共同父目录。`,
      )
    }

    const resolved: Array<{ input: string; absolute: string }> = []
    for (const input of args.paths) {
      const target = resolveInsideRoot(ctx.root, input)
      if (!target.ok) return failResult('outside_root', target.message)
      /* 删工作区根本身等于把项目删了 —— 这不是"清理" */
      if (path.resolve(target.absolute) === path.resolve(ctx.root)) {
        return failResult('outside_root', '不能删除工作区根目录本身')
      }
      resolved.push({ input, absolute: target.absolute })
    }

    const plan: Array<{ input: string; kind: 'file' | 'directory'; files: number; bytes: number }> = []
    for (const item of resolved) {
      let info
      try {
        info = await lstat(item.absolute)
      } catch {
        return failResult('not_found', `路径不存在：${item.input}`)
      }
      if (info.isDirectory()) {
        if (args.recursive !== true) {
          return failResult(
            'is_a_directory',
            `${item.input} 是目录。要连同里面的东西一起删，请显式传 recursive: true —— 目录删除不接受默认递归。`,
          )
        }
        const size = await measure(item.absolute)
        plan.push({ input: item.input, kind: 'directory', ...size })
      } else {
        plan.push({ input: item.input, kind: 'file', files: 1, bytes: info.size })
      }
    }

    const totalFiles = plan.reduce((sum, item) => sum + item.files, 0)
    const totalBytes = plan.reduce((sum, item) => sum + item.bytes, 0)
    const summary =
      `将删除 ${plan.length} 个路径（共 ${totalFiles} 个文件、${human(totalBytes)}）：` +
      plan.map((item) => `${item.input}${item.kind === 'directory' ? '/' : ''}`).join('、')

    if (args.dryRun === true) {
      return okResult(`${summary}（dryRun，没有真的删）`, { dryRun: true, paths: plan, totalFiles, totalBytes })
    }

    const failures: Array<{ path: string; message: string }> = []
    for (const [index, item] of resolved.entries()) {
      const kind = plan[index]?.kind ?? 'file'
      try {
        await rm(item.absolute, { recursive: kind === 'directory', force: true })
      } catch (err) {
        failures.push({ path: item.input, message: messageOf(err) })
      }
    }

    if (failures.length > 0) {
      return failResult(
        'failed',
        `${summary}；但有 ${failures.length} 条失败：` +
          failures.map((item) => `${item.path}（${item.message}）`).join('；'),
        { data: { paths: plan, totalFiles, totalBytes, failures } },
      )
    }

    return okResult(`${summary}。删除已进事务，可以撤销。`, {
      paths: plan,
      totalFiles,
      totalBytes,
      why: args.why,
    })
  },
}

export const movePathTool: Tool<MovePathArgs> = {
  name: 'move_path',
  description:
    '移动或重命名文件/目录（要移动就用这个，不要用 run_command 里的 mv/move/ren）。' +
    '两端都必须在工作区内；目标已存在时默认拒绝，要覆盖请显式 overwrite: true。' +
    '移动会进恢复层事务，可以撤销。',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', minLength: 1, description: '源路径（相对工作区根目录）' },
      to: { type: 'string', minLength: 1, description: '目标路径（相对工作区根目录）' },
      why: { type: 'string', minLength: 1, description: '为什么移动 —— 会显示给用户' },
      overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
    },
    required: ['from', 'to', 'why'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const from = resolveInsideRoot(ctx.root, args.from)
    if (!from.ok) return failResult('outside_root', from.message)
    const to = resolveInsideRoot(ctx.root, args.to)
    if (!to.ok) return failResult('outside_root', to.message)

    try {
      await lstat(from.absolute)
    } catch {
      return failResult('not_found', `源路径不存在：${args.from}`)
    }

    let exists = true
    try {
      await lstat(to.absolute)
    } catch {
      exists = false
    }
    if (exists && args.overwrite !== true) {
      return failResult(
        'already_exists',
        `目标已存在：${args.to}。要覆盖请显式传 overwrite: true —— 覆盖会丢掉原来的内容。`,
      )
    }

    try {
      await rename(from.absolute, to.absolute)
    } catch (err) {
      return failResult('failed', `移动失败：${messageOf(err)}`)
    }

    return okResult(`已移动 ${args.from} → ${args.to}`, {
      from: from.absolute,
      to: to.absolute,
      why: args.why,
      overwrote: exists,
    })
  },
}
