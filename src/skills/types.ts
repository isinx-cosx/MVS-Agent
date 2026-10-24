/**
 * 技能层的公共类型。
 *
 * ## 这一层的定位
 *
 * 技能是**用户写的一段流程说明**（Markdown），在需要的时候被读进上下文。
 * 它不执行、不出网、不写文件，也改不了权限。
 *
 * 整层设计的难点只有一个：**怎么让模型知道有它**。答案在这里是
 * 「模型主动查」：五个父类型写死在系统提示里，具体技能靠 `search_skills` 查。
 *
 * ## 为什么五个类型写死在代码里
 *
 * 因为它们是**唯一**会进系统提示的技能相关内容。写死之后：
 *
 *   · 增删技能、改名、改描述，系统提示一个字节都不变
 *   · 常驻前缀逐字稳定，前缀缓存一直命中（本机模型上这是几百毫秒到几秒）
 *
 * 一旦让类型表来自用户的文件，每加一个技能就可能改一次常驻前缀，
 * 缓存每次都被废掉，而且提示长度不再受控。
 *
 * ## v1 没有子类型
 *
 * `Skill` 里**没有** `subtype` 字段，这是刻意的（见设计文档第 2 节）：
 * 分类超过两层之后，模型和用户都会开始乱放，查询路径每多一层就多一个失败点。
 * 将来要加时再加一个可选字段，旧技能天然是「该类型下的直接成员」，不需要迁移。
 */

/** 五个父类型。**只有这张表会进系统提示。** */
export const SKILL_CATEGORIES = {
  implement: '写新代码、改现有实现、重构与迁移',
  review: '读代码找问题：正确性、安全、兼容性',
  debug: '定位原因：复现、看日志、缩小范围',
  verify: '证明它对：补测试、跑验收、判断回归面',
  deliver: '把结果交出去：提交信息、变更说明、发布',
} as const

export type SkillCategory = keyof typeof SKILL_CATEGORIES

export const SKILL_CATEGORY_IDS = Object.keys(SKILL_CATEGORIES) as SkillCategory[]

export function isSkillCategory(value: string): value is SkillCategory {
  return Object.prototype.hasOwnProperty.call(SKILL_CATEGORIES, value)
}

/** 技能的来源。项目级跟着仓库走，用户级是这台机器上自己写的 */
export type SkillSource = 'project' | 'user'

export interface Skill {
  name: string
  description: string
  category: SkillCategory
  source: SkillSource
  /** `SKILL.md` 的绝对路径（界面要显示它，出错时也靠它定位） */
  path: string
  /** frontmatter + 正文的 sha256 前 16 位。确认状态就是靠它 */
  hash: string
  /** 哈希与 `skills.json` 里记录的一致 → 可用 */
  approved: boolean
  /** 没被显式停用 */
  enabled: boolean
  /** 正文。发现时一起读进来了（文件很小），避免每次调用都重读 */
  body: string
}

/**
 * 一条**错误**：这份技能不会加载。
 *
 * 消息必须精确到字段（「category 必须是 …，实际是 revie」），
 * 因为这条消息会直接显示在设置页上，含糊的话用户只能猜。
 */
export interface SkillProblem {
  path: string
  name: string | null
  message: string
}

/** 一条**提示**：不影响加载，但用户应该知道 */
export interface SkillNote {
  path: string
  message: string
}

export interface SkillView {
  skills: Skill[]
  problems: SkillProblem[]
  notes: SkillNote[]
}

/* ── 工具层看到的能力面 ──────────────────────────────────────────────── */

/**
 * `search_skills` 的结果。
 *
 * 失败分两类，因为模型下一步该做的事不同：
 *   · `missing_category` / `bad_category`：参数问题，它该改成合法类型重发
 *     所以消息里必须带**各类型数量**与一句「下一步」示例
 */
export type SkillSearchOutcome =
  | { ok: true; category: SkillCategory; text: string }
  | { ok: false; kind: 'missing_category' | 'bad_category'; message: string }

/**
 * `use_skill` 的结果。
 *
 * 三种失败必须分开（见设计文档第 7 节）：
 *   · `not_found`：名字错，消息里要给**最像的那个类型**的清单，它下一次能改对
 *   · `pending`：技能存在但内容没确认 —— 这不是「不存在」，不能混
 *   · `disabled`：技能被停用 —— 也不是「不存在」
 */
export type SkillLoadOutcome =
  | { ok: true; skill: Skill; text: string; truncated: boolean }
  | { ok: false; kind: 'not_found' | 'pending' | 'disabled'; message: string }

/**
 * 注入到 `ToolContext` 的能力。
 *
 * 和 `webSearch` / `spawnAgent` 同一条规矩：工具只声明「我需要能查技能」，
 * 具体实现由会话层注入。工具层不自己去读工作区文件、不自己造索引。
 */
export interface SkillToolApi {
  search(category: string): SkillSearchOutcome
  load(name: string, args: string | undefined): SkillLoadOutcome
}

/** 正文上限。超过就截断，并在返回内容里说明 */
export const SKILL_BODY_LIMIT = 20_000

/** 单次 `search_skills` 最多列多少个名字 */
export const SKILL_LIST_LIMIT = 20

/** 描述在清单里最多显示多少字符 */
export const SKILL_DESC_LIMIT = 60
