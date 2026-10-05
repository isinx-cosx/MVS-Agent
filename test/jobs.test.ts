/**
 * 后台作业的测试。
 *
 * 这一组里最重要的**不是**「后台命令能跑起来」，而是**它在恢复层上的缺口被如实
 * 处理了**。后台进程在快照边界之后持续写文件，那些写入的归属无法确定 ——
 * 如果此时还提交事务，下一个工具调用的事务会把后台刚生成的产物算成「自己新增的」，
 * 于是撤销那一步会**删掉后台的产物**（copilot-cli#1675 就是这一类：
 * 回滚函数执行 `git clean -fd`，删掉了约 1GB agent 只「读过」的未跟踪产物）。
 *
 * 所以下面有一半用例是在验证「**宁可不给撤销**」这条边界。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { JobRegistry } from '../src/tools/jobs.ts'
import { jobOutputTool, killJobTool, listJobsTool } from '../src/tools/job-tools.ts'
import { runCommandTool } from '../src/tools/command-tool.ts'
import { Policy } from '../src/policy/index.ts'
import type { ToolContext } from '../src/tools/types.ts'
import os from 'node:os'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

async function withJobDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    await fn(base)
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i += 1) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !alive(pid)
}

/** 一个会一直跑、并且往 stdout 写东西的小程序 */
const CHATTY = "let n=0; setInterval(()=>{ console.log('tick-'+(++n)) }, 80)"

// ---------------------------------------------------------------------------
// 注册表本身
// ---------------------------------------------------------------------------

test('后台作业：起得来、能列出、能读到输出', async () => {
  await withJobDir(async (dir) => {
    const jobs = new JobRegistry(path.join(dir, 'jobs'))
    try {
      const job = await jobs.start({
        command: 'chatty',
        file: process.execPath,
        argv: ['-e', CHATTY],
        cwd: dir,
        label: 'chatty',
      })

      assert.match(job.id, /^job-/)
      assert.equal(job.exit, null, '刚起来时应当还在跑')
      assert.equal(jobs.hasRunning(), true)
      assert.deepEqual(
        jobs.list().map((j) => j.id),
        [job.id],
      )

      // 等它写出点东西
      await new Promise((r) => setTimeout(r, 400))
      const output = await jobs.output(job.id)
      assert.ok(output !== undefined)
      assert.match(output.stdout, /tick-/, `应当有输出，实际：${JSON.stringify(output.stdout)}`)
    } finally {
      await jobs.dispose()
    }
  })
})

test('★ 停作业要连整棵进程树 —— 只杀直接子进程会留下孤儿继续写文件', async () => {
  await withJobDir(async (dir) => {
    const jobs = new JobRegistry(path.join(dir, 'jobs'))
    let gcPid = 0
    try {
      // 父进程派一个**脱离进程组**的孙进程，把它的 pid 写出来，然后自己也不退出。
      // 脱离是必需的：同组的会被 Job Object 连带收掉，那样两种实现都能通过。
      const spawner = [
        "const { spawn } = require('node:child_process')",
        "const { writeFileSync } = require('node:fs')",
        `const c = spawn(process.execPath, ['-e', ${JSON.stringify(CHATTY)}], { stdio: 'ignore', detached: true })`,
        'c.unref()',
        `writeFileSync(${JSON.stringify(path.join(dir, 'gc.pid'))}, String(c.pid))`,
        'setInterval(()=>{},1000)',
      ].join('\n')

      const scriptPath = path.join(dir, 'spawner.cjs')
      await import('node:fs/promises').then((fs) => fs.writeFile(scriptPath, spawner, 'utf8'))

      const job = await jobs.start({
        command: 'spawner',
        file: process.execPath,
        argv: [scriptPath],
        cwd: dir,
        label: 'spawner',
      })

      await new Promise((r) => setTimeout(r, 700))
      gcPid = Number(await readFile(path.join(dir, 'gc.pid'), 'utf8'))
      assert.ok(gcPid > 0, '孙进程应当真的起来了')
      assert.equal(alive(gcPid), true)

      assert.equal(jobs.kill(job.id), true)
      assert.equal(await waitGone(gcPid), true, `孙进程 ${gcPid} 还活着 —— 它仍在往工作区里写文件`)
    } finally {
      if (gcPid > 0 && alive(gcPid)) {
        try {
          process.kill(gcPid, 'SIGKILL')
        } catch {
          /* 已经死了 */
        }
      }
      await jobs.dispose()
    }
  })
})

test('★ dispose 会收掉所有还在跑的作业（守护进程退出必须带走它们）', async () => {
  await withJobDir(async (dir) => {
    const jobs = new JobRegistry(path.join(dir, 'jobs'))
    const job = await jobs.start({
      command: 'chatty',
      file: process.execPath,
      argv: ['-e', CHATTY],
      cwd: dir,
      label: 'chatty',
    })
    const pid = job.pid
    assert.ok(pid !== null)
    assert.equal(alive(pid), true)

    await jobs.dispose()

    assert.equal(
      await waitGone(pid),
      true,
      'detached 的作业不会被守护进程退出自动带走 —— 必须显式杀，否则每关一次界面就留一堆进程',
    )
  })
})

test('停一个不存在的作业返回 false，而不是假装成功', async () => {
  await withJobDir(async (dir) => {
    const jobs = new JobRegistry(path.join(dir, 'jobs'))
    assert.equal(jobs.kill('job-nope'), false)
    await jobs.dispose()
  })
})

// ---------------------------------------------------------------------------
// 工具层
// ---------------------------------------------------------------------------

test('run_command background=true 立刻返回作业 id，并带 background 标记', async () => {
  await withJobDir(async (dir) => {
    const jobs = new JobRegistry(path.join(dir, 'jobs'))
    const ctx: ToolContext = { root: dir, jobs }
    try {
      const started = Date.now()
      const result = await runCommandTool.run(
        { command: process.execPath, args: ['-e', CHATTY], background: true },
        ctx,
      )
      assert.equal(result.ok, true, result.content)
      assert.ok(
        Date.now() - started < 3000,
        '后台启动不该等命令结束（它根本不会结束）',
      )

      const data = result.data as { background: boolean; jobId: string }
      assert.equal(data.background, true)
      assert.match(data.jobId, /^job-/)
      assert.match(result.content, /不受恢复层保护/, '必须把这条限制说给模型听')
    } finally {
      await jobs.dispose()
    }
  })
})

test('没有作业注册表时明确失败，而不是静默退化成前台', async () => {
  // 静默退化成前台会让一个 dev server 把整轮对话卡到超时，而模型还以为
  // 自己只是起了一个后台任务
  await withJobDir(async (dir) => {
    const result = await runCommandTool.run(
      { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], background: true },
      { root: dir },
    )
    assert.equal(result.ok, false)
    assert.equal(result.error?.kind, 'failed')
    assert.match(result.content, /没有后台作业注册表/)
  })
})

test('list_jobs / job_output / kill_job 走完一个完整来回', async () => {
  await withJobDir(async (dir) => {
    const jobs = new JobRegistry(path.join(dir, 'jobs'))
    const ctx: ToolContext = { root: dir, jobs }
    try {
      const started = await runCommandTool.run(
        { command: process.execPath, args: ['-e', CHATTY], background: true },
        ctx,
      )
      const jobId = (started.data as { jobId: string }).jobId

      await new Promise((r) => setTimeout(r, 400))

      const listed = await listJobsTool.run({}, ctx)
      assert.equal(listed.ok, true)
      assert.match(listed.content, /运行中/)
      assert.match(listed.content, new RegExp(jobId))

      const output = await jobOutputTool.run({ jobId }, ctx)
      assert.equal(output.ok, true)
      assert.match(output.content, /tick-/)

      const killed = await killJobTool.run({ jobId }, ctx)
      assert.equal(killed.ok, true)
      assert.equal((killed.data as { killed: boolean }).killed, true)

      // 再停一次要如实说「它已经结束了」，而不是报成功
      await new Promise((r) => setTimeout(r, 300))
      const again = await killJobTool.run({ jobId }, ctx)
      assert.equal(again.ok, true)
      assert.match(again.content, /已经结束/)
      assert.equal((again.data as { killed: boolean }).killed, false)
    } finally {
      await jobs.dispose()
    }
  })
})

test('job_output / kill_job 对未知 id 明确失败', async () => {
  await withJobDir(async (dir) => {
    const jobs = new JobRegistry(path.join(dir, 'jobs'))
    const ctx: ToolContext = { root: dir, jobs }
    try {
      const out = await jobOutputTool.run({ jobId: 'job-nope' }, ctx)
      assert.equal(out.ok, false)
      assert.equal(out.error?.kind, 'not_found')

      const kill = await killJobTool.run({ jobId: 'job-nope' }, ctx)
      assert.equal(kill.ok, false)
      assert.equal(kill.error?.kind, 'not_found')
    } finally {
      await jobs.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 恢复层的缺口：这一组才是这组测试的重点
// ---------------------------------------------------------------------------

test('★ 后台启动**不产生**可撤销条目（它还没干活，事务是假的）', async () => {
  const { RecoveryGuard } = await import('../src/recovery/index.ts')
  const { createRecovery } = await import('../src/recovery/index.ts')
  const { createDefaultRegistry } = await import('../src/tools/index.ts')

  await withJobDir(async (dir) => {
    const root = path.join(dir, 'ws')
    await import('node:fs/promises').then((fs) => fs.mkdir(root, { recursive: true }))

    const recovery = createRecovery({ root })
    await recovery.init()
    const jobs = new JobRegistry(path.join(dir, 'jobs'))
    const guard = new RecoveryGuard(createDefaultRegistry(), recovery)
    const ctx: ToolContext = { root, jobs }

    try {
      const execution = await guard.execute(
        'run_command',
        { command: process.execPath, args: ['-e', CHATTY], background: true },
        ctx,
      )
      assert.equal(execution.result.ok, true)
      assert.equal(
        execution.transactionId,
        undefined,
        '后台启动不该有事务 —— after 快照此刻拍到的是「还没开始干活」',
      )
    } finally {
      await jobs.dispose()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

test('★★ 有作业在跑时，文件改动一律不产生撤销条目（归属无法确定）', async () => {
  const { RecoveryGuard, createRecovery } = await import('../src/recovery/index.ts')
  const { createDefaultRegistry } = await import('../src/tools/index.ts')

  await withJobDir(async (dir) => {
    const root = path.join(dir, 'ws')
    await import('node:fs/promises').then((fs) => fs.mkdir(root, { recursive: true }))

    const recovery = createRecovery({ root })
    await recovery.init()
    const jobs = new JobRegistry(path.join(dir, 'jobs'))
    const guard = new RecoveryGuard(createDefaultRegistry(), recovery)
    const ctx: ToolContext = { root, jobs }

    try {
      // 先确认没有作业时是**有**撤销条目的（否则这个测试是空的）
      const before = await guard.execute('write_file', { path: 'a.txt', content: '1' }, ctx)
      assert.ok(
        before.transactionId !== undefined,
        '没有作业在跑时应当正常产生事务 —— 这条不成立的话，下面的断言就没有意义',
      )

      // 起一个后台作业，再改文件
      const job = await jobs.start({
        command: 'chatty',
        file: process.execPath,
        argv: ['-e', CHATTY],
        cwd: root,
        label: 'chatty',
      })
      assert.equal(jobs.hasRunning(), true)

      const during = await guard.execute('write_file', { path: 'b.txt', content: '2' }, ctx)
      assert.equal(during.result.ok, true)
      assert.equal(
        during.transactionId,
        undefined,
        '有作业在跑时不能给撤销：下一个工具调用的事务会把后台产物算成自己新增的，' +
          '于是撤销会删掉后台的东西（copilot-cli#1675）',
      )

      // 停掉作业之后应当恢复
      jobs.kill(job.id)
      await new Promise((r) => setTimeout(r, 500))
      assert.equal(jobs.hasRunning(), false)

      const after = await guard.execute('write_file', { path: 'c.txt', content: '3' }, ctx)
      assert.ok(after.transactionId !== undefined, '作业停了之后撤销能力要恢复')
    } finally {
      await jobs.dispose()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})

// ---------------------------------------------------------------------------
// 权限：后台命令不适用只读自动放行
// ---------------------------------------------------------------------------

test('★ 后台命令即使是只读文本也不自动放行', () => {
  // 「只读」是关于**命令文本**的判定，而后台命令的风险来自**时间**：
  // 它不退出、在快照边界之后持续写文件，因此不受恢复层保护。
  const policy = new Policy({ mode: 'workspace-write' })

  const foreground = policy.evaluate(
    { tool: 'run_command', risk: 'execute', args: { command: 'git status' } },
    { root: projectRoot },
  )
  assert.equal(foreground.decision, 'allow')
  assert.equal(foreground.reason, 'read-only-command')

  const background = policy.evaluate(
    { tool: 'run_command', risk: 'execute', args: { command: 'git status', background: true } },
    { root: projectRoot },
  )
  assert.equal(background.decision, 'ask', '后台必须问一次')
})

test('full-access 下后台命令不额外加一道询问（模式语义不能被偷偷改掉）', () => {
  const policy = new Policy({ mode: 'full-access' })
  const verdict = policy.evaluate(
    { tool: 'run_command', risk: 'execute', args: { command: 'npm run dev', background: true } },
    { root: projectRoot },
  )
  assert.equal(verdict.decision, 'allow')
})
