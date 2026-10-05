/**
 * 后台作业的管理工具：看列表、看输出、停掉。
 *
 * 三个都是 `read` 风险 —— 它们只读注册表，或者停掉**我们自己起的**进程。
 * 这一点值得说清：`kill_job` 不是「执行任意命令」，它只能终结一个由本进程注册的
 * 作业 id，作用域是封闭的。把它标成 `execute` 会让「停掉我自己起的 dev server」
 * 也要人确认一次，那是没必要的摩擦。
 *
 * 反过来说：`kill_job` **不能**按 pid 杀任意进程 —— 它只接受注册表里的 id。
 * 这是它敢标成 read 的全部理由。
 */

import { failResult, okResult, type Tool } from './types.ts'

interface ListJobsArgs {
  /** 是否包含已经结束的作业。默认包含 —— 「它退出了没有」是最常问的问题 */
  includeFinished?: boolean
}

export const listJobsTool: Tool<ListJobsArgs> = {
  name: 'list_jobs',
  description:
    '列出后台作业（run_command background=true 起的）以及它们是否还在跑。' +
    '用 job_output 看某个作业的输出，用 kill_job 停掉它。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: {
      includeFinished: {
        type: 'boolean',
        description: '是否包含已结束的作业，默认 true。',
      },
    },
  },

  async run(args, ctx) {
    if (ctx.jobs === undefined) {
      return okResult('这个环境没有后台作业注册表。', { jobs: [] })
    }

    const all = ctx.jobs.list()
    const jobs = args.includeFinished === false ? all.filter((j) => j.exit === null) : all

    if (jobs.length === 0) {
      return okResult(
        all.length === 0 ? '还没有后台作业。' : '没有还在跑的后台作业。',
        { jobs: [] },
      )
    }

    const lines = jobs.map((job) => {
      const state =
        job.exit === null
          ? '运行中'
          : job.killed
            ? `已停止（${job.exit.code ?? job.exit.signal ?? '?'}）`
            : `已退出（code=${job.exit.code ?? 'null'} signal=${job.exit.signal ?? 'null'}）`
      return `${job.id}  ${state}  ${job.startedAt}  ${job.command}`
    })

    return okResult(
      [
        `后台作业 ${jobs.length} 个：`,
        ...lines,
        '',
        '⚠️ 后台作业不受恢复层保护：它们的文件改动在快照边界之外，撤销覆盖不到。',
      ].join('\n'),
      {
        jobs: jobs.map((job) => ({
          id: job.id,
          command: job.command,
          running: job.exit === null,
          pid: job.pid,
          startedAt: job.startedAt,
          exit: job.exit,
        })),
      },
    )
  },
}

interface JobOutputArgs {
  jobId: string
}

export const jobOutputTool: Tool<JobOutputArgs> = {
  name: 'job_output',
  description: '看某个后台作业的输出（stdout 与 stderr 的尾部）。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: { jobId: { type: 'string', minLength: 1, description: 'list_jobs 给出的作业 id' } },
    required: ['jobId'],
  },

  async run(args, ctx) {
    if (ctx.jobs === undefined) return failResult('failed', '这个环境没有后台作业注册表。')

    const job = ctx.jobs.get(args.jobId)
    if (job === undefined) {
      return failResult(
        'not_found',
        `没有这个作业：${args.jobId}。用 list_jobs 看有哪些（作业只在本次进程生命周期内有效，重启后列表会空）。`,
      )
    }

    const output = await ctx.jobs.output(args.jobId)
    const state =
      job.exit === null
        ? '运行中'
        : `已结束（code=${job.exit.code ?? 'null'} signal=${job.exit.signal ?? 'null'}）`

    const parts = [`${job.id} · ${state} · ${job.command}`]
    if (output !== undefined && output.stdout.trim() !== '') {
      parts.push('--- stdout ---', output.stdout)
    }
    if (output !== undefined && output.stderr.trim() !== '') {
      parts.push('--- stderr ---', output.stderr)
    }
    if (output !== undefined && output.stdout.trim() === '' && output.stderr.trim() === '') {
      parts.push('(还没有输出)')
    }
    return okResult(parts.join('\n'), { jobId: job.id, running: job.exit === null })
  },
}

interface KillJobArgs {
  jobId: string
}

export const killJobTool: Tool<KillJobArgs> = {
  name: 'kill_job',
  description:
    '停掉一个后台作业（连同它派生的整棵进程树）。只能停本进程注册的作业 id，不能按 pid 杀任意进程。',
  risk: 'read',
  parameters: {
    type: 'object',
    properties: { jobId: { type: 'string', minLength: 1, description: 'list_jobs 给出的作业 id' } },
    required: ['jobId'],
  },

  async run(args, ctx) {
    if (ctx.jobs === undefined) return failResult('failed', '这个环境没有后台作业注册表。')

    const job = ctx.jobs.get(args.jobId)
    if (job === undefined) {
      return failResult('not_found', `没有这个作业：${args.jobId}`)
    }
    if (job.exit !== null) {
      // 如实说「它早就结束了」而不是报成功 —— 报成功会让调用方以为是自己停掉的
      return okResult(
        `${job.id} 已经结束了（code=${job.exit.code ?? 'null'} signal=${job.exit.signal ?? 'null'}），没有需要停的。`,
        { jobId: job.id, killed: false, alreadyExited: true },
      )
    }

    const killed = ctx.jobs.kill(args.jobId)
    if (!killed) {
      return failResult('failed', `停不掉 ${job.id} —— 它可能刚好在这一瞬间退出了，用 list_jobs 确认。`)
    }
    return okResult(
      `已停止 ${job.id}（${job.command}）。整棵进程树一起停 —— 只杀直接子进程的话，` +
        '它派出去的孙进程会活下来继续往工作区里写文件。',
      { jobId: job.id, killed: true, alreadyExited: false },
    )
  },
}
