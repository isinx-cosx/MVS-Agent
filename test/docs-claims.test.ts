/**
 * 文档断言测试：把"文档里说的话"钉成可执行断言。
 *
 * ## 为什么需要它
 *
 * 这个仓库最反复的失败不是写错代码，是**文档腐烂**：`docs/安全边界-现状.md`
 * 曾经写着"AppContainer 在 `src/` 里一处都没有"，而 `src/sandbox/appcontainer.ts`
 * 一直在那儿，`docs/挡不住清单.md` 里还有它的实测反例。读者按那句话会判断
 * "这个项目没有隔离" —— **往低估自己，比吹牛更危险**。
 *
 * 人肉再校对一遍只能管一次。这里挑几条**能被机器判定**的断言：
 *
 *   1. 文档引用的 `src/…` 文件必须真的存在（路径腐烂是最常见的一种）
 *   2. 几处已知会被"改回去"的说法，用不许出现的字符串钉住
 *
 * 它不追求覆盖所有句子 —— 覆盖得住的先覆盖，剩下的靠人。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = path.join(ROOT, 'docs')

function docFiles(): string[] {
  return readdirSync(DOCS).filter((name) => name.endsWith('.md')).map((name) => path.join(DOCS, name))
}

/** 文档里以反引号包起来的 `src/…` / `tools/…` 路径 */
function referencedPaths(text: string): string[] {
  const out = new Set<string>()
  for (const match of text.matchAll(/`((?:src|tools)\/[^`\s]+)`/g)) {
    /*
     * 去掉行号后缀（`:45` / `:45,112` / `:12-30`），再去掉无法当路径判定的写法：
     * 通配（`tools/sandbox-*.mjs`）、花括号展开（`src/skills/{a,b}.ts`）、目录（结尾 `/`）。
     * 这些不是"路径腐烂"，是"写法的局限"—— 判定不了就不该误报。
     */
    const raw = match[1]!.replace(/:[\d,\-]+$/, '')
    if (raw.includes('*') || raw.includes('{') || raw.includes('\u2026') || raw.endsWith('/')) continue
    out.add(raw)
  }
  return [...out]
}

test('文档引用的源码路径都真实存在', () => {
  const missing: string[] = []
  for (const file of docFiles()) {
    const text = readFileSync(file, 'utf8')
    for (const rel of referencedPaths(text)) {
      if (!existsSync(path.join(ROOT, rel))) missing.push(`${path.basename(file)} → ${rel}`)
    }
  }
  assert.deepEqual(missing, [], `有文档引用了不存在的路径：\n${missing.join('\n')}`)
})

test('安全边界文档不许再说"src/ 里一处都没有"', () => {
  const text = readFileSync(path.join(DOCS, '安全边界-现状.md'), 'utf8')
  /*
   * 这句曾经是**往低估自己**的那种错：读者会据此认为项目没有任何系统级隔离。
   * 现在沙箱在 `src/sandbox/`，所以这句不许回来。
   */
  assert.ok(!text.includes('一处都没有'), '这句话已经过期：AppContainer 在 src/sandbox/ 里')
  assert.ok(text.includes('src/sandbox/appcontainer.ts'), '应当明确指向沙箱实现的位置')
})

test('README 不许再自我宣传"八个层次"（模块数与实际不符）', () => {
  const text = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  assert.ok(!text.includes('当前八个层次'), '模块数与实际不符')
})
