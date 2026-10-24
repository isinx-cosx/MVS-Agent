/**
 * 搜索与精确编辑工具的测试。
 *
 * 所有文件操作都发生在 test/ 下的临时工作区里，用完即删 —— 不碰仓库里任何真实文件。
 *
 * 重点钉住的是**静默失败**那几类：找不到 vs 没搜到、截断了要说、锚点不唯一要报错。
 * 那些失败不抛异常，只是让模型基于一个错的前提继续往下做。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createDefaultRegistry } from '../src/tools/index.ts'
import type { ToolContext, ToolResult } from '../src/tools/types.ts'
import os from 'node:os'

const registry = createDefaultRegistry()

async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

const ctx = (root: string): ToolContext => ({ root })

/** 建一棵小树：src/ 下两个文件、node_modules 一个（要被跳过）、根下一个 */
async function seed(root: string): Promise<void> {
  await mkdir(path.join(root, 'src', 'deep'), { recursive: true })
  await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(
    path.join(root, 'src', 'a.ts'),
    ['const answer = 42', 'export function hello() {', '  return "hi"', '}', ''].join('\n'),
    'utf8',
  )
  await writeFile(
    path.join(root, 'src', 'deep', 'b.ts'),
    ['// answer lives here too', 'export const answer = 43', ''].join('\n'),
    'utf8',
  )
  await writeFile(path.join(root, 'notes.md'), '# answer\n\nsee src/a.ts\n', 'utf8')
  await writeFile(
    path.join(root, 'node_modules', 'pkg', 'index.js'),
    'const answer = "should never be searched"\n',
    'utf8',
  )
}

test('grep：找到内容，带上文件和行号', async () => {
  await withWorkspace(async (root) => {
    await seed(root)
    const result: ToolResult = await registry.execute('grep', { pattern: 'answer' }, ctx(root))
    assert.equal(result.ok, true)
    assert.match(result.content, /src\/a\.ts:1/)
    assert.match(result.content, /src\/deep\/b\.ts:1/)
  })
})

test('★ grep：跳过 node_modules', async () => {
  /*
   * 不跳的话，命中里绝大多数是依赖内部的实现细节，会挤掉用户真正要改的代码。
   * 而且 node_modules 动辄几万文件，不跳根本跑不完。
   */
  await withWorkspace(async (root) => {
    await seed(root)
    const result = await registry.execute('grep', { pattern: 'should never be searched' }, ctx(root))
    assert.equal(result.ok, true)
    assert.match(result.content, /没有匹配/, 'node_modules 里的内容不该被搜到')
  })
})

test('★ grep：正则写错 → bad_pattern，而不是「没有匹配」', async () => {
  /*
   * ⚠️ 这条最要紧。含糊地回「没有匹配」的话，模型会当成
   * 「这个仓库里没有这个东西」—— 而它只是正则写错了，于是会基于一个
   * **错的前提**继续往下做，而且全程不会有人发现。
   */
  await withWorkspace(async (root) => {
    await seed(root)
    const result = await registry.execute('grep', { pattern: '([unclosed' }, ctx(root))
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'bad_pattern')
    assert.match(result.error?.message ?? '', /正则/)
  })
})

test('grep：include 只看匹配的文件', async () => {
  await withWorkspace(async (root) => {
    await seed(root)
    const ts = await registry.execute('grep', { pattern: 'answer', include: '*.ts' }, ctx(root))
    assert.equal(ts.ok, true)
    assert.ok(!/notes\.md/.test(ts.content), 'include=*.ts 时不该出现 .md')

    const md = await registry.execute('grep', { pattern: 'answer', include: '*.md' }, ctx(root))
    assert.match(md.content, /notes\.md/)
  })
})

test('★ grep：没有匹配时要说清「在哪儿搜的」', async () => {
  /*
   * 只说「没有匹配」的话，模型会当成「仓库里不存在」——
   * 而实际可能是 path 写错了。把搜索起点带出来，这个歧义就没了。
   */
  await withWorkspace(async (root) => {
    await seed(root)
    const result = await registry.execute('grep', { pattern: 'zzz-not-there', path: 'src' }, ctx(root))
    assert.equal(result.ok, true)
    assert.match(result.content, /没有匹配/)
    assert.match(result.content, /src/, '要说出来是在 src 下搜的')
  })
})

test('glob：* 不跨目录，** 跨目录', async () => {
  await withWorkspace(async (root) => {
    await seed(root)

    const oneLevel = await registry.execute('glob', { pattern: 'src/*.ts' }, ctx(root))
    assert.equal(oneLevel.ok, true)
    assert.match(oneLevel.content, /src\/a\.ts/)
    assert.ok(
      !/src\/deep\/b\.ts/.test(oneLevel.content),
      '`*` 不该跨过目录分隔符 —— 跨了的话 `src/*.ts` 会连深层文件一起返回，而用户以为只看一层',
    )

    const deep = await registry.execute('glob', { pattern: 'src/**/*.ts' }, ctx(root))
    assert.equal(deep.ok, true)
    assert.match(deep.content, /src\/a\.ts/)
    assert.match(deep.content, /src\/deep\/b\.ts/)
  })
})

test('glob：**/x 也能匹配根下的 x', async () => {
  await withWorkspace(async (root) => {
    await seed(root)
    const result = await registry.execute('glob', { pattern: '**/notes.md' }, ctx(root))
    assert.equal(result.ok, true)
    assert.match(result.content, /notes\.md/, '**/ 前缀不该把根下的文件排除掉')
  })
})

test('★ glob：没找到时说清楚是在哪个目录下找的', async () => {
  await withWorkspace(async (root) => {
    await seed(root)
    const result = await registry.execute('glob', { pattern: 'nope/**/*.xyz' }, ctx(root))
    assert.equal(result.ok, true)
    assert.match(result.content, /没有匹配/)
  })
})

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

test('edit：唯一锚点能改掉，其余内容原样不动', async () => {
  await withWorkspace(async (root) => {
    await seed(root)
    const before = await readFile(path.join(root, 'src', 'a.ts'), 'utf8')

    const result = await registry.execute(
      'edit',
      { path: 'src/a.ts', oldString: 'const answer = 42', newString: 'const answer = 100' },
      ctx(root),
    )
    assert.equal(result.ok, true)

    const after = await readFile(path.join(root, 'src', 'a.ts'), 'utf8')
    assert.match(after, /const answer = 100/)
    assert.match(after, /export function hello/, '别的地方要原样保留')
    assert.equal(after.length, before.length + 1, "'42'（2 字符）→ '100'（3 字符），正好多 1 个")
  })
})

test('★★ edit：锚点出现多次 → ambiguous，而且**一处都不改**', async () => {
  /*
   * ⚠️ 这是整个工具集里最要紧的一条断言。
   *
   * 锚点不唯一时有两条路：改第一处（猜），或者报错。**猜的代价是改错了地方
   * 而且不报错** —— 那是最糟的一类失败：文件看起来改成功了，
   * 而真正要改的那处没动，或者另一处被顺手改了。
   *
   * 所以这里同时验两件事：返回 ambiguous，以及**文件内容一个字节都没变**。
   * 只验前者的话，实现完全可能先改了一处再报错。
   */
  await withWorkspace(async (root) => {
    await writeFile(
      path.join(root, 'dup.ts'),
      ['const x = 1', 'const y = 2', 'const x = 1', ''].join('\n'),
      'utf8',
    )
    const before = await readFile(path.join(root, 'dup.ts'), 'utf8')

    const result = await registry.execute(
      'edit',
      { path: 'dup.ts', oldString: 'const x = 1', newString: 'const x = 9' },
      ctx(root),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'ambiguous')
    assert.match(result.error?.message ?? '', /出现了 2 次/)
    assert.match(result.error?.message ?? '', /没有改任何东西/, '要说清楚没改')
    assert.match(result.error?.message ?? '', /第 1、3 行/, '要把出现位置给出来，否则调用方还得自己找')

    const after = await readFile(path.join(root, 'dup.ts'), 'utf8')
    assert.equal(after, before, '报错时文件必须一个字节都没变')
  })
})

test('edit：replaceAll 显式打开时才全部替换', async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, 'dup.ts'), 'a\nb\na\n', 'utf8')
    const result = await registry.execute(
      'edit',
      { path: 'dup.ts', oldString: 'a', newString: 'Z', replaceAll: true },
      ctx(root),
    )
    assert.equal(result.ok, true)
    assert.equal(await readFile(path.join(root, 'dup.ts'), 'utf8'), 'Z\nb\nZ\n')
  })
})

test('edit：找不到锚点 → 提示检查空白字符', async () => {
  await withWorkspace(async (root) => {
    await seed(root)
    const result = await registry.execute(
      'edit',
      { path: 'src/a.ts', oldString: 'const answer   = 42', newString: 'x' },
      ctx(root),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'not_found')
    assert.match(result.error?.message ?? '', /空白/, '最常见的原因是空白差异，得说出来')
  })
})

test('edit：oldString === newString → no_change', async () => {
  await withWorkspace(async (root) => {
    await seed(root)
    const result = await registry.execute(
      'edit',
      { path: 'src/a.ts', oldString: 'const answer = 42', newString: 'const answer = 42' },
      ctx(root),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'no_change')
  })
})

test('edit：路径逃不出工作区', async () => {
  await withWorkspace(async (root) => {
    await seed(root)
    const result = await registry.execute(
      'edit',
      { path: '../outside.txt', oldString: 'a', newString: 'b' },
      ctx(root),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'outside_root')
  })
})

test('edit：newString 为空串 = 删掉那一段', async () => {
  await withWorkspace(async (root) => {
    await seed(root)
    const result = await registry.execute(
      'edit',
      { path: 'src/a.ts', oldString: 'const answer = 42\n', newString: '' },
      ctx(root),
    )
    assert.equal(result.ok, true)
    const after = await readFile(path.join(root, 'src', 'a.ts'), 'utf8')
    assert.ok(!after.includes('const answer = 42'))
    assert.match(after, /export function hello/, '其余部分要留着')
  })
})
