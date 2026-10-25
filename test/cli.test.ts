/**
 * 技能 / 插件的命令行入口。
 *
 * 这两条 CLI 存在的理由只有一个：**确认这件事得能在终端里做**。
 * 之前只有 HTTP 命令（要令牌、要拼 JSON、还得先知道会话 id），
 * 于是"确认一份刚写好的技能"实际上只有作者做得来。
 *
 * ## 测什么
 *
 *   · `list` 能列出待确认 / 已确认 / 坏了，并且**坏的要说清哪里坏**
 *   · `approve` 之后状态真的变了（不是打印了成功就算）
 *   · 插件装的位置是 `<MVS_HOME>/plugins`，**不是工作区** ——
 *     这条最容易搞错，而错了的现象是"list 永远是空的"
 *   · 子命令写错 → 退出码 2（用法错误），不是 0
 *
 * ⚠️ 子进程输出**走文件描述符，不走管道**（本环境里 `stdio: 'pipe'` 会 EPERM）。
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SKILLS_CLI = path.resolve(HERE, '..', 'src', 'cli', 'skills.ts')
const PLUGINS_CLI = path.resolve(HERE, '..', 'src', 'cli', 'plugins.ts')

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

async function runCli(
  script: string,
  args: string[],
  env: Record<string, string>,
  outDir: string,
  tag: string,
): Promise<CliResult> {
  const stdoutFile = path.join(outDir, `out-${tag}.txt`)
  const stderrFile = path.join(outDir, `err-${tag}.txt`)
  const outFd = openSync(stdoutFile, 'w')
  const errFd = openSync(stderrFile, 'w')

  try {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [script, ...args], {
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
        env: { ...process.env, ...env },
      })
      child.on('error', () => resolve(null))
      child.on('close', (exitCode) => resolve(exitCode))
    })

    const read = async (file: string): Promise<string> => {
      try {
        return await readFile(file, 'utf8')
      } catch {
        return ''
      }
    }
    return { code, stdout: await read(stdoutFile), stderr: await read(stderrFile) }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
}

/** 一个工作区 + 一份技能 + 一个 home（插件装在这里） */
async function fixture(): Promise<{ base: string; workspace: string; home: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-cli-'))
  const workspace = path.join(base, 'ws')
  const home = path.join(base, 'home')
  await mkdir(path.join(workspace, '.mvs', 'skills', 'demo'), { recursive: true })
  await writeFile(
    path.join(workspace, '.mvs', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: 演示技能\ncategory: implement\n---\n\n步骤：先看再改。\n',
    'utf8',
  )
  await mkdir(path.join(home, 'plugins', 'hello'), { recursive: true })
  await writeFile(
    path.join(home, 'plugins', 'hello', 'plugin.json'),
    JSON.stringify({
      schema: 1,
      name: 'hello',
      version: '1.0.0',
      description: '演示插件',
      tools: [
        {
          name: 'greet',
          description: '打个招呼',
          risk: 'read',
          parameters: { type: 'object', properties: {} },
          run: { type: 'command', argv: ['node', '-e', 'console.log(1)'] },
        },
      ],
    }),
    'utf8',
  )
  await mkdir(path.join(home, 'plugins', 'wrecked'), { recursive: true })
  await writeFile(
    path.join(home, 'plugins', 'wrecked', 'plugin.json'),
    JSON.stringify({ schema: 1, name: 'wrecked' }),
    'utf8',
  )
  return { base, workspace, home }
}

test('skills CLI：list → approve → 再 list 状态变了', async () => {
  const { base, workspace, home } = await fixture()
  const env = { MVS_HOME: home }
  try {
    const listed = await runCli(SKILLS_CLI, ['list', '--workspace', workspace], env, base, 'list1')
    assert.equal(listed.code, 0, listed.stderr)
    assert.match(listed.stdout, /demo/)
    assert.match(listed.stdout, /待确认/)

    const approved = await runCli(SKILLS_CLI, ['approve', 'demo', '--workspace', workspace], env, base, 'ok')
    assert.equal(approved.code, 0, approved.stderr)
    assert.match(approved.stdout, /已确认/)

    const again = await runCli(SKILLS_CLI, ['list', '--workspace', workspace], env, base, 'list2')
    assert.match(again.stdout, /已确认/, `确认之后应当是「已确认」：${again.stdout}`)

    /* 停用之后 list 里要说停用 —— 状态是三个，不是一个 */
    const disabled = await runCli(SKILLS_CLI, ['disable', 'demo', '--workspace', workspace], env, base, 'off')
    assert.equal(disabled.code, 0, disabled.stderr)
    const afterDisable = await runCli(SKILLS_CLI, ['list', '--workspace', workspace], env, base, 'list3')
    assert.match(afterDisable.stdout, /已停用/, afterDisable.stdout)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('skills CLI：不存在的名字 → 非零退出，并说清楚', async () => {
  const { base, workspace, home } = await fixture()
  try {
    const result = await runCli(
      SKILLS_CLI,
      ['approve', '没有这个', '--workspace', workspace],
      { MVS_HOME: home },
      base,
      'missing',
    )
    assert.notEqual(result.code, 0, '失败必须是非零退出码')
    assert.ok(result.stderr.length > 0, '失败要有说明')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('skills CLI：未知子命令 → 退出码 2（用法错误）', async () => {
  const { base, workspace, home } = await fixture()
  try {
    const result = await runCli(SKILLS_CLI, ['frobnicate', '--workspace', workspace], { MVS_HOME: home }, base, 'usage')
    assert.equal(result.code, 2, `用法错误应当是 2，实际 ${result.code}`)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('plugins CLI：装的目录是 <MVS_HOME>/plugins，list 里能看到坏清单的原因', async () => {
  const { base, workspace, home } = await fixture()
  try {
    const listed = await runCli(PLUGINS_CLI, ['list', '--workspace', workspace], { MVS_HOME: home }, base, 'plist')
    assert.equal(listed.code, 0, listed.stderr)
    assert.match(listed.stdout, /hello/)
    assert.match(listed.stdout, /待确认/)
    /* 坏掉的清单要把**具体原因**说出来，而不是消失 */
    assert.match(listed.stdout, /wrecked/)
    assert.match(listed.stdout, /坏了/)

    const approved = await runCli(PLUGINS_CLI, ['approve', 'hello', '--workspace', workspace], { MVS_HOME: home }, base, 'pok')
    assert.equal(approved.code, 0, approved.stderr)

    const enabled = await runCli(PLUGINS_CLI, ['enable', 'hello', '--workspace', workspace], { MVS_HOME: home }, base, 'pen')
    assert.equal(enabled.code, 0, enabled.stderr)

    const show = await runCli(PLUGINS_CLI, ['show', 'hello', '--workspace', workspace], { MVS_HOME: home }, base, 'pshow')
    assert.match(show.stdout, /plugin__hello__greet/, '工具名应当是模型看到的完整形式')
    assert.match(show.stdout, /已启用/)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('plugins CLI：空目录时说清楚装在哪，而不是只说"没有"', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-cli-'))
  try {
    const workspace = path.join(base, 'ws')
    const home = path.join(base, 'home')
    await mkdir(workspace, { recursive: true })
    await mkdir(home, { recursive: true })

    const result = await runCli(PLUGINS_CLI, ['list', '--workspace', workspace], { MVS_HOME: home }, base, 'empty')
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /没有插件/)
    assert.ok(
      result.stdout.includes(path.join(home, 'plugins')),
      `要告诉用户装在哪：${result.stdout}`,
    )
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
