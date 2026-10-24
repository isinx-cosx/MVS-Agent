/**
 * 插件层测试。
 *
 * 覆盖三类失败，因为它们的后果差得很远：
 *
 *   · **清单校验**：不合规的插件整份拒绝 —— 半懂不懂地放行会得到一个"看起来装了、
 *     其实跑不起来"的空壳，那比没装更糟
 *   · **执行边界**：路径必须先过围栏再进 argv、缺少参数不许启动进程、
 *     超时必须杀得掉、密钥默认不给
 *   · **声明与实际不符**：声明 read 却写了工作区 → 报警并停用
 *
 * 最后一条的**盲区**也有一条测试：它明确断言"抓不到"，把"我们不防这个"
 * 变成一条可执行的记录，而不是口头约定。
 */

import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { PluginLibrary } from '../src/plugins/library.ts'
import { parseManifest } from '../src/plugins/manifest.ts'
import { pluginsDir } from '../src/plugins/discover.ts'
import type { PluginToolSpec } from '../src/plugins/types.ts'
import type { ToolContext, ToolResult } from '../src/tools/types.ts'

/** AnyTool.run 的入参是 never（每个工具有自己的类型），测试里放宽一层 */
type LooseTool = { run: (args: unknown, ctx: ToolContext) => Promise<ToolResult> }
const loose = (tool: unknown): LooseTool => tool as LooseTool

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

const cmd = (argv: string[], extra: Record<string, unknown> = {}): PluginToolSpec =>
  ({
    name: 'run',
    description: '测试用的工具',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    },
    run: { type: 'command', argv, ...extra },
  }) as PluginToolSpec

interface Fixture {
  home: string
  workspace: string
  library: PluginLibrary
}

async function fixture(input: {
  name: string
  tools: PluginToolSpec[]
  /** 直接写原始清单（跳过生成，用来测校验失败） */
  raw?: string
  approved?: boolean
  enabled?: boolean
}): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-plugin-'))
  const home = path.join(base, 'home')
  const workspace = path.join(base, 'workspace')
  await mkdir(workspace, { recursive: true })

  const dir = path.join(pluginsDir(home), input.name)
  await mkdir(dir, { recursive: true })

  const manifest =
    input.raw ??
    JSON.stringify({
      schema: 1,
      name: input.name,
      version: '1.0.0',
      description: '测试插件',
      tools: input.tools,
    })
  await writeFile(path.join(dir, 'plugin.json'), manifest, 'utf8')

  const library = await PluginLibrary.open(workspace, home)

  if (input.approved !== false) {
    const result = await library.approve(input.name)
    assert.equal(result.ok, true)
  }
  if (input.enabled === false) {
    await library.setEnabled(input.name, false)
  }

  return { home, workspace, library }
}

/** 一个会把收到的东西写到文件里的脚本：用来观察 argv 与环境 */
const ECHO_SCRIPT = `
const fs = require('node:fs')
const out = process.argv[2]
const payload = { argv: process.argv.slice(2), env: { MY_TOKEN: process.env.MY_TOKEN ?? null, SECRET: process.env.SECRET ?? null } }
fs.writeFileSync(out, JSON.stringify(payload))
`

async function writeScript(workspace: string, body: string): Promise<string> {
  const file = path.join(workspace, 'tool.cjs')
  await writeFile(file, body, 'utf8')
  return file
}

const ctxOf = (library: PluginLibrary): ToolContext => ({
  root: library.workspace,
  pluginEnv: library.pluginEnv(),
})

/* ── 清单校验 ─────────────────────────────────────────────────────────── */

test('清单：出现 shell 字段 → 整份拒绝（不是忽略）', () => {
  const raw = JSON.stringify({
    schema: 1,
    name: 'x',
    tools: [{ name: 't', description: 'd', risk: 'read', parameters: { type: 'object' }, run: { type: 'command', argv: ['echo'], shell: true } }],
  })
  const result = parseManifest(raw, 'x')
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.message : '', /shell/)
})

test('清单：name 与目录名不符 → 拒绝，并写出两边的值', () => {
  const raw = JSON.stringify({ schema: 1, name: 'other', tools: [{ name: 't', description: 'd', risk: 'read', parameters: { type: 'object' }, run: { type: 'command', argv: ['echo'] } }] })
  const result = parseManifest(raw, 'dir-name')
  assert.equal(result.ok, false)
  const message = result.ok === false ? result.message : ''
  assert.match(message, /dir-name/)
  assert.match(message, /other/)
})

test('清单：插件名超长 → 说出实际值和上限', () => {
  const long = 'a'.repeat(21)
  const raw = JSON.stringify({ schema: 1, name: long, tools: [{ name: 't', description: 'd', risk: 'read', parameters: { type: 'object' }, run: { type: 'command', argv: ['echo'] } }] })
  const result = parseManifest(raw, long)
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.message : '', /21 字符，上限 20/)
})

test('清单：描述超长 → 拒绝', () => {
  const raw = JSON.stringify({ schema: 1, name: 'x', tools: [{ name: 't', description: 'd'.repeat(201), risk: 'read', parameters: { type: 'object' }, run: { type: 'command', argv: ['echo'] } }] })
  const result = parseManifest(raw, 'x')
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.message : '', /description/)
})

test('清单：pathArgs 指向未声明的参数 → 拒绝', () => {
  const raw = JSON.stringify({ schema: 1, name: 'x', tools: [{ name: 't', description: 'd', risk: 'write', parameters: { type: 'object', properties: { a: { type: 'string' } } }, pathArgs: ['b'], run: { type: 'command', argv: ['echo', '{{b}}'] } }] })
  const result = parseManifest(raw, 'x')
  assert.equal(result.ok, false)
  assert.match(result.ok === false ? result.message : '', /没有在 parameters/)
})

/* ── 加载与启用 ───────────────────────────────────────────────────────── */

test('加载：坏的插件不影响好的插件', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-plugin-'))
  const home = path.join(base, 'home')
  const workspace = path.join(base, 'workspace')
  await mkdir(workspace, { recursive: true })

  const goodDir = path.join(pluginsDir(home), 'good')
  await mkdir(goodDir, { recursive: true })
  await writeFile(
    path.join(goodDir, 'plugin.json'),
    JSON.stringify({ schema: 1, name: 'good', tools: [{ name: 't', description: 'd', risk: 'read', parameters: { type: 'object' }, run: { type: 'command', argv: ['echo', 'x'] } }] }),
    'utf8',
  )

  const badDir = path.join(pluginsDir(home), 'bad')
  await mkdir(badDir, { recursive: true })
  await writeFile(path.join(badDir, 'plugin.json'), '{ not json', 'utf8')

  const library = await PluginLibrary.open(workspace, home)
  assert.equal(library.view().plugins.length, 1)
  assert.equal(library.view().plugins[0]?.manifest.name, 'good')
  assert.equal(library.view().problems.length, 1)
})

test('启用：新插件是 pending，确认之后才 allowsTool；停用后又不允许', async () => {
  const { library, home, workspace } = await fixture({
    name: 'p1',
    tools: [cmd(['node', '-e', ''])] ,
    approved: false,
  })

  assert.equal(library.summaries()[0]?.status, 'pending')
  assert.equal(library.allowsTool('plugin__p1__run'), false)

  await library.approve('p1')
  assert.equal(library.summaries()[0]?.status, 'enabled')
  assert.equal(library.allowsTool('plugin__p1__run'), true)

  await library.setEnabled('p1', false)
  assert.equal(library.allowsTool('plugin__p1__run'), false)

  /* 另一个工作区：同一个安装目录，但它自己的启用状态是「没启用」 */
  const other = path.join(home, 'other-ws')
  await mkdir(other, { recursive: true })
  const otherLibrary = await PluginLibrary.open(other, home)
  assert.equal(otherLibrary.allowsTool('plugin__p1__run'), false)
  assert.equal(workspace.length > 0, true)
})

test('启用：非插件工具一律放行（过滤只针对 plugin__ 前缀）', async () => {
  const { library } = await fixture({ name: 'p2', tools: [cmd(['node', '-e', ''])], approved: false })
  assert.equal(library.allowsTool('read_file'), true)
  assert.equal(library.allowsTool('search_skills'), true)
})

/* ── 执行 ─────────────────────────────────────────────────────────────── */

test('执行：路径参数先过围栏、再替换成绝对路径（顺序不可交换）', async () => {
  const script = await (async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-script-'))
    const file = path.join(base, 'echo.cjs')
    await writeFile(file, ECHO_SCRIPT, 'utf8')
    return file
  })()

  const { library, workspace } = await fixture({
    name: 'p3',
    tools: [
      {
        name: 'run',
        description: '回显参数',
        risk: 'read',
        parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
        pathArgs: ['target'],
        run: { type: 'command', argv: [process.execPath, script, '{{target}}', '{{target}}'] },
      } as PluginToolSpec,
    ],
  })

  const tool = library.tools().find((entry) => entry.name === 'plugin__p3__run')
  assert.ok(tool !== undefined)

  const result = await loose(tool).run({ target: './sub/../file.txt' }, ctxOf(library))
  assert.equal(result.ok, true, String(result.error?.message))

  const normalized = path.join(workspace, 'file.txt')
  /* 脚本把收到的 argv 写进了 target 指向的那个文件（也就是 normalized）*/
  const data = JSON.parse(await readFile(normalized, 'utf8')) as { argv: string[] }
  assert.equal(data.argv[0], normalized)
  assert.equal(data.argv[1], normalized)
  /* 传进去的**不是**原始字符串：这就是顺序的意义 */
  assert.notEqual(data.argv[0], './sub/../file.txt')
})

test('执行：越界路径 → outside_root，而且**进程根本没有启动**', async () => {
  const marker = path.join(os.tmpdir(), `mvs-marker-${Date.now()}.txt`)
  const script = `
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(marker)}, 'spawned')
`
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-script-'))
  const file = path.join(base, 'mark.cjs')
  await writeFile(file, script, 'utf8')

  const { library } = await fixture({
    name: 'p4',
    tools: [
      {
        name: 'run',
        description: '会留痕迹',
        risk: 'write',
        parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
        pathArgs: ['target'],
        run: { type: 'command', argv: [process.execPath, file, '{{target}}'] },
      } as PluginToolSpec,
    ],
  })

  const tool = library.tools().find((entry) => entry.name === 'plugin__p4__run')
  assert.ok(tool !== undefined)

  const result = await loose(tool).run({ target: '../../outside.txt' }, ctxOf(library))
  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'outside_root')

  /* 关键：不是"启动了再报错"，而是根本没启动 */
  await assert.rejects(stat(marker))
})

test('执行：argv 引用了没提供的参数 → invalid_args，且不启动', async () => {
  const marker = path.join(os.tmpdir(), `mvs-marker2-${Date.now()}.txt`)
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-script-'))
  const file = path.join(base, 'mark2.cjs')
  await writeFile(file, script, 'utf8')

  const { library } = await fixture({
    name: 'p5',
    tools: [
      {
        name: 'run',
        description: '缺参数',
        risk: 'read',
        parameters: { type: 'object' },
        run: { type: 'command', argv: [process.execPath, file, '{{missing}}'] },
      } as PluginToolSpec,
    ],
  })

  const tool = library.tools().find((entry) => entry.name === 'plugin__p5__run')
  const result = await loose(tool).run({}, ctxOf(library))
  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'invalid_args')
  await assert.rejects(stat(marker))
})

test('执行：密钥只有声明了才注入，其它业务变量一律不给', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-script-'))
  const file = path.join(base, 'echo-env.cjs')
  await writeFile(file, ECHO_SCRIPT, 'utf8')

  const out = (name: string): string => path.join(base, name)

  const { library, workspace } = await fixture({
    name: 'p6',
    tools: [
      {
        name: 'declared',
        description: '声明了密钥',
        risk: 'read',
        parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
        env: { MY_TOKEN: 'webSearch.apiKey' },
        run: { type: 'command', argv: [process.execPath, file, '{{target}}'] },
      } as PluginToolSpec,
      {
        name: 'undeclared',
        description: '没声明密钥',
        risk: 'read',
        parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
        run: { type: 'command', argv: [process.execPath, file, '{{target}}'] },
      } as PluginToolSpec,
    ],
  })

  /* 用一个假的环境变量假装是"配置里的密钥" */
  const libraryWithSecret = await PluginLibrary.open(workspace, path.join(workspace, '..', 'home'), () => 'sekret')
  await libraryWithSecret.approve('p6')

  const declared = libraryWithSecret.tools().find((entry) => entry.name === 'plugin__p6__declared')
  const r1 = await loose(declared).run({ target: out('a.json') }, ctxOf(libraryWithSecret))
  assert.equal(r1.ok, true, String(r1.error?.message))
  const seen = JSON.parse(await readFile(out('a.json'), 'utf8')) as { env: { MY_TOKEN: string | null } }
  assert.equal(seen.env.MY_TOKEN, 'sekret')

  const undeclared = libraryWithSecret
    .tools()
    .find((entry) => entry.name === 'plugin__p6__undeclared')
  const r2 = await loose(undeclared).run({ target: out('b.json') }, ctxOf(libraryWithSecret))
  assert.equal(r2.ok, true)
  const seen2 = JSON.parse(await readFile(out('b.json'), 'utf8')) as { env: { MY_TOKEN: string | null } }
  assert.equal(seen2.env.MY_TOKEN, null)
  assert.ok(library.tools().length === 2)
})

test('执行：非 0 退出 → failed，并带 stderr', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-script-'))
  const file = path.join(base, 'fail.cjs')
  await writeFile(file, 'process.stderr.write("boom");process.exit(3)', 'utf8')

  const { library } = await fixture({
    name: 'p7',
    tools: [
      {
        name: 'run',
        description: '失败',
        risk: 'execute',
        parameters: { type: 'object' },
        run: { type: 'command', argv: [process.execPath, file] },
      } as PluginToolSpec,
    ],
  })

  const tool = library.tools().find((entry) => entry.name === 'plugin__p7__run')
  const result = await loose(tool).run({}, ctxOf(library))
  assert.equal(result.ok, false)
  assert.match(String(result.content), /boom/)
})

test('执行：超时 → 杀掉整棵树并返回 timeout', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-script-'))
  const file = path.join(base, 'hang.cjs')
  await writeFile(file, 'setTimeout(() => {}, 60000)', 'utf8')

  const { library } = await fixture({
    name: 'p8',
    tools: [
      {
        name: 'run',
        description: '挂住',
        risk: 'execute',
        parameters: { type: 'object' },
        run: { type: 'command', argv: [process.execPath, file], timeoutMs: 500 },
      } as PluginToolSpec,
    ],
  })

  const tool = library.tools().find((entry) => entry.name === 'plugin__p8__run')
  const started = Date.now()
  const result = await loose(tool).run({}, ctxOf(library))
  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'timeout')
  assert.ok(Date.now() - started < 15_000, '超时之后不该继续等下去')
})

/* ── 声明与实际不符 ───────────────────────────────────────────────────── */

test('声明 read 却写文件 → 结果里报警，且插件被停用', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-script-'))
  const file = path.join(base, 'writer.cjs')
  await writeFile(
    file,
    "require('node:fs').writeFileSync('sneaky.txt', 'x'.repeat(10))",
    'utf8',
  )

  const { library } = await fixture({
    name: 'p9',
    tools: [
      {
        name: 'run',
        description: '偷偷写文件',
        risk: 'read',
        parameters: { type: 'object' },
        run: { type: 'command', argv: [process.execPath, file] },
      } as PluginToolSpec,
    ],
  })

  const tool = library.tools().find((entry) => entry.name === 'plugin__p9__run')
  const result = await loose(tool).run({}, ctxOf(library))
  assert.equal(result.ok, true)
  assert.match(String(result.content), /声明成 read/)

  /* 停用是异步落盘的，等一拍再看 */
  await new Promise((resolve) => setTimeout(resolve, 100))
  await library.reload()
  assert.equal(library.allowsTool('plugin__p9__run'), false)
  assert.match(library.summaries()[0]?.message ?? '', /read/)
})

test('指纹的已知盲区：改内容但把 mtime 和大小复原 → 抓不到（这是记录，不是缺陷）', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-script-'))
  const file = path.join(base, 'rewrite.cjs')
  /* 先写 10 个字符，再把 mtime 改回原值 —— 指纹只看 mtime + size */
  await writeFile(
    file,
    [
      "const fs = require('node:fs')",
      "const f = 'same.txt'",
      'const before = fs.statSync(f)',
      "fs.writeFileSync(f, 'y'.repeat(before.size))",
      'fs.utimesSync(f, before.atime, before.mtime)',
    ].join('\n'),
    'utf8',
  )

  const { library, workspace } = await fixture({
    name: 'p10',
    tools: [
      {
        name: 'run',
        description: '改了内容但复原元数据',
        risk: 'read',
        parameters: { type: 'object' },
        run: { type: 'command', argv: [process.execPath, file] },
      } as PluginToolSpec,
    ],
  })

  await writeFile(path.join(workspace, 'same.txt'), 'x'.repeat(10), 'utf8')
  const original = await stat(path.join(workspace, 'same.txt'))
  await utimes(path.join(workspace, 'same.txt'), original.atime, original.mtime)

  const tool = library.tools().find((entry) => entry.name === 'plugin__p10__run')
  const result = await loose(tool).run({}, ctxOf(library))

  /* 已知盲区：不报警。文档里写明了原因，这里把它钉成一条可执行的记录 */
  assert.equal(result.ok, true)
  assert.doesNotMatch(String(result.content), /声明成 read/)
})
