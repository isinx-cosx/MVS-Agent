/**
 * 文本差分：把「改了什么」从**计数**变成**逐行**。
 *
 * ## 为什么自己写
 *
 * 这不是"重复造轮子"，是零运行时依赖的直接后果：恢复层要能回答"这一步到底
 * 改了什么"，而这个项目运行期只允许 Node 自带模块。一个 Myers 差分核心不到
 * 一百行，比引一个库更好审。
 *
 * ## 三条必须守住的边界
 *
 *   1. **二进制不展开。** 逐行 diff 一张 PNG 会产出一屏乱码，那比"看不出来"更糟。
 *   2. **大文件不展开。** 一个 200 MB 的日志文件 diff 出来没人看，但会占满内存。
 *   3. **内容可能已经不在。** 快照被回收后 blob 会消失，那时要如实说"内容没了"，
 *      而不是给出一个"没有差异"的空结果 —— 后者会被读成"它没变"。
 *
 * ## 关于"上下文行"
 *
 * 只给命中行前后各 3 行。整文件贴出来在长文件上毫无用处，而 `@@` 头里的行号
 * 足以让人知道自己在文件的哪一段。
 */

/** 一行内容：` ` 不变、`-` 删除、`+` 新增 */
export interface DiffLine {
  kind: 'context' | 'del' | 'add'
  text: string
}

export interface DiffHunk {
  /** 旧文件里的起始行（1 基）与行数 */
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface FileDiff {
  path: string
  change: 'added' | 'modified' | 'removed'
  /** 二进制文件不展开，只给大小 */
  binary?: boolean
  /** 超过体积上限：不展开，只给大小 */
  tooLarge?: boolean
  /** 内容已经不在（快照被回收）—— 与"没有差异"是两件事 */
  contentGone?: boolean
  oldSize?: number
  newSize?: number
  hunks?: DiffHunk[]
  /** 统计：新增行数 / 删除行数（二进制或未展开时缺省） */
  added?: number
  removed?: number
}

export interface DiffOptions {
  /** 单文件超过这个字节数就不展开 */
  maxBytes?: number
  /** 命中行前后各给几行上下文 */
  context?: number
  /** 只给哪些文件（路径过滤；空 = 全部） */
  only?: string
}

const DEFAULT_MAX_BYTES = 1_000_000
const DEFAULT_CONTEXT = 3

/**
 * 二进制判定：前 8 KB 里出现 NUL 就当作二进制。
 *
 * 这是 git 自己用的那条启发式（`buffer_is_binary`），比值域分布统计简单得多，
 * 而且对"文本文件里混了少量不可打印字符"是宽容的。
 */
export function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, 8 * 1024)
  return window.includes(0)
}

function splitLines(buffer: Buffer): string[] {
  const text = buffer.toString('utf8')
  if (text === '') return []
  /* 末尾换行不该产生一个空的最后一行 —— 那会让"文件末尾加了一行"看起来像改了两处 */
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

interface Edit {
  kind: 'context' | 'del' | 'add'
  text: string
  oldLine: number
  newLine: number
}

/**
 * 最长公共子序列 → 编辑脚本。
 *
 * `O(n*m)` 的经典 DP。对**一个文件**来说是够的（对话里被改的多是几十到几千行），
 * 而它比 Myers 好写得多、也更容易证明是对的。真要处理两万行的文件再换成 Myers ——
 * 那时会有真实的性能数据，而不是提前猜。
 */
function editScript(oldLines: string[], newLines: string[]): Edit[] {
  const n = oldLines.length
  const m = newLines.length

  /*
   * 大文件的保险：DP 表是 (n+1)×(m+1)。两万行 × 两万行 = 4 亿格，
   * 那是几 GB 内存。超过就给一条**逐行对齐**的退化结果，并让调用方标 `tooLarge`。
   */
  const CELL_LIMIT = 4_000_000
  if ((n + 1) * (m + 1) > CELL_LIMIT) {
    const fallback: Edit[] = []
    const common = Math.min(n, m)
    for (let i = 0; i < common; i += 1) {
      if (oldLines[i] === newLines[i]) {
        fallback.push({ kind: 'context', text: oldLines[i] ?? '', oldLine: i + 1, newLine: i + 1 })
      } else {
        fallback.push({ kind: 'del', text: oldLines[i] ?? '', oldLine: i + 1, newLine: 0 })
        fallback.push({ kind: 'add', text: newLines[i] ?? '', oldLine: 0, newLine: i + 1 })
      }
    }
    for (let i = common; i < n; i += 1) {
      fallback.push({ kind: 'del', text: oldLines[i] ?? '', oldLine: i + 1, newLine: 0 })
    }
    for (let i = common; i < m; i += 1) {
      fallback.push({ kind: 'add', text: newLines[i] ?? '', oldLine: 0, newLine: i + 1 })
    }
    return fallback
  }

  const width = m + 1
  const table = new Int32Array((n + 1) * width)

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * width + (j + 1)]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!)
    }
  }

  const edits: Edit[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      edits.push({ kind: 'context', text: oldLines[i] ?? '', oldLine: i + 1, newLine: j + 1 })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
      edits.push({ kind: 'del', text: oldLines[i] ?? '', oldLine: i + 1, newLine: 0 })
      i += 1
    } else {
      edits.push({ kind: 'add', text: newLines[j] ?? '', oldLine: 0, newLine: j + 1 })
      j += 1
    }
  }
  while (i < n) {
    edits.push({ kind: 'del', text: oldLines[i] ?? '', oldLine: i + 1, newLine: 0 })
    i += 1
  }
  while (j < m) {
    edits.push({ kind: 'add', text: newLines[j] ?? '', oldLine: 0, newLine: j + 1 })
    j += 1
  }

  return edits
}

/**
 * 排版成 hunk：把编辑脚本切成"改动 + 前后各 `context` 行"的块。
 *
 * 两块之间如果只隔了几行不变的内容，合成一块 —— 否则一个文件改三处会变成
 * 三段各带三行上下文的重叠输出。
 */
function toHunks(edits: Edit[], context: number): DiffHunk[] {
  const changedAt: number[] = []
  for (let index = 0; index < edits.length; index += 1) {
    if (edits[index]!.kind !== 'context') changedAt.push(index)
  }
  if (changedAt.length === 0) return []

  const spans: Array<{ start: number; end: number }> = []
  for (const index of changedAt) {
    const start = Math.max(0, index - context)
    const end = Math.min(edits.length - 1, index + context)
    const last = spans[spans.length - 1]
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end)
    } else {
      spans.push({ start, end })
    }
  }

  const hunks: DiffHunk[] = []
  for (const span of spans) {
    const slice = edits.slice(span.start, span.end + 1)
    const first = slice[0]!
    const oldLines = slice.filter((edit) => edit.kind !== 'add').length
    const newLines = slice.filter((edit) => edit.kind !== 'del').length

    /* 头的起始行：这一块里第一条出现过的旧行 / 新行 */
    const oldStart = slice.find((edit) => edit.kind !== 'add')?.oldLine ?? 0
    const newStart = slice.find((edit) => edit.kind !== 'del')?.newLine ?? 0

    hunks.push({
      oldStart: oldStart === 0 ? Math.max(1, first.oldLine) : oldStart,
      oldLines,
      newStart: newStart === 0 ? Math.max(1, first.newLine) : newStart,
      newLines,
      lines: slice.map((edit) => ({
        kind: edit.kind,
        text: edit.text,
      })),
    })
  }
  return hunks
}

export interface TextDiffResult {
  binary: boolean
  tooLarge: boolean
  hunks: DiffHunk[]
  added: number
  removed: number
}

/**
 * 两次内容之间的差分。
 *
 * 两侧都给 `null` 表示"内容不在"（blob 被回收）—— 调用方据此标 `contentGone`。
 */
export function diffText(
  before: Buffer | null,
  after: Buffer | null,
  options: { maxBytes?: number; context?: number } = {},
): TextDiffResult | null {
  if (before === null && after === null) return null

  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const context = options.context ?? DEFAULT_CONTEXT

  /* 任一侧超大，或任一侧是二进制，就不展开 */
  const size = Math.max(before?.length ?? 0, after?.length ?? 0)
  if (size > maxBytes) {
    return { binary: false, tooLarge: true, hunks: [], added: 0, removed: 0 }
  }
  if ((before !== null && looksBinary(before)) || (after !== null && looksBinary(after))) {
    return { binary: true, tooLarge: false, hunks: [], added: 0, removed: 0 }
  }

  const oldLines = before === null ? [] : splitLines(before)
  const newLines = after === null ? [] : splitLines(after)
  const edits = editScript(oldLines, newLines)

  let added = 0
  let removed = 0
  for (const edit of edits) {
    if (edit.kind === 'add') added += 1
    if (edit.kind === 'del') removed += 1
  }

  return { binary: false, tooLarge: false, hunks: toHunks(edits, context), added, removed }
}
