/**
 * 发现：把两个目录下的 `SKILL.md` 变成一个技能列表。
 *
 * 纯 I/O 加校验，不做缓存、不管启用状态 —— 那两件事在 `library.ts`。
 * 分开的理由：发现逻辑要能被单独测（喂它两个临时目录就行），
 * 而确认状态、写盘这些副作用不该混进来。
 *
 * ## 两个目录的优先级
 *
 *   `<工作区>/.mvs/skills/<name>/SKILL.md`   项目级
 *   `<MVS_HOME>/skills/<name>/SKILL.md`      用户级
 *
 * **项目级胜出**，被压掉的那份记一条提示。理由和配置层一致：
 * 越靠近具体工作区的越具体，应当能覆盖通用的那份。
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { parseFrontmatter } from './frontmatter.ts'
import {
  isSkillCategory,
  SKILL_CATEGORY_IDS,
  type Skill,
  type SkillNote,
  type SkillProblem,
  type SkillSource,
} from './types.ts'

const NAME_RE = /^[a-z0-9-]{1,40}$/
const DESC_MAX = 200

export interface DiscoverOptions {
  workspace: string
  /** 用户级技能的根目录（`<MVS_HOME>/skills`） */
  homeDir: string
  /** `skills.json` 里记录的哈希：名字 → 哈希 */
  approved: Record<string, string>
  /** 被显式停用的名字 */
  disabled: string[]
}

export interface DiscoverResult {
  skills: Skill[]
  problems: SkillProblem[]
  notes: SkillNote[]
}

const HASH_LEN = 16

export function hashSkill(frontmatterAndBody: string): string {
  return createHash('sha256').update(frontmatterAndBody).digest('hex').slice(0, HASH_LEN)
}

/** 项目级目录 */
export function projectSkillsDir(workspace: string): string {
  return path.join(workspace, '.mvs', 'skills')
}

/** 用户级目录 */
export function userSkillsDir(homeDir: string): string {
  return path.join(homeDir, 'skills')
}

export async function discover(options: DiscoverOptions): Promise<DiscoverResult> {
  const problems: SkillProblem[] = []
  const notes: SkillNote[] = []
  const byName = new Map<string, Skill>()

  const sources: Array<{ dir: string; source: SkillSource }> = [
    { dir: projectSkillsDir(options.workspace), source: 'project' },
    { dir: userSkillsDir(options.homeDir), source: 'user' },
  ]

  const disabled = new Set(options.disabled)

  for (const { dir, source } of sources) {
    for (const entry of await listSkillDirs(dir)) {
      const dirName = entry
      const file = path.join(dir, dirName, 'SKILL.md')

      let raw: string
      try {
        raw = await readFile(file, 'utf8')
      } catch {
        /* 目录里没有 SKILL.md 就不算技能，静默跳过（不是错误） */
        continue
      }

      const parsed = parseFrontmatter(raw)
      if (parsed.problem !== undefined) {
        problems.push({ path: file, name: dirName, message: parsed.problem })
        continue
      }

      const name = parsed.fields['name'] ?? ''
      const description = (parsed.fields['description'] ?? '').trim()
      const category = parsed.fields['category'] ?? ''

      if (name === '') {
        problems.push({ path: file, name: dirName, message: '缺少 name' })
        continue
      }
      if (!NAME_RE.test(name)) {
        problems.push({
          path: file,
          name: dirName,
          message: `name 只能用 1 到 40 个小写字母、数字或连字符，实际是「${name}」`,
        })
        continue
      }
      /*
       * **必须等于目录名**，不猜也不自动纠正。
       *
       * 不相等时，用户看到的技能名和它在磁盘上的位置对不上，
       * 而出错信息里只能显示其中一个 —— 那种错很难查。
       */
      if (name !== dirName) {
        problems.push({
          path: file,
          name,
          message: `name 必须等于目录名：目录是「${dirName}」，frontmatter 里写的是「${name}」`,
        })
        continue
      }
      if (description === '') {
        problems.push({ path: file, name, message: '缺少 description（它决定模型能不能判断该不该用）' })
        continue
      }
      if (description.length > DESC_MAX) {
        problems.push({
          path: file,
          name,
          message: `description 最多 ${DESC_MAX} 字符，实际 ${description.length}`,
        })
        continue
      }
      if (!isSkillCategory(category)) {
        problems.push({
          path: file,
          name,
          message: `category 必须是 ${SKILL_CATEGORY_IDS.join(' / ')} 之一，实际是「${category}」`,
        })
        continue
      }

      for (const key of Object.keys(parsed.fields)) {
        if (key !== 'name' && key !== 'description' && key !== 'category') {
          notes.push({ path: file, message: `「${name}」里的字段「${key}」v1 不认识，已忽略` })
        }
      }

      const existing = byName.get(name)
      if (existing !== undefined) {
        notes.push({
          path: file,
          message:
            `「${name}」有两份：${existing.source === 'project' ? '项目级' : '用户级'}胜出，` +
            `${source === 'project' ? '项目级' : '用户级'}这份被忽略`,
        })
        continue
      }

      const body = parsed.body.replace(/^\n/, '')
      const hash = hashSkill(raw)

      /*
       * 确认过、但哈希变了：**这必须说出来**。
       *
       * 两种「待确认」对用户的意义完全不同：
       *   · 第一次发现 → 「这是新东西，看一眼要不要用」
       *   · 内容变了   → 「这份你以前信过，但它被改过了」
       * 后者是共享技能最危险的情形（`git pull` 就能悄悄改掉一份你确认过的技能），
       * 所以它单独给一条 problem，界面上会显示成「内容已变更，需重新确认」。
       */
      const recorded = options.approved[name]
      if (recorded !== undefined && recorded !== hash) {
        problems.push({
          path: file,
          name,
          message: '内容已变更，需重新确认（正文的哈希与上次确认时不一致）',
        })
      }

      byName.set(name, {
        name,
        description,
        category,
        source,
        path: file,
        hash,
        approved: recorded === hash,
        enabled: !disabled.has(name),
        body,
      })
    }
  }

  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  return { skills, problems, notes }
}

/**
 * 列出目录下所有子目录。
 *
 * 目录不存在就是空（工作区里没有 `.mvs/skills` 是最常见的情况，不该报错）。
 */
async function listSkillDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}
