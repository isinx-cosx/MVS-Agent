/**
 * **界面能发的命令，daemon 必须都有分支。**
 *
 * ## 这个测试守的是什么
 *
 * 界面上的每个入口最终都变成一条命令（发消息、切模型、撤回、批准…）。
 * 而"命令在协议里声明了"和"daemon 真的处理它"是两件事 ——
 * 少一个分支，用户看到的就是**点了没用**（请求发出去了，什么都没发生）。
 *
 * 所以这里做一件事：**从两边各读一遍源码，断言界面发的集合 ⊆ daemon 处理的集合**。
 *
 * ## ⚠️ 它抓不到什么（必须说清，免得给人错觉）
 *
 * 它**抓不到**今天那个"切换模型点了没用" —— 那次命令有分支、返回还 ok，
 * 错的是**界面从哪个数据源取值**（那是 `ui/model-choice.ts` 那条测试的职责）。
 *
 * 也就是说：**这个测试只保证"通路存在"，不保证"界面显示了正确的东西"**。
 * 两者都要有，谁也不能替谁。
 *
 * ## 为什么读源码而不是起服务
 *
 * 起真服务逐个发一遍当然更强，但那要几十秒且依赖运行环境；
 * 而这里要守的不变量纯粹是**源码层面的一致性**（"少写一个 case"）——
 * 用读源码的方式，失败信息能直接指到那一行，代价接近零。
 */

import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(here, '..')

/** 界面里出现的所有 `type: '<命令>'` */
function commandsSentByUi(): Map<string, string> {
  const found = new Map<string, string>()
  const dir = path.join(projectRoot, 'ui')
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') && !name.endsWith('.tsx')) continue
    const text = readFileSync(path.join(dir, name), 'utf8')
    for (const match of text.matchAll(/type:\s*'([a-z_]+)'/g)) {
      const command = match[1]
      if (command === undefined) continue
      if (!found.has(command)) found.set(command, name)
    }
  }
  return found
}

/** daemon 的 `#applyCommand` 里写了哪些 `case '<命令>'` */
function commandsHandledByDaemon(): Set<string> {
  const text = readFileSync(path.join(projectRoot, 'src/host/server.ts'), 'utf8')
  const handled = new Set<string>()
  for (const match of text.matchAll(/case\s+'([a-z_]+)':/g)) {
    const command = match[1]
    if (command !== undefined) handled.add(command)
  }
  return handled
}

test('★ 界面发的每一条命令，daemon 都有分支（少一条就是「点了没用」）', () => {
  const sent = commandsSentByUi()
  const handled = commandsHandledByDaemon()

  /* 先确认两边都读到了东西 —— 读源码的测试最怕"正则没匹配上"然后空对空通过 */
  assert.ok(sent.size >= 8, `只从 ui/ 读到 ${sent.size} 条命令，正则可能失效了`)
  assert.ok(handled.size >= 8, `只从 server.ts 读到 ${handled.size} 个 case，正则可能失效了`)

  const missing = [...sent.entries()].filter(([command]) => !handled.has(command))
  assert.deepEqual(
    missing.map(([command, file]) => `${command}（界面在 ${file} 里发它）`),
    [],
    '界面会发这些命令，但 daemon 没有对应分支 —— 用户点了不会有任何反应',
  )
})

test('daemon 不会对着"未知命令"兜底通过 —— 那条分支必须还在', () => {
  /*
   * 这条是给上面那条测试配对用的：如果哪天有人把 default 分支删了、
   * 让未知命令静默成功，上面那条测试反而会更容易过（错误信息没了）。
   */
  const text = readFileSync(path.join(projectRoot, 'src/host/server.ts'), 'utf8')
  assert.match(text, /default:\s*\r?\n\s*return \{ ok: false, message: '未知命令' \}/)
})
