/**
 * 文件工具：读、写、创建、删除。
 *
 * 每个工具的 parameters 是单一事实来源（既给模型看，也用于运行时校验）。
 */

import { lstat, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveInsideRoot } from './paths.ts'
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  failResult,
  okResult,
  type AnyTool,
  type Tool,
  type ToolResult,
} from './types.ts'

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

interface ReadFileArgs {
  path: string
  offset?: number
  limit?: number
}

export const readFileTool: Tool<ReadFileArgs> = {
  name: 'read_file',
  description:
    '读取文本文件。默认读全文，可用 offset/limit 按行读取大文件的一部分。路径相对于工作区根目录。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, description: '文件路径，相对于工作区根目录' },
      offset: { type: 'integer', minimum: 1, description: '起始行号，从 1 开始' },
      limit: { type: 'integer', minimum: 1, description: '最多读取的行数' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const target = resolveInsideRoot(ctx.root, args.path)
    if (!target.ok) return failResult('outside_root', target.message)

    let stats
    try {
      stats = await lstat(target.absolute)
    } catch {
      return failResult('not_found', `文件不存在：${args.path}`)
    }
    if (stats.isDirectory()) {
      return failResult('is_a_directory', `${args.path} 是目录，不是文件`)
    }

    let raw: string
    try {
      raw = await readFile(target.absolute, 'utf8')
    } catch (err) {
      return failResult('failed', `读取失败：${messageOf(err)}`)
    }

    const allLines = raw.split('\n')
    const start = args.offset === undefined ? 0 : Math.max(0, args.offset - 1)
    const end = args.limit === undefined ? allLines.length : start + args.limit
    const selected = allLines.slice(start, end)

    const max = ctx.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
    let content = selected.join('\n')
    let truncatedOutput = false
    if (content.length > max) {
      content = `${content.slice(0, max)}\n…（输出已截断，原始长度 ${content.length} 字符）`
      truncatedOutput = true
    }

    return okResult(content, {
      path: target.absolute,
      totalLines: allLines.length,
      returnedLines: selected.length,
      bytes: Buffer.byteLength(raw, 'utf8'),
      truncated: truncatedOutput,
    })
  },
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

interface WriteFileArgs {
  path: string
  content: string
}

export const writeFileTool: Tool<WriteFileArgs> = {
  name: 'write_file',
  description:
    '写入文件，会**覆盖**已有内容。父目录不存在时自动创建。若要保证不覆盖已有文件，用 create_file。',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, description: '文件路径，相对于工作区根目录' },
      content: { type: 'string', description: '要写入的完整内容' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const target = resolveInsideRoot(ctx.root, args.path)
    if (!target.ok) return failResult('outside_root', target.message)

    const existing = await statOrNull(target.absolute)
    if (existing?.isDirectory()) {
      return failResult('is_a_directory', `${args.path} 是目录，不能写入`)
    }

    try {
      await mkdir(path.dirname(target.absolute), { recursive: true })
      await writeFile(target.absolute, args.content, 'utf8')
    } catch (err) {
      return failResult('failed', `写入失败：${messageOf(err)}`)
    }

    const created = existing === null
    return okResult(
      `${created ? '已创建' : '已覆盖'} ${args.path}（${Buffer.byteLength(args.content, 'utf8')} 字节）`,
      { path: target.absolute, created, bytes: Buffer.byteLength(args.content, 'utf8') },
    )
  },
}

// ---------------------------------------------------------------------------
// create_file
// ---------------------------------------------------------------------------

interface CreateFileArgs {
  path: string
  content?: string
}

export const createFileTool: Tool<CreateFileArgs> = {
  name: 'create_file',
  description:
    '新建文件。如果文件已存在则**拒绝**（这是它与 write_file 的唯一区别：防止误覆盖）。父目录不存在时自动创建。',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, description: '文件路径，相对于工作区根目录' },
      content: { type: 'string', description: '初始内容，默认空字符串' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const target = resolveInsideRoot(ctx.root, args.path)
    if (!target.ok) return failResult('outside_root', target.message)

    if (await statOrNull(target.absolute)) {
      return failResult('already_exists', `文件已存在：${args.path}（要覆盖请用 write_file）`)
    }

    const content = args.content ?? ''
    try {
      await mkdir(path.dirname(target.absolute), { recursive: true })
      // 'wx' 让「不存在才创建」成为原子操作，避免检查与写入之间的竞态
      await writeFile(target.absolute, content, { encoding: 'utf8', flag: 'wx' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return failResult('already_exists', `文件已存在：${args.path}（要覆盖请用 write_file）`)
      }
      return failResult('failed', `创建失败：${messageOf(err)}`)
    }

    return okResult(`已创建 ${args.path}`, {
      path: target.absolute,
      bytes: Buffer.byteLength(content, 'utf8'),
    })
  },
}

// ---------------------------------------------------------------------------
// delete_file
// ---------------------------------------------------------------------------

interface DeleteFileArgs {
  path: string
  recursive?: boolean
}

export const deleteFileTool: Tool<DeleteFileArgs> = {
  name: 'delete_file',
  description:
    '删除文件。传目录路径时必须显式给 recursive: true，否则会被拒绝 —— 目录删除不可逆，不接受默认递归。',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, description: '文件或目录路径，相对于工作区根目录' },
      recursive: {
        type: 'boolean',
        description: '路径是目录时，必须显式设为 true 才会递归删除',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const target = resolveInsideRoot(ctx.root, args.path)
    if (!target.ok) return failResult('outside_root', target.message)

    let stats
    try {
      stats = await lstat(target.absolute)
    } catch {
      return failResult('not_found', `路径不存在：${args.path}`)
    }

    const isDirectory = stats.isDirectory()
    if (isDirectory && args.recursive !== true) {
      return failResult(
        'is_a_directory',
        `${args.path} 是目录。目录删除不可逆，确认要连同内容一起删除请显式传 recursive: true。`,
      )
    }

    try {
      if (isDirectory) await rm(target.absolute, { recursive: true, force: true })
      else await unlink(target.absolute)
    } catch (err) {
      return failResult('failed', `删除失败：${messageOf(err)}`)
    }

    return okResult(`已删除${isDirectory ? '目录' : '文件'} ${args.path}`, {
      path: target.absolute,
      kind: isDirectory ? 'directory' : 'file',
      recursive: args.recursive === true,
    })
  },
}

// ---------------------------------------------------------------------------

async function statOrNull(p: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(p)
  } catch {
    return null
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 供测试与将来的工具循环使用：一次拿到全部文件工具 */
export function fileTools(): AnyTool[] {
  return [readFileTool, writeFileTool, createFileTool, deleteFileTool]
}
