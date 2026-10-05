/**
 * 搜索工具：`grep`（找内容）和 `glob`（找文件）。
 *
 * ## 为什么这两个是「能不能干活」的分界线
 *
 * 原来的工具集能**读、写、建、删、跑命令** —— 但**找不到东西**。
 * 在一个有几百个文件的仓库里，没有搜索的 agent 只能靠 `run_command` 去跑
 * `findstr` / `rg`，而那要求：命令行存在、语法对、输出格式能看、路径能转义对。
 * 四个条件任何一个不成立，agent 就卡在那里 —— 而它**不会说「我不会搜」**，
 * 它会编一个看起来像答案的东西。
 *
 * ## 不用外部命令
 *
 * 纯 Node 遍历 + 正则。理由不是「不想依赖」 —— 是 `rg` / `findstr` 在
 * **每台机器上的行为都不一样**（`findstr` 不支持正则的所有形式、`rg` 未必装、
 * 两者对二进制文件的处理不同）。工具的输出形状必须是**确定的**，
 * 否则模型看到的东西会随机器变。
 *
 * ## ⚠️ 两处静默失败要防
 *
 * 1. **结果是空的**：要区分「真的没有匹配」和「路径错了 / 权限不够」。
 *    两件事对模型的意义完全相反 —— 前者说明「这个仓库里没有」，
 *    后者说明「我没看到」。混在一起的话模型会基于「没看到」断言「不存在」。
 * 2. **结果被截断**：截断了必须**说出来**。不说的话模型以为看到了全部，
 *    于是漏掉的那部分在它眼里等于不存在。
 */

import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveInsideRoot } from './paths.ts'
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  failResult,
  okResult,
  type AnyTool,
  type Tool,
  type ToolContext,
  type ToolResult,
} from './types.ts'

/**
 * 遍历时跳过的目录。
 *
 * 这些不是「不重要」，而是**跳过它们才能在有意义的规模上返回结果**：
 * `node_modules` 动辄几万文件，`grep` 命中的多半是依赖内部的实现细节，
 * 而不是用户要改的代码。而 `.git` 里是压缩过的对象，**读出来是乱码**。
 *
 * 单个目录的入口先跳掉，比「走完再过滤」省一到两个数量级的时间。
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
])

/** 单个文件超过这个大小就不搜了 —— 命中的多半是压缩产物或数据文件 */
const MAX_FILE_BYTES = 2 * 1024 * 1024

/** 遍历到的文件数上限。到了就停下来并**报告截断**，见文件头第 2 条 */
const MAX_FILES_WALKED = 20_000

interface WalkHit {
  /** 相对工作区根的路径（正斜杠），给模型看更整齐 */
  rel: string
  abs: string
  bytes: number
}

interface WalkResult {
  files: WalkHit[]
  /** 撞到上限了 —— **必须报出去** */
  truncated: boolean
}

/**
 * 走一遍目录树，收集文件。
 *
 * @param root - 工作区根的绝对路径
 * @param start - 从哪开始（已经确保在 root 内）
 * @param matcher - 路径过滤器，收**相对 root 的正斜杠路径**
 */
async function walkFiles(
  root: string,
  start: string,
  matcher: (rel: string) => boolean,
): Promise<WalkResult> {
  const files: WalkHit[] = []
  const queue: string[] = [start]
  let truncated = false

  while (queue.length > 0) {
    if (files.length >= MAX_FILES_WALKED) {
      truncated = true
      break
    }
    const dir = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // 读不了就跳过（权限、竞态删除）。**但不算作「没有匹配」** —— 见下面 grep 的说明
      continue
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = path.relative(root, abs).split(path.sep).join('/')

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        queue.push(abs)
        continue
      }

      /*
       * ⚠️ **不跟符号链接**。
       *
       * 跟进去可能绕圈（自指的链接），而遍历挂死会让整个会话卡住 ——
       * 比「少搜了几个文件」糟得多。目录联结（junction）在 Windows 上
       * `isDirectory()` 也为真，但这里用的是 `readdir` 的 dirent，
       * 符号链接的 dirent 是 `isSymbolicLink()` 而**不是** `isDirectory()`，
       * 所以上面那支不会把它排进队列。
       */
      if (!entry.isFile()) continue
      if (!matcher(rel)) continue

      let bytes = 0
      try {
        const info = await lstat(abs)
        bytes = info.size
      } catch {
        continue
      }
      if (bytes > MAX_FILE_BYTES) continue

      files.push({ rel, abs, bytes })
      if (files.length >= MAX_FILES_WALKED) {
        truncated = true
        break
      }
    }
  }

  return { files, truncated }
}

/**
 * 把 `*` / `?` / `**` 的 glob 编成正则。
 *
 * ## 为什么手写而不是引一个 glob 库
 *
 * 这个项目**零运行时依赖**。而这里需要的匹配很有限（`*`、`?`、`**`、
 * 以及字符类），手写四十行比引一个库更容易审查 —— 尤其是它要处理
 * 「`*` 不跨目录分隔符、`**` 跨」这条容易写错的规则。
 *
 * ⚠️ `*` **不匹配 `/`**，`**` 才跨目录。写错的话 `src/*.ts` 会连
 * `src/a/b.ts` 一起匹配，而用户以为只看一层。
 */
function globToRegExp(pattern: string): RegExp {
  let out = '^'
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*'
      if (isDouble) {
        // `**/` 连同后面的斜杠一起吃掉，这样 `**/x` 也能匹配根下的 `x`
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  out += '$'
  return new RegExp(out)
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

interface GlobArgs {
  pattern: string
  path?: string
}

export const globTool: Tool<GlobArgs> = {
  name: 'glob',
  description:
    '按路径模式找文件，例如 "src/**/*.ts"、"**/*.test.ts"。返回按修改时间倒序的路径（最近改的在前）。' +
    '自动跳过 node_modules、.git、dist 这些目录。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        minLength: 1,
        description: 'glob 模式，相对路径。`*` 不跨目录，`**` 跨目录',
      },
      path: { type: 'string', description: '从哪个子目录开始找，默认工作区根目录' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const start = args.path === undefined ? ctx.root : undefined
    if (start === undefined) {
      const resolved = resolveInsideRoot(ctx.root, args.path!)
      if (!resolved.ok) return failResult('outside_root', resolved.message)
      return await runGlob(args, ctx, resolved.absolute)
    }
    return await runGlob(args, ctx, start)
  },
}

async function runGlob(args: GlobArgs, ctx: ToolContext, start: string): Promise<ToolResult> {
  const matcher = globToRegExp(args.pattern)
  const walked = await walkFiles(ctx.root, start, (rel) => matcher.test(rel))

  if (walked.files.length === 0) {
    /*
     * ⚠️ 「一个都没找到」要说清楚**是在哪儿找的**。
     *
     * 只说「没有匹配」的话，模型会当成「这个仓库里不存在」——
     * 而实际可能是它把 `path` 写错了。所以把搜索起点带出来。
     */
    return okResult(`没有匹配「${args.pattern}」的文件（在 ${path.relative(ctx.root, start) || '.'} 下找的）`, {
      count: 0,
      truncated: walked.truncated,
    })
  }

  // 最近改的在前：agent 找文件多半是想改它，改过的更可能是目标
  const withTime = await Promise.all(
    walked.files.map(async (file) => {
      try {
        const info = await lstat(file.abs)
        return { ...file, mtime: info.mtimeMs }
      } catch {
        return { ...file, mtime: 0 }
      }
    }),
  )
  withTime.sort((a, b) => b.mtime - a.mtime)

  const max = ctx.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const lines: string[] = []
  let shown = 0
  let cutByOutput = false
  for (const file of withTime) {
    const line = file.rel
    if (lines.join('\n').length + line.length + 1 > max) {
      cutByOutput = true
      break
    }
    lines.push(line)
    shown += 1
  }

  const notes: string[] = []
  if (cutByOutput) notes.push(`按输出上限截断，只列了 ${shown} / ${withTime.length} 个`)
  if (walked.truncated) notes.push(`遍历到 ${MAX_FILES_WALKED} 个文件就停了，可能还有更多`)

  const body = notes.length === 0 ? lines.join('\n') : `${lines.join('\n')}\n\n…（${notes.join('；')}）`
  return okResult(body, { count: withTime.length, shown, truncated: cutByOutput || walked.truncated })
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

interface GrepArgs {
  pattern: string
  include?: string
  path?: string
  maxResults?: number
}

export const grepTool: Tool<GrepArgs> = {
  name: 'grep',
  description:
    '在文件内容里按正则搜索，返回「文件:行号: 内容」。可用 include 只看某些文件（如 "*.ts"）。' +
    '自动跳过 node_modules、.git、dist 这些目录。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', minLength: 1, description: '正则表达式' },
      include: { type: 'string', description: '只搜匹配这个 glob 的文件，例如 "*.ts"' },
      path: { type: 'string', description: '从哪个子目录开始搜，默认工作区根目录' },
      maxResults: { type: 'integer', minimum: 1, maximum: 500, description: '最多返回多少条匹配，默认 100' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    let regex: RegExp
    try {
      regex = new RegExp(args.pattern)
    } catch (err) {
      /*
       * 正则写错要**明确说**是正则的问题。含糊地回「没有匹配」的话，
       * 模型会以为「这个仓库里没有」—— 而它只是把正则写错了，
       * 于是它会基于一个错的前提继续往下做。
       */
      return failResult('bad_pattern', `正则写错了：${err instanceof Error ? err.message : String(err)}`)
    }

    const start = args.path === undefined ? ctx.root : undefined
    let startAbs = ctx.root
    if (start === undefined) {
      const resolved = resolveInsideRoot(ctx.root, args.path!)
      if (!resolved.ok) return failResult('outside_root', resolved.message)
      startAbs = resolved.absolute
    }

    const includeMatcher = args.include === undefined ? null : globToRegExp(args.include)
    const walked = await walkFiles(ctx.root, startAbs, (rel) =>
      includeMatcher === null ? true : includeMatcher.test(rel) || includeMatcher.test(path.posix.basename(rel)),
    )

    const limit = args.maxResults ?? 100
    const max = ctx.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS
    const hits: string[] = []
    let skippedUnreadable = 0
    let cut = false

    for (const file of walked.files) {
      if (hits.length >= limit) {
        cut = true
        break
      }
      let text: string
      try {
        text = await readFile(file.abs, 'utf8')
      } catch {
        skippedUnreadable += 1
        continue
      }

      /*
       * 二进制文件：NUL 字节是最可靠的判据。
       * 不排掉的话，命中里会出现一堆乱码行 —— 那些会挤掉真正有用的结果，
       * 而且模型会试图从乱码里读意思。
       */
      if (text.includes('\u0000')) continue

      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i]!
        if (!regex.test(line)) continue
        const rendered = `${file.rel}:${i + 1}: ${line.trim().slice(0, 200)}`
        if (hits.join('\n').length + rendered.length + 1 > max) {
          cut = true
          break
        }
        hits.push(rendered)
        if (hits.length >= limit) {
          cut = true
          break
        }
      }
      if (cut) break
    }

    if (hits.length === 0) {
      const where = path.relative(ctx.root, startAbs) || '.'
      const extra =
        skippedUnreadable > 0 ? `（另有 ${skippedUnreadable} 个文件读不了，没搜到它们）` : ''
      return okResult(`没有匹配「${args.pattern}」的内容（在 ${where} 下搜的）${extra}`, {
        count: 0,
        skippedUnreadable,
      })
    }

    const notes: string[] = []
    if (cut) notes.push(`截断到 ${hits.length} 条`)
    if (walked.truncated) notes.push(`遍历到 ${MAX_FILES_WALKED} 个文件就停了`)
    if (skippedUnreadable > 0) notes.push(`${skippedUnreadable} 个文件读不了`)

    const body = notes.length === 0 ? hits.join('\n') : `${hits.join('\n')}\n\n…（${notes.join('；')}）`
    return okResult(body, { count: hits.length, truncated: cut || walked.truncated })
  },
}

export function searchTools(): AnyTool[] {
  return [globTool as AnyTool, grepTool as AnyTool]
}
