/**
 * 技能层。
 *
 * 结构：
 *   `types.ts`       五个父类型、Skill / SkillView、工具层的能力面
 *   `frontmatter.ts` 只支持扁平 `key: value` 的解析器
 *   `discover.ts`    两个目录 → 技能列表（纯发现，无副作用）
 *   `library.ts`     发现结果 + 确认状态 + 两个工具要用的文本
 *   `prompt.ts`      系统提示里那块（只由类型表生成，逐字稳定）
 */

export {
  SKILL_BODY_LIMIT,
  SKILL_CATEGORIES,
  SKILL_CATEGORY_IDS,
  SKILL_DESC_LIMIT,
  SKILL_LIST_LIMIT,
  isSkillCategory,
  type Skill,
  type SkillCategory,
  type SkillLoadOutcome,
  type SkillNote,
  type SkillProblem,
  type SkillSearchOutcome,
  type SkillSource,
  type SkillToolApi,
  type SkillView,
} from './types.ts'
export { parseFrontmatter, type ParsedFrontmatter } from './frontmatter.ts'
export {
  discover,
  hashSkill,
  projectSkillsDir,
  userSkillsDir,
  type DiscoverOptions,
  type DiscoverResult,
} from './discover.ts'
export { SkillLibrary } from './library.ts'
export { skillPromptBlock } from './prompt.ts'
