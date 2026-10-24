/**
 * `SKILL.md` 的 frontmatter 解析。
 *
 * ## 只支持扁平 `key: value`
 *
 * 不支持嵌套、不支持列表、不支持多行字符串。遇到这些**直接报错**，
 * 而不是尽力解析一下。
 *
 * 理由：「尽力解析」的失败方式是最坏的 —— 用户的 YAML 写错了，解析器猜了一个
 * 看起来合理的值，技能照常加载，但分类错了（或者描述是空的），
 * 于是模型永远查不到它，而界面上一切正常。宁可加载时报一条精确的错。
 *
 * ## 为什么不用 YAML 库
 *
 * 这个项目的运行时依赖是零（见 README）。为了三个字符串字段引入一个 YAML
 * 解析器（以及它的边界情况）不划算，而我们真正需要的语法只有一种。
 */

export interface ParsedFrontmatter {
  /** 解析出来的键值对。键都是小写原样，值去掉了首尾空白 */
  fields: Record<string, string>
  /** `---` 之后的正文（原样保留，包括空行） */
  body: string
  /** 解析失败的原因。非空时 `fields` 不可信 */
  problem?: string
}

const OPEN = '---'

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  /*
   * 允许文件开头有 BOM。Windows 上不少编辑器会写 BOM，而它会让
   * `startsWith('---')` 失败 —— 那种失败看起来像「这个文件没有 frontmatter」，
   * 于是技能被当成「缺 name」报错，用户完全不知道真正原因是 BOM。
   */
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const normalized = text.replace(/\r\n/g, '\n')

  if (!normalized.startsWith(`${OPEN}\n`)) {
    return {
      fields: {},
      body: normalized,
      problem: '文件必须以三横线开头，然后是 frontmatter（name / description / category）',
    }
  }

  const rest = normalized.slice(OPEN.length + 1)
  const closeAt = rest.indexOf(`\n${OPEN}\n`)
  const closeAtEof = rest.endsWith(`\n${OPEN}`) ? rest.length - OPEN.length - 1 : -1

  let headerEnd: number
  let bodyStart: number
  if (closeAt >= 0) {
    headerEnd = closeAt
    bodyStart = closeAt + 1 + OPEN.length + 1
  } else if (closeAtEof >= 0) {
    headerEnd = closeAtEof
    bodyStart = rest.length
  } else {
    return {
      fields: {},
      body: '',
      problem: 'frontmatter 没有闭合（缺少第二个三横线）',
    }
  }

  const header = rest.slice(0, headerEnd)
  const body = rest.slice(bodyStart)

  const fields: Record<string, string> = {}
  const lines = header.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line.trim() === '') continue

    /*
     * 嵌套与列表：明确拒绝。
     *
     * 判据是「行首有空白」或「行首是 - 」。这两条覆盖了 YAML 里
     * 绝大多数需要缩进的结构（嵌套映射、列表、多行字符串）。
     */
    if (/^\s/.test(line)) {
      return {
        fields,
        body,
        problem:
          'v1 不支持嵌套 frontmatter（检测到缩进行）。只写扁平的 `key: value` 三行即可，' +
          '复杂结构请写进正文。',
      }
    }
    if (/^-\s/.test(line)) {
      return {
        fields,
        body,
        problem: 'v1 不支持 frontmatter 里的列表。需要列表请写进正文。',
      }
    }

    const colon = line.indexOf(':')
    if (colon <= 0) {
      return {
        fields,
        body,
        problem: `frontmatter 第 ${i + 1} 行看不懂：「${line}」。格式是 key: value`,
      }
    }

    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()

    /* 去掉成对的引号 —— 用户从别处复制过来时常见 */
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }

    if (Object.prototype.hasOwnProperty.call(fields, key)) {
      return { fields, body, problem: `frontmatter 里「${key}」出现了两次` }
    }
    fields[key] = value
  }

  return { fields, body }
}
