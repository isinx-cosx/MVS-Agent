/**
 * `edit` —— 精确替换文件里的一段。
 *
 * ## 为什么需要一个单独的工具（而不是让模型 `write_file` 整个重写）
 *
 * 整文件重写有两个后果，都在实际使用里出问题：
 *
 * 1. **代价**：改一行要把整个文件重新生成一遍，长文件里模型很容易在中途
 *    漏掉或改动别的地方 —— 而那些改动**不会报错**。
 * 2. **风险**：`write_file` 的语义是「这个文件现在长这样」。模型只要有一处
 *    记错了，那次写入就把**用户没让它碰的内容也覆盖了**。
 *
 * 所以 `edit` 的整个设计围绕一件事：**只改指定的那一处，其余原样不动**。
 *
 * ## ⚠️ 锚点不唯一时必须报错，不能猜
 *
 * 这是这个文件最重要的一条。`oldString` 在文件里出现两次时，有两条路：
 *
 *   · 改第一处（"猜"）
 *   · **报错，让调用方给更长的锚点**
 *
 * 猜的代价是**改错了地方而且不报错** —— 那是最糟的一类失败：文件看起来改成功了，
 * 而真正要改的那处没动，或者另一处被改了。所以这里选报错。
 *
 * 同样的道理我在 `tools/brand-app.mjs` 的 `replaceExactly` 里写过一遍，
 * 那次也踩过（锚点替换过一次之后再跑就「出现 0 次」，看起来像坏了，
 * 实际是已经成功过了）。
 *
 * ## 为什么要 `replaceAll` 这个开关
 *
 * 「必须唯一」在批量改名这种场景下太严 —— 那里**就是要改全部**。
 * 所以给一个显式的开关：默认唯一，要全改得**说出来**。
 * 显式说出来和默默改掉全部，差别就是「调用方知道自己在做什么」。
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolveInsideRoot } from './paths.ts'
import { failResult, okResult, type AnyTool, type Tool, type ToolResult } from './types.ts'

interface EditArgs {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

export const editTool: Tool<EditArgs> = {
  name: 'edit',
  description:
    '把文件里的一段原文换成新内容。默认要求 oldString 在文件里**只出现一次**（这样才知道改的是哪一处）；' +
    '要改多处就显式设 replaceAll。只动这一处，其余内容原样保留。',
  risk: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1, description: '文件路径，相对于工作区根目录' },
      oldString: {
        type: 'string',
        minLength: 1,
        description: '要被替换的原文。**要多带几行上下文**，好让它唯一',
      },
      newString: { type: 'string', description: '替换成什么。空串 = 删掉这一段' },
      replaceAll: {
        type: 'boolean',
        description: 'true = 替换所有出现（默认 false，出现多次会报错）',
      },
    },
    required: ['path', 'oldString', 'newString'],
    additionalProperties: false,
  },
  async run(args, ctx): Promise<ToolResult> {
    const target = resolveInsideRoot(ctx.root, args.path)
    if (!target.ok) return failResult('outside_root', target.message)

    let original: string
    try {
      original = await readFile(target.absolute, 'utf8')
    } catch (err) {
      return failResult('not_found', `读不到文件：${err instanceof Error ? err.message : String(err)}`)
    }

    /*
     * 自己的原文和替换文一模一样 —— 那这次调用什么都不会变，但调用方
     * 会以为改成功了。**说清楚**比默默成功好。
     */
    if (args.oldString === args.newString) {
      return failResult('no_change', 'oldString 和 newString 一样，这次调用不会改变任何东西')
    }

    let count = 0
    let at = original.indexOf(args.oldString)
    const firstAt = at
    while (at !== -1) {
      count += 1
      at = original.indexOf(args.oldString, at + args.oldString.length)
    }

    if (count === 0) {
      /*
       * 找不到要说清楚**为什么不匹配**。最常见的原因是空白差异
       * （行尾 CRLF / 缩进用了 tab），所以把这条提示直接给出去 ——
       * 否则模型会以为「文件不对」，然后去重读整个文件。
       */
      return failResult(
        'not_found',
        `文件里找不到这段原文。检查一下空白字符（缩进、行尾）是不是和文件里完全一致 —— ` +
          `这段的第一个字符是 ${JSON.stringify(args.oldString.slice(0, 20))}`,
      )
    }

    if (count > 1 && args.replaceAll !== true) {
      /*
       * ★ 这一条是这个文件的核心。见文件头。
       *
       * 把**每个出现位置的行号**给出去，调用方才能补上下文让它唯一 ——
       * 只说「出现了 N 次」的话它还得自己去找。
       */
      const lineNumbers: number[] = []
      let index = -1
      for (;;) {
        index = original.indexOf(args.oldString, index + 1)
        if (index === -1) break
        lineNumbers.push(original.slice(0, index).split('\n').length)
      }
      return failResult(
        'ambiguous',
        `这段原文在文件里出现了 ${count} 次（第 ${lineNumbers.join('、')} 行）。` +
          `**没有改任何东西** —— 请多带几行上下文让它唯一，或者显式设 replaceAll: true 来全部替换。`,
      )
    }

    const updated =
      args.replaceAll === true
        ? original.split(args.oldString).join(args.newString)
        : original.slice(0, firstAt) +
          args.newString +
          original.slice(firstAt + args.oldString.length)

    try {
      await writeFile(target.absolute, updated, 'utf8')
    } catch (err) {
      return failResult('failed', `写不进去：${err instanceof Error ? err.message : String(err)}`)
    }

    const line = original.slice(0, firstAt === -1 ? 0 : firstAt).split('\n').length
    return okResult(
      args.replaceAll === true
        ? `已替换 ${count} 处`
        : `已替换第 ${line} 行的那一处`,
      { path: target.absolute, replaced: args.replaceAll === true ? count : 1 },
    )
  },
}

export function editTools(): AnyTool[] {
  return [editTool as AnyTool]
}
