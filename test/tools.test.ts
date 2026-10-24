/**
 * 工具层测试。
 *
 * 所有文件操作都发生在 test/ 下的临时工作区里，用完即删 ——
 * 不碰仓库里任何真实文件。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDefaultRegistry } from '../src/tools/index.ts'
import { resolveInsideRoot } from '../src/tools/paths.ts'
import { validate } from '../src/tools/schema.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import { failResult, type AnyTool, type ToolContext } from '../src/tools/types.ts'
import os from 'node:os'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const registry = createDefaultRegistry()

/** 每个用例一个独立临时工作区，用完删除 */
async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    await fn(root)
  } finally {
    // maxRetries：Windows 上刚被杀掉的子进程可能短暂占着目录（EBUSY）
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

function ctx(root: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { root, ...extra }
}

// ---------------------------------------------------------------------------
// 路径围栏
// ---------------------------------------------------------------------------

test('路径围栏：拒绝文本逃逸与绝对路径越界', async () => {
  await withWorkspace(async (root) => {
    const rejected = [
      '../outside.txt',
      'a/../../outside.txt',
      '..',
      path.join(root, '..', 'x.txt'),
      path.parse(root).root,
      '',
      '   ',
    ]
    for (const bad of rejected) {
      const result = resolveInsideRoot(root, bad)
      assert.equal(result.ok, false, `${JSON.stringify(bad)} 应该被拒绝`)
    }

    for (const good of ['a.txt', 'a/b/c.txt', path.join(root, 'x.txt'), './y.txt']) {
      const result = resolveInsideRoot(root, good)
      assert.equal(result.ok, true, `${good} 应该被接受`)
    }
  })
})

test('路径围栏：拒绝符号链接逃逸', async (t) => {
  await withWorkspace(async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
    try {
      const linkPath = path.join(root, 'link')
      try {
        await symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        t.skip('本机无法创建符号链接（Windows 需要管理员权限或开发者模式）')
        return
      }

      // 软链本身在工作区内，但它指向外部 —— 字符串前缀检查抓不到这种逃逸
      const result = resolveInsideRoot(root, 'link/escape.txt')
      assert.equal(result.ok, false, '经符号链接的逃逸没有被拦住')
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// schema 校验
// ---------------------------------------------------------------------------

test('参数校验：必填、类型、枚举、多余字段、数组元素', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      count: { type: 'integer', minimum: 1 },
      mode: { type: 'string', enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['name'],
    additionalProperties: false,
  }

  assert.equal(validate(schema, { name: 'x' }).ok, true)
  assert.equal(validate(schema, {}).ok, false, '缺必填字段')
  assert.equal(validate(schema, { name: '' }).ok, false, '违反 minLength')
  assert.equal(validate(schema, { name: 'x', count: 1.5 }).ok, false, '整数位置给了小数')
  assert.equal(validate(schema, { name: 'x', count: 0 }).ok, false, '低于 minimum')
  assert.equal(validate(schema, { name: 'x', mode: 'c' }).ok, false, '不在枚举内')
  assert.equal(validate(schema, { name: 'x', extra: 1 }).ok, false, 'additionalProperties=false')
  assert.equal(validate(schema, { name: 'x', tags: ['a', 1] }).ok, false, '数组元素类型不符')
  assert.equal(validate(schema, { name: 'x', tags: ['a', 'b'] }).ok, true)
  assert.equal(validate(schema, 'not-an-object').ok, false)
})

// ---------------------------------------------------------------------------
// 注册表边界
// ---------------------------------------------------------------------------

test('注册表：未知工具、坏参数、抛异常都收敛成结果', async () => {
  await withWorkspace(async (root) => {
    const unknown = await registry.execute('nope', {}, ctx(root))
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error?.kind, 'unknown_tool')

    const badArgs = await registry.execute('read_file', { path: 123 }, ctx(root))
    assert.equal(badArgs.ok, false)
    assert.equal(badArgs.error?.kind, 'invalid_args')

    const badJson = await registry.execute('read_file', '{不是 JSON', ctx(root))
    assert.equal(badJson.ok, false)
    assert.equal(badJson.error?.kind, 'invalid_args')

    // 工具内部直接 throw，也不该穿透到调用方
    const exploding: AnyTool = {
      name: 'explode',
      description: '测试用',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      risk: 'read',
      async run() {
        throw new Error('炸了')
      },
    }
    const local = new ToolRegistry().register(exploding)
    const result = await local.execute('explode', {}, ctx(root))
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'failed')
    assert.match(result.error?.message ?? '', /炸了/)
  })
})

test('注册表：重名工具直接报错', () => {
  const local = new ToolRegistry()
  const tool: AnyTool = {
    name: 'dup',
    description: '',
    parameters: {},
    risk: 'read',
    async run() {
      return failResult('failed', 'never')
    },
  }
  local.register(tool)
  assert.throws(() => local.register(tool), /工具重名/)
})

test('注册表：JSON 字符串形式的参数也能执行', async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, 'a.txt'), '内容', 'utf8')
    const result = await registry.execute('read_file', '{"path":"a.txt"}', ctx(root))
    assert.equal(result.ok, true, result.error?.message)
    assert.equal(result.content, '内容')
  })
})

test('注册表：调用前已取消则直接返回 aborted', async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController()
    controller.abort()
    const result = await registry.execute('read_file', { path: 'a.txt' }, ctx(root, { signal: controller.signal }))
    assert.equal(result.error?.kind, 'aborted')
  })
})

test('注册表：toModelSchemas 能生成模型用的声明', () => {
  const schemas = registry.toModelSchemas()
  assert.deepEqual(
    schemas.map((s) => s.name).sort(),
    [
      'create_file',
      'delete_file',
      /*
       * ★ `edit` / `glob` / `grep` —— 这三个是「能不能在代码库里干活」的分界线。
       *
       * 原来的集合能读、写、建、删、跑命令，但**找不到东西、也不能只改一处**：
       * 没有搜索的 agent 只能去 run_command 里跑 findstr / rg，而那要求
       * 命令行在、语法对、输出可读、路径转义对 —— 任一条不成立它就卡住，
       * 而且**不会说「我不会搜」**，它会编一个像答案的东西。
       *
       * 这条断言就是钉住那份能力清单：以后有人误删了它们，这里会红。
       */
      'edit',
      'glob',
      'grep',
      'job_output',
      'kill_job',
      'list_jobs',
      'read_file',
      'run_command',
      /*
       * ★ `spawn_agent` —— 唯一的「会再开一个 agent」的工具。
       *
       * 标成 `execute` 而不是 `read`：它能读到、改到、跑到任何东西，
       * 按**可能的最坏后果**标。钉在这里是为了钉住这个判断 ——
       * 以后有人把它降成 `read`（"只是个委派嘛"），
       * `workspace-write` 下就不会再为它要那一次确认了。
       */
      /*
       * `search_skills` / `use_skill` —— 技能系统的两个工具。
       *
       * 都是 `read`：不执行、不出网、不写文件，唯一影响是往上下文里加文本。
       * 钉在这里是为了钉住两件事：
       *   1. 它们必须在工具表里（少了这两条，模型永远查不到技能，
       *      而系统提示仍然会说「用 search_skills 查」）
       *   2. 它们不能被降级成需要确认（查询技能要人点确认是没必要的摩擦，
       *      而且会训练用户闭眼点）
       *
       * 注意这里按**名字排序**（断言用的是 sort 之后的结果）：
       * search_skills < spawn_agent < use_skill。
       */
      'search_skills',
      'spawn_agent',
      'use_skill',
      /*
       * ★ `web_fetch` / `web_search` —— **这个集合里唯一会离开这台机器的两个**。
       *
       * 所以它们单独一档 `risk: 'network'`，而不是并进 `read`：
       *   · 本地读文件最坏是"模型看到了本机内容"
       *   · 网络请求有三个本机操作没有的性质：**对外**（请求本身就是泄露）、
       *     **响应不受信任**（网页是最典型的提示注入载体）、**不可撤销**
       *
       * 钉在这里是因为：以后有人把它们并进 `read` 档，策略层就再也没法
       * 单独对网络设限了 —— 而那正好是"拿去跑远端 API"这个场景最需要的旋钮。
       */
      'web_fetch',
      'web_search',
      'write_file',
    ],
  )
  for (const schema of schemas) {
    assert.equal(typeof schema.description, 'string')
    assert.equal(schema.parameters.type, 'object')
  }
})

// ---------------------------------------------------------------------------
// 文件工具
// ---------------------------------------------------------------------------

test('write_file 建立父目录；read_file 原样读回', async () => {
  await withWorkspace(async (root) => {
    const written = await registry.execute(
      'write_file',
      { path: '深/层/目录/a.txt', content: '第一行\n第二行\n第三行' },
      ctx(root),
    )
    assert.equal(written.ok, true, written.error?.message)
    assert.equal((written.data as { created: boolean }).created, true)

    const read = await registry.execute('read_file', { path: '深/层/目录/a.txt' }, ctx(root))
    assert.equal(read.content, '第一行\n第二行\n第三行')
    assert.equal((read.data as { totalLines: number }).totalLines, 3)

    // 再写一次应该报告「覆盖」而不是「创建」
    const again = await registry.execute('write_file', { path: '深/层/目录/a.txt', content: 'x' }, ctx(root))
    assert.equal((again.data as { created: boolean }).created, false)
  })
})

test('read_file 支持 offset / limit 按行切片', async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, 'lines.txt'), 'l1\nl2\nl3\nl4\nl5', 'utf8')

    const slice = await registry.execute('read_file', { path: 'lines.txt', offset: 2, limit: 2 }, ctx(root))
    assert.equal(slice.content, 'l2\nl3')

    const tail = await registry.execute('read_file', { path: 'lines.txt', offset: 4 }, ctx(root))
    assert.equal(tail.content, 'l4\nl5')
  })
})

test('read_file 超出输出上限时截断并标注', async () => {
  await withWorkspace(async (root) => {
    await writeFile(path.join(root, 'big.txt'), 'a'.repeat(500), 'utf8')
    const result = await registry.execute('read_file', { path: 'big.txt' }, ctx(root, { maxOutputChars: 50 }))
    assert.match(result.content, /输出已截断/)
    assert.equal((result.data as { truncated: boolean }).truncated, true)
  })
})

test('create_file 已存在时拒绝，不覆盖', async () => {
  await withWorkspace(async (root) => {
    const first = await registry.execute('create_file', { path: 'n.txt', content: '原始' }, ctx(root))
    assert.equal(first.ok, true, first.error?.message)

    const second = await registry.execute('create_file', { path: 'n.txt', content: '篡改' }, ctx(root))
    assert.equal(second.ok, false)
    assert.equal(second.error?.kind, 'already_exists')

    // 关键：内容必须没被改动
    assert.equal(await readFile(path.join(root, 'n.txt'), 'utf8'), '原始')
  })
})

test('delete_file：目录必须显式 recursive', async () => {
  await withWorkspace(async (root) => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(root, 'dir'), { recursive: true })
    await writeFile(path.join(root, 'dir/inner.txt'), 'x', 'utf8')
    await writeFile(path.join(root, 'f.txt'), 'x', 'utf8')

    const refused = await registry.execute('delete_file', { path: 'dir' }, ctx(root))
    assert.equal(refused.ok, false)
    assert.equal(refused.error?.kind, 'is_a_directory')
    assert.equal(existsSync(path.join(root, 'dir')), true, '被拒绝时不该真的删掉')

    const removed = await registry.execute('delete_file', { path: 'dir', recursive: true }, ctx(root))
    assert.equal(removed.ok, true, removed.error?.message)
    assert.equal(existsSync(path.join(root, 'dir')), false)

    const file = await registry.execute('delete_file', { path: 'f.txt' }, ctx(root))
    assert.equal(file.ok, true)

    const missing = await registry.execute('delete_file', { path: 'f.txt' }, ctx(root))
    assert.equal(missing.error?.kind, 'not_found')
  })
})

test('文件工具拒绝越界路径', async () => {
  await withWorkspace(async (root) => {
    const attempts = [
      ['read_file', { path: '../outside.txt' }],
      ['write_file', { path: '../outside.txt', content: 'x' }],
      ['create_file', { path: '../outside.txt' }],
      ['delete_file', { path: '../outside.txt' }],
    ] as const

    for (const [name, args] of attempts) {
      const result = await registry.execute(name, args, ctx(root))
      assert.equal(result.ok, false, `${name} 应该被拒绝`)
      assert.equal(result.error?.kind, 'outside_root', `${name} 的错误类型不对`)
    }
  })
})

// ---------------------------------------------------------------------------
// 命令工具
// ---------------------------------------------------------------------------

test('run_command：直接启动可执行文件（不经 shell）', async () => {
  await withWorkspace(async (root) => {
    const result = await registry.execute(
      'run_command',
      { command: process.execPath, args: ['-v'] },
      ctx(root),
    )
    assert.equal(result.ok, true, result.error?.message)
    const data = result.data as { viaShell: boolean; exitCode: number; stdout: string }
    assert.match(data.stdout.trim(), /^v\d+\./)
    assert.equal(data.viaShell, false)
    assert.equal(data.exitCode, 0)
  })
})

test('run_command：只给 command 时走 shell', async () => {
  await withWorkspace(async (root) => {
    const result = await registry.execute('run_command', { command: 'echo hello-shell' }, ctx(root))
    assert.equal(result.ok, true, result.error?.message)
    assert.match(result.content, /hello-shell/)
    assert.equal((result.data as { viaShell: boolean }).viaShell, true)
  })
})

test('run_command：非 0 退出码是 failed，但仍带回完整输出', async () => {
  await withWorkspace(async (root) => {
    const result = await registry.execute(
      'run_command',
      {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("out");process.stderr.write("err");process.exit(3)'],
      },
      ctx(root),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'failed')
    assert.match(result.error?.message ?? '', /退出码 3/)
    // 输出不能因为失败就丢掉
    assert.match(result.content, /out/)
    assert.match(result.content, /err/)
    assert.equal((result.data as { exitCode: number }).exitCode, 3)
  })
})

test('run_command：超时会被强制终止', async () => {
  await withWorkspace(async (root) => {
    const started = Date.now()
    const result = await registry.execute(
      'run_command',
      { command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'], timeoutMs: 400 },
      ctx(root),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'timeout')
    assert.ok(Date.now() - started < 8000, '应该在超时后很快返回，而不是等命令自己结束')
  })
})

test('run_command：外部取消 → aborted', async () => {
  await withWorkspace(async (root) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 150)
    const result = await registry.execute(
      'run_command',
      { command: process.execPath, args: ['-e', 'setTimeout(()=>{},10000)'] },
      ctx(root, { signal: controller.signal }),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'aborted')
  })
})

/** 进程是否还活着。信号 0 不做任何事，只做存在性检查。 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * ★ 超时必须连**整棵进程树**一起杀。
 *
 * 这一条不是「顺手加个保险」，它管的是恢复层的**归属边界**。
 *
 * 快照边界是「动作前 → 动作后」这个时间窗。如果只杀直接子进程，它派出去的
 * 孙进程会活下来继续写文件 —— 那些写入在 after 快照之后，于是既不属于本次
 * 事务的 diff，又会被算进**下一个**事务。用户按「撤销上一步」，动到的却是
 * 下一步留下的痕迹：撤的是第 3 步，删掉的可能是第 4 步刚建的文件。
 *
 * ⚠️ **测试写法有讲究，不能随便简化。**
 *
 * 本环境的沙箱把命令的整个父子链放在同一个 Job Object 里，所以「只杀父进程」
 * 也会连带把普通孙进程一起收掉 —— 那样的测试**两种实现都能通过，等于没测**。
 * （这一点是实测出来的：先写成普通孙进程，结果故意退回单杀实现时测试照样绿。）
 *
 * 所以这里的孙进程必须**脱离**父进程的进程组（`detached: true` + `unref()`），
 * 模拟真实场景里那些会自己跑掉的后台进程。只有这样，单杀直接子进程才会漏，
 * 而 `taskkill /T`（Windows）/ `kill(-pid)`（POSIX）才显得出区别。
 */
test('★ run_command 超时会连脱离进程组的孙进程一起杀（恢复层归属边界）', async () => {
  await withWorkspace(async (root) => {
    // 父进程：派出一个**脱离进程组**的长命孙进程、把它的 pid 落盘，然后自己也不退出。
    await writeFile(
      path.join(root, 'spawner.mjs'),
      [
        "import { spawn } from 'node:child_process'",
        "import { writeFileSync } from 'node:fs'",
        "const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {",
        "  stdio: 'ignore',",
        '  detached: true,',
        '})',
        'child.unref()',
        "writeFileSync('gc.pid', String(child.pid))",
        'setInterval(() => {}, 1000)',
      ].join('\n'),
      'utf8',
    )

    const result = await registry.execute(
      'run_command',
      { command: process.execPath, args: ['spawner.mjs'], timeoutMs: 900 },
      ctx(root),
    )
    assert.equal(result.error?.kind, 'timeout', `应当是超时：${result.content}`)

    const gcPid = Number(await readFile(path.join(root, 'gc.pid'), 'utf8'))
    assert.ok(Number.isInteger(gcPid) && gcPid > 0, '孙进程应该真的起来了')

    try {
      // 先确认探针本身有效 —— 否则「死了」和「探针坏了」看起来一模一样
      assert.equal(alive(process.pid), true, '探针本身要能报告「活着」')

      // 杀树是异步生效的，给它一点时间被回收
      for (let i = 0; i < 40; i += 1) {
        if (!alive(gcPid)) break
        await new Promise((resolve) => setTimeout(resolve, 50))
      }

      assert.equal(
        alive(gcPid),
        false,
        `孙进程 ${gcPid} 还活着 —— 它会在 after 快照之后继续写文件，把改动算进下一个事务`,
      )
    } finally {
      // ⚠️ 不论成败都要把它收掉。
      //
      // 失败时它还活着，而它占着临时工作目录 —— 清理时的 `rm` 会报 EBUSY，
      // 那个错误会**盖掉前面真正的断言失败**，让人以为是文件系统的问题。
      // 一条测试的失败信息说错原因，比没有测试更浪费时间。
      if (gcPid > 0 && alive(gcPid)) {
        try {
          process.kill(gcPid, 'SIGKILL')
        } catch {
          // 刚好自己退出了
        }
      }
    }
  })
})

test('run_command：找不到可执行文件 → not_found', async () => {
  await withWorkspace(async (root) => {
    const result = await registry.execute(
      'run_command',
      { command: 'mvs-definitely-not-a-real-binary-xyz', args: [] },
      ctx(root),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'not_found')
  })
})

test('run_command：cwd 受路径围栏约束', async () => {
  await withWorkspace(async (root) => {
    const result = await registry.execute(
      'run_command',
      { command: 'echo', args: [], cwd: '../..' },
      ctx(root),
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'outside_root')
  })
})

test('run_command：cwd 有效时命令在指定目录里执行', async () => {
  await withWorkspace(async (root) => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(path.join(root, 'sub'), { recursive: true })
    const result = await registry.execute(
      'run_command',
      { command: process.execPath, args: ['-e', 'process.stdout.write(process.cwd())'], cwd: 'sub' },
      ctx(root),
    )
    assert.equal(result.ok, true, result.error?.message)
    assert.match(result.content, /sub/)
  })
})

// ---------------------------------------------------------------------------
// 结构守卫
// ---------------------------------------------------------------------------

/**
 * ⚠️ **这个测试的名字以前叫「模型侧没有接上任何一层」，那是错的。**
 *
 * 它实际保证的是一件窄得多的事：**CLI 对话 REPL（`src/cli/chat.ts`）保持无能力。**
 * 也就是说，那个只连模型的裸 REPL 不会顺手把工具、恢复、权限或运行时拽进来 ——
 * 它是「模型层可以单独跑、单独测」这个性质的守卫。
 *
 * 「模型拿不到能力」早就不成立了：`src/host/` 和 `src/protocol/` 整个目录都在
 * 白名单里，工具循环就在那儿跑通了。名字叫得比实际强，会让人误以为整个内核
 * 还没接上 —— 然后去「接上」一个早就接好的东西。
 */
test('结构守卫：CLI 对话 REPL 保持无能力（不引用工具/恢复/权限/运行时）', async () => {
  const chatSource = await readFile(path.join(projectRoot, 'src', 'cli', 'chat.ts'), 'utf8')
  for (const layer of ['tools', 'recovery', 'policy', 'host', 'protocol']) {
    assert.equal(
      new RegExp(`from '\\.\\./${layer}`).test(chatSource),
      false,
      `chat.ts 不应引用 ${layer} 层 —— 这个裸 REPL 要能单独跑、单独测`,
    )
  }

  const files = (await readdir(path.join(projectRoot, 'src'), { recursive: true }))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(projectRoot, 'src', f))

  // 只有「人工调用入口」与「host 侧组装点」可以装配这几层。
  // host/ 与 protocol/ 整个目录都在白名单里：它们存在的意义就是这个。
  const allowed = new Set([
    path.join(projectRoot, 'src', 'tools', 'index.ts'),
    path.join(projectRoot, 'src', 'cli', 'tool.ts'),
    path.join(projectRoot, 'src', 'cli', 'recovery.ts'),
    path.join(projectRoot, 'src', 'cli', 'policy.ts'),
    path.join(projectRoot, 'src', 'cli', 'serve.ts'),
  ])
  const allowedPrefixes = [
    path.join(projectRoot, 'src', 'recovery') + path.sep,
    path.join(projectRoot, 'src', 'policy') + path.sep,
    path.join(projectRoot, 'src', 'host') + path.sep,
    path.join(projectRoot, 'src', 'protocol') + path.sep,
  ]

  const offenders: string[] = []
  for (const file of files) {
    if (allowed.has(file)) continue
    if (allowedPrefixes.some((prefix) => file.startsWith(prefix))) continue
    const text = await readFile(file, 'utf8')
    if (
      text.includes('createDefaultRegistry') ||
      text.includes('createRecovery') ||
      text.includes('new Policy(') ||
      text.includes('new Session(') ||
      text.includes('new HostServer(')
    ) {
      offenders.push(file)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    '只有人工调用入口与 host 侧组装点可以装配这几层；CLI 对话 REPL（chat.ts）必须保持干净',
  )
})
