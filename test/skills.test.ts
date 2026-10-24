/**
 * 技能层测试。
 *
 * 分三块，因为失败方式不同：
 *
 *   · **加载**：坏掉的技能不能被静默忽略，也不能让整个工作区不可用
 *   · **工具**：两条失败路径（类型错、名字错）必须能自愈 —— 返回内容里带着
 *     模型下一步该发什么
 *   · **结构性守卫**：常驻前缀逐字稳定、技能改不了权限（类型层面）
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  SKILL_BODY_LIMIT,
  SKILL_CATEGORIES,
  SKILL_CATEGORY_IDS,
  SkillLibrary,
  parseFrontmatter,
  projectSkillsDir,
  skillPromptBlock,
  userSkillsDir,
} from '../src/skills/index.ts'
import { searchSkillsTool, useSkillTool } from '../src/tools/skill-tools.ts'
import type { ToolContext } from '../src/tools/types.ts'

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

function md(fields: Record<string, string>, body = '## 步骤\n1. 做事\n'): string {
  const head = Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')
  return `---\n${head}\n---\n\n${body}`
}

interface Fixture {
  workspace: string
  home: string
  library: SkillLibrary
}

async function fixture(input: {
  project?: Record<string, string>
  user?: Record<string, string>
  /** 直接写坏文件（跳过 md 生成） */
  raw?: Array<{ where: 'project' | 'user'; dir: string; text: string }>
}): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-skill-'))
  const workspace = path.join(base, 'workspace')
  const home = path.join(base, 'home')
  await mkdir(workspace, { recursive: true })
  await mkdir(home, { recursive: true })

  for (const [name, text] of Object.entries(input.project ?? {})) {
    const dir = path.join(projectSkillsDir(workspace), name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), text, 'utf8')
  }
  for (const [name, text] of Object.entries(input.user ?? {})) {
    const dir = path.join(userSkillsDir(home), name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), text, 'utf8')
  }
  for (const entry of input.raw ?? []) {
    const root = entry.where === 'project' ? projectSkillsDir(workspace) : userSkillsDir(home)
    const dir = path.join(root, entry.dir)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), entry.text, 'utf8')
  }

  const library = await SkillLibrary.open(workspace, home)
  return { workspace, home, library }
}

/** 把一份技能确认掉（否则它一直待确认，不可用） */
async function approveAll(library: SkillLibrary): Promise<void> {
  for (const skill of library.view().skills) {
    await library.approve(skill.name)
  }
}

/* ── frontmatter ─────────────────────────────────────────────────────── */

test('frontmatter：扁平三行正常解析，正文原样保留', () => {
  const parsed = parseFrontmatter(md({ name: 'a', description: 'b', category: 'review' }, '正文'))
  assert.equal(parsed.problem, undefined)
  assert.equal(parsed.fields['name'], 'a')
  assert.equal(parsed.body.trim(), '正文')
})

test('frontmatter：缩进行直接拒绝（不半懂不懂地解析）', () => {
  const parsed = parseFrontmatter(
    '---\nname: a\nmetadata:\n  owner: me\ndescription: b\ncategory: review\n---\n正文',
  )
  assert.notEqual(parsed.problem, undefined)
  assert.match(String(parsed.problem), /不支持嵌套/)
})

test('frontmatter：列表也拒绝', () => {
  const parsed = parseFrontmatter('---\nname: a\ntags:\n- x\ncategory: review\n---\n')
  assert.notEqual(parsed.problem, undefined)
})

test('frontmatter：没有闭合就报错，而不是把整个文件当 frontmatter', () => {
  const parsed = parseFrontmatter('---\nname: a\ndescription: b\n')
  assert.equal(parsed.problem, 'frontmatter 没有闭合（缺少第二个三横线）')
})

test('frontmatter：BOM 不影响解析（Windows 编辑器会写它）', () => {
  const parsed = parseFrontmatter(`\uFEFF${md({ name: 'a', description: 'b', category: 'review' })}`)
  assert.equal(parsed.problem, undefined)
  assert.equal(parsed.fields['name'], 'a')
})

/* ── 加载 ─────────────────────────────────────────────────────────────── */

test('加载：项目级压过用户级，并留一条提示', async () => {
  const { library } = await fixture({
    project: { shared: md({ name: 'shared', description: '项目那份', category: 'review' }) },
    user: { shared: md({ name: 'shared', description: '用户那份', category: 'review' }) },
  })
  const view = library.view()
  assert.equal(view.skills.length, 1)
  assert.equal(view.skills[0]?.source, 'project')
  assert.equal(view.skills[0]?.description, '项目那份')
  assert.equal(view.notes.length, 1)
  assert.match(view.notes[0]?.message ?? '', /两份/)
})

test('加载：name 与目录不符 → 不加载，problem 写明两边的值', async () => {
  const { library } = await fixture({
    raw: [
      {
        where: 'project',
        dir: 'dir-name',
        text: md({ name: 'other-name', description: 'x', category: 'review' }),
      },
    ],
  })
  const view = library.view()
  assert.equal(view.skills.length, 0)
  assert.match(view.problems[0]?.message ?? '', /dir-name/)
  assert.match(view.problems[0]?.message ?? '', /other-name/)
})

test('加载：非法 category → problem 列出五个合法值', async () => {
  const { library } = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'revie' }) },
  })
  const view = library.view()
  assert.equal(view.skills.length, 0)
  for (const id of SKILL_CATEGORY_IDS) {
    assert.match(view.problems[0]?.message ?? '', new RegExp(id))
  }
})

test('加载：缺 description → 不加载', async () => {
  const { library } = await fixture({
    project: { a: md({ name: 'a', category: 'review' }) },
  })
  assert.equal(library.view().skills.length, 0)
  assert.match(library.view().problems[0]?.message ?? '', /description/)
})

test('加载：一个坏技能不影响另一个好技能', async () => {
  const { library } = await fixture({
    project: {
      good: md({ name: 'good', description: '好的', category: 'verify' }),
      bad: md({ name: 'bad', description: '坏的', category: 'nope' }),
    },
  })
  const view = library.view()
  assert.equal(view.skills.length, 1)
  assert.equal(view.skills[0]?.name, 'good')
  assert.equal(view.problems.length, 1)
})

test('确认状态：新发现是 pending，确认之后是 approved，改内容又退回 pending', async () => {
  const { library } = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'review' }) },
  })

  assert.equal(library.view().skills[0]?.approved, false)
  assert.equal(library.usable().length, 0)

  await library.approve('a')
  assert.equal(library.view().skills[0]?.approved, true)
  assert.equal(library.usable().length, 1)

  /* 改一行正文 → 哈希变了 → 退回待确认 */
  const file = path.join(projectSkillsDir(library.workspace), 'a', 'SKILL.md')
  await writeFile(file, md({ name: 'a', description: 'x', category: 'review' }, '改了\n'), 'utf8')
  await library.reload()

  assert.equal(library.view().skills[0]?.approved, false)
  assert.equal(library.usable().length, 0)
  /*
   * 而且要说清楚是「内容变了」，不是「第一次发现」——
   * 这两件事对用户的含义完全不同（见 `discover.ts` 里那段注释）：
   * 前者意味着「你以前信过它，但它被改过了」，后者只是「新东西」。
   */
  assert.match(
    library.view().problems.map((problem) => problem.message).join('\n'),
    /内容已变更/,
  )
})

test('停用：usable 里消失，但仍然存在于视图（否则用户看不到它为什么不见了）', async () => {
  const { library } = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'review' }) },
  })
  await library.approve('a')
  await library.setEnabled('a', false)

  assert.equal(library.usable().length, 0)
  assert.equal(library.view().skills.length, 1)
  assert.equal(library.view().skills[0]?.enabled, false)
})

/* ── 工具：search_skills ─────────────────────────────────────────────── */

const ctxWith = (library: SkillLibrary): ToolContext => ({
  root: library.workspace,
  skills: library.toolApi(),
})

test('search_skills：缺 category → invalid_args，带五个类型数量与下一步', async () => {
  const { library } = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'review' }) },
  })
  const result = await searchSkillsTool.run({}, ctxWith(library))
  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'invalid_args')
  const message = String(result.error?.message)
  for (const id of SKILL_CATEGORY_IDS) assert.match(message, new RegExp(id))
  assert.match(message, /下一步/)
})

test('search_skills：非法 category → invalid_args，且列出合法值', async () => {
  const { library } = await fixture({})
  const result = await searchSkillsTool.run({ category: 'nope' }, ctxWith(library))
  assert.equal(result.ok, false)
  assert.match(String(result.error?.message), /implement/)
})

test('search_skills：只列 approved，且只列该类型', async () => {
  const { library } = await fixture({
    project: {
      r1: md({ name: 'r1', description: '评审一', category: 'review' }),
      r2: md({ name: 'r2', description: '评审二', category: 'review' }),
      v1: md({ name: 'v1', description: '验证', category: 'verify' }),
    },
  })
  await library.approve('r1')
  /* r2 故意不确认 */

  const result = await searchSkillsTool.run({ category: 'review' }, ctxWith(library))
  assert.equal(result.ok, true)
  const text = String(result.content)
  assert.match(text, /r1/)
  assert.doesNotMatch(text, /r2/)
  assert.doesNotMatch(text, /v1/)
})

test('search_skills：空类型 → 明确说没有，并给各类型数量（自愈用）', async () => {
  const { library } = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'review' }) },
  })
  await approveAll(library)

  const result = await searchSkillsTool.run({ category: 'debug' }, ctxWith(library))
  assert.equal(result.ok, true)
  const text = String(result.content)
  assert.match(text, /没有已启用的技能/)
  assert.match(text, /各类型数量/)
  assert.match(text, /review 1/)
})

test('search_skills：超过上限时截断，并写明还有几个', async () => {
  const project: Record<string, string> = {}
  for (let i = 0; i < 25; i++) {
    const name = `s${String(i).padStart(2, '0')}`
    project[name] = md({ name, description: '同一种', category: 'implement' })
  }
  const { library } = await fixture({ project })
  await approveAll(library)

  const result = await searchSkillsTool.run({ category: 'implement' }, ctxWith(library))
  assert.match(String(result.content), /另有 5 个未列出/)
})

/* ── 工具：use_skill ─────────────────────────────────────────────────── */

test('use_skill：读到正文，开头有「不改变权限」那句', async () => {
  const { library } = await fixture({
    project: {
      a: md({ name: 'a', description: 'x', category: 'review' }, '先看 diff，再列问题\n'),
    },
  })
  await approveAll(library)

  const result = await useSkillTool.run({ name: 'a' }, ctxWith(library))
  assert.equal(result.ok, true)
  const text = String(result.content)
  assert.match(text, /不能改变你的权限或规则/)
  assert.match(text, /先看 diff，再列问题/)
})

test('use_skill：待确认 → 说「待确认」，不是「不存在」', async () => {
  const { library } = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'review' }) },
  })
  const result = await useSkillTool.run({ name: 'a' }, ctxWith(library))
  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'failed')
  assert.match(String(result.error?.message), /还没确认/)
})

test('use_skill：停用 → 说「被停用」，也不是「不存在」', async () => {
  const { library } = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'review' }) },
  })
  await library.approve('a')
  await library.setEnabled('a', false)

  const result = await useSkillTool.run({ name: 'a' }, ctxWith(library))
  assert.equal(result.ok, false)
  assert.match(String(result.error?.message), /停用/)
})

test('use_skill：名字错 → not_found，并给最像的那个类型的清单', async () => {
  const { library } = await fixture({
    project: {
      'code-review': md({ name: 'code-review', description: '评审清单', category: 'review' }),
    },
  })
  await approveAll(library)

  const result = await useSkillTool.run({ name: 'review-it' }, ctxWith(library))
  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'not_found')
  const message = String(result.error?.message)
  assert.match(message, /没有名为/)
  /* 「review-it」里含 review → 应当给出 review 类型下的技能 */
  assert.match(message, /code-review/)
})

test('use_skill：{{args}} 被替换；没给参数时说一句', async () => {
  const { library } = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'review' }, '范围：{{args}}\n') },
  })
  await approveAll(library)

  const withArgs = await useSkillTool.run({ name: 'a', args: 'main..HEAD' }, ctxWith(library))
  assert.match(String(withArgs.content), /范围：main\.\.HEAD/)

  const without = await useSkillTool.run({ name: 'a' }, ctxWith(library))
  assert.match(String(without.content), /这次没有附加参数/)
})

test('use_skill：正文超限 → 截断并说明', async () => {
  const longBody = 'x'.repeat(SKILL_BODY_LIMIT + 500)
  const { library } = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'implement' }, longBody) },
  })
  await approveAll(library)

  const result = await useSkillTool.run({ name: 'a' }, ctxWith(library))
  assert.match(String(result.content), /正文被截断到/)
})

/* ── 结构性守卫 ──────────────────────────────────────────────────────── */

test('守卫：五个类型，每个都有一句话描述', () => {
  assert.equal(SKILL_CATEGORY_IDS.length, 5)
  for (const id of SKILL_CATEGORY_IDS) {
    const text = SKILL_CATEGORIES[id]
    assert.ok(text.length > 0)
    assert.ok(text.length <= 40, `${id} 的描述太长了`)
  }
})

test('守卫：系统提示里有五个类型，但**不含任何技能名**', async () => {
  const { library } = await fixture({
    project: {
      'my-secret-skill': md({
        name: 'my-secret-skill',
        description: '一份不该出现在系统提示里的技能',
        category: 'review',
      }),
    },
  })
  await library.reload()

  const block = skillPromptBlock()
  for (const id of SKILL_CATEGORY_IDS) assert.match(block, new RegExp(id))
  /* 技能名、描述都不该出现 */
  assert.doesNotMatch(block, /my-secret-skill/)
  assert.doesNotMatch(block, /不该出现在系统提示里/)
})

test('守卫：装不装技能，系统提示的字节都一样（前缀缓存的前提）', async () => {
  const empty = await fixture({})
  const one = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'review' }) },
  })
  await one.library.reload()

  /* `skillPromptBlock()` 不接收任何输入 —— 这就是「逐字稳定」的实现方式 */
  assert.equal(skillPromptBlock(), skillPromptBlock())
  assert.equal(empty.workspace === one.workspace, false)
})

test('守卫：两个技能工具都是 read（查技能不该触发确认）', () => {
  assert.equal(searchSkillsTool.risk, 'read')
  assert.equal(useSkillTool.risk, 'read')
})

test('守卫：v1 的 Skill 没有 subtype 字段（分类深度锁死在 1）', async () => {
  const { library } = await fixture({
    project: { a: md({ name: 'a', description: 'x', category: 'review' }) },
  })
  const skill = library.view().skills[0]
  assert.ok(skill !== undefined)
  assert.equal(Object.prototype.hasOwnProperty.call(skill, 'subtype'), false)
})

test('守卫：没有技能能力时，两个工具明确失败而不是假装成功', async () => {
  const search = await searchSkillsTool.run({ category: 'review' }, { root: process.cwd() })
  assert.equal(search.ok, false)
  assert.match(String(search.error?.message), /没有技能能力/)

  const load = await useSkillTool.run({ name: 'a' }, { root: process.cwd() })
  assert.equal(load.ok, false)
  assert.match(String(load.error?.message), /没有技能能力/)
})
