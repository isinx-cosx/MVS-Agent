/**
 * 行为评估。
 *
 * 两组测试：
 *
 *   · **断言层**（纯函数）—— 每一条断言都能单独成立，包括"该失败时确实失败"
 *   · **跑起来**（脚本化模型）—— 证明整条链路真的能跑：建工作区、起 Runtime、
 *     跑一轮、读投影、算事务、出报告
 *
 * ⚠️ 脚本化模型只证明**工具链活着**，它对模型行为没有任何结论。
 * 真正评估模型要 `npm run eval -- --profile <真实档案>`，而那条路需要模型可达。
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { checkExpectations, checkInvariants } from '../src/eval/assert.ts'
import { loadScenarios, runScenarios } from '../src/eval/run.ts'
import type { Observations, Scenario } from '../src/eval/types.ts'

function observations(patch: Partial<Observations> = {}): Observations {
  return {
    finalText: '',
    tools: [],
    steps: 0,
    status: 'idle',
    approvals: 0,
    files: {},
    transactions: 0,
    malformed: 0,
    unsettledCall: false,
    pendingApproval: false,
    ms: 10,
    ...patch,
  }
}

/* ── 不变量 ──────────────────────────────────────────────────────────── */

test('不变量：一切正常时没有失败', () => {
  assert.deepEqual(checkInvariants(observations()), [])
})

test('不变量：一轮没结束 → 产品层面的失败', () => {
  const failures = checkInvariants(observations({ status: 'running' }))
  assert.equal(failures.length, 1)
  assert.equal(failures[0]!.kind, 'invariant')
  assert.match(failures[0]!.message, /没有结束/)
})

test('不变量：挂着的工具调用 / 悬空审批 / 坏日志都要报', () => {
  const failures = checkInvariants(
    observations({ unsettledCall: true, pendingApproval: true, malformed: 2 }),
  )
  assert.equal(failures.length, 3)
  assert.ok(failures.every((failure) => failure.kind === 'invariant'))
})

test('不变量：超时不算通过，也不说模型不行', () => {
  const failures = checkInvariants(observations({ timedOut: true }))
  assert.equal(failures.length, 1)
  assert.match(failures[0]!.message, /超时/)
})

/* ── 任务断言 ────────────────────────────────────────────────────────── */

const scenario = (expectPatch: Scenario['expect']): Scenario => ({
  id: 'x',
  description: 'x',
  prompt: 'x',
  expect: expectPatch,
})

test('断言：finalText 支持子串与 /正则/', () => {
  assert.deepEqual(
    checkExpectations(scenario({ finalText: '蓝鲸号' }), observations({ finalText: '代号是蓝鲸号' })),
    [],
  )
  assert.deepEqual(
    checkExpectations(scenario({ finalText: '/蓝鲸\\d号/' }), observations({ finalText: '蓝鲸7号' })),
    [],
  )
  const failed = checkExpectations(scenario({ finalText: '蓝鲸号' }), observations({ finalText: '别的' }))
  assert.equal(failed.length, 1)
  assert.equal(failed[0]!.kind, 'expectation')
})

test('断言：toolCalled 是"之一"，toolAllCalled 是"全部"', () => {
  const observed = observations({ tools: [{ name: 'edit', ok: true }] })
  assert.deepEqual(checkExpectations(scenario({ toolCalled: ['edit', 'write_file'] }), observed), [])
  const both = checkExpectations(scenario({ toolAllCalled: ['edit', 'write_file'] }), observed)
  assert.equal(both.length, 1)
  assert.match(both[0]!.message, /write_file/)
})

test('断言：toolNotCalled 命中就失败', () => {
  const observed = observations({ tools: [{ name: 'run_command', ok: true }] })
  const failures = checkExpectations(scenario({ toolNotCalled: ['run_command'] }), observed)
  assert.equal(failures.length, 1)
  assert.match(failures[0]!.message, /不该调用 run_command/)
})

test('断言：fileContains / fileMissing', () => {
  const observed = observations({ files: { 'a.txt': '你好世界' } })
  assert.deepEqual(checkExpectations(scenario({ fileContains: { 'a.txt': '你好' } }), observed), [])

  const missing = checkExpectations(scenario({ fileContains: { 'b.txt': 'x' } }), observed)
  assert.equal(missing.length, 1)
  assert.match(missing[0]!.message, /b\.txt 不存在/)

  const created = checkExpectations(scenario({ fileMissing: ['a.txt'] }), observed)
  assert.equal(created.length, 1)
  assert.match(created[0]!.message, /应当不存在/)
})

test('断言：maxSteps 与审批两种期望', () => {
  const observed = observations({ steps: 5, approvals: 2 })
  assert.equal(checkExpectations(scenario({ maxSteps: 3 }), observed).length, 1)
  assert.deepEqual(checkExpectations(scenario({ approvalAsked: true }), observed), [])
  assert.equal(checkExpectations(scenario({ noApproval: true }), observed).length, 1)

  const noAsk = checkExpectations(scenario({ approvalAsked: true }), observations())
  assert.match(noAsk[0]!.message, /应当问人/)
})

/* ── 读场景 ──────────────────────────────────────────────────────────── */

test('场景读取：坏 JSON 要说清是哪个文件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-eval-load-'))
  try {
    await writeFile(path.join(dir, 'broken.json'), '{ 不是 JSON', 'utf8')
    await assert.rejects(() => loadScenarios(dir), /broken\.json/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景读取：缺 id 或 prompt 也要说清文件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-eval-load-'))
  try {
    await writeFile(path.join(dir, 'half.json'), JSON.stringify({ id: 'a' }), 'utf8')
    await assert.rejects(() => loadScenarios(dir), /half\.json/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('场景读取：按文件名排序，保证每次跑的顺序一样', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-eval-load-'))
  try {
    await writeFile(path.join(dir, 'b.json'), JSON.stringify({ id: 'b', description: '', prompt: 'p' }), 'utf8')
    await writeFile(path.join(dir, 'a.json'), JSON.stringify({ id: 'a', description: '', prompt: 'p' }), 'utf8')
    const scenarios = await loadScenarios(dir)
    assert.deepEqual(scenarios.map((item) => item.id), ['a', 'b'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ── 真的跑一遍 ──────────────────────────────────────────────────────── */

test('跑起来：脚本化模型 + 自检场景 → 全部通过，报告标明是自检', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-eval-run-'))
  try {
    const scenariosDir = path.join(dir, 'scenarios')
    await mkdir(scenariosDir, { recursive: true })
    await writeFile(
      path.join(scenariosDir, 'a.json'),
      JSON.stringify({
        id: 'a',
        description: '读一次就收尾',
        prompt: '看看',
        files: { 'README.md': 'x\n' },
        expect: { toolCalled: ['read_file'], finalText: '看完了', maxSteps: 2 },
      }),
      'utf8',
    )

    const report = await runScenarios({
      scenarios: await loadScenarios(scenariosDir),
      modelFactory: () => {
        throw new Error('脚本化模式下不该用到真实模型')
      },
      modelLabel: '脚本化',
      profile: 'scripted',
      scripted: true,
    })

    assert.equal(report.meta.scripted, true)
    assert.equal(report.summary.total, 1)
    assert.equal(report.summary.failed, 0, JSON.stringify(report.results[0]?.failures))
    assert.equal(report.results[0]!.observations.tools[0]!.name, 'read_file')
    assert.equal(report.results[0]!.observations.transactions, 0, '只读不该产生事务')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('跑起来：期望不满足时报告如实标成"模型"失败', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-eval-run-'))
  try {
    const scenariosDir = path.join(dir, 'scenarios')
    await mkdir(scenariosDir, { recursive: true })
    await writeFile(
      path.join(scenariosDir, 'a.json'),
      JSON.stringify({
        id: 'a',
        description: '要求一个它不会做的事',
        prompt: '看看',
        files: { 'README.md': 'x\n' },
        /* 脚本化模型不会写文件 —— 这条必须失败，且失败要归到"模型" */
        expect: { fileContains: { 'out.txt': 'x' } },
      }),
      'utf8',
    )

    const report = await runScenarios({
      scenarios: await loadScenarios(scenariosDir),
      modelFactory: () => {
        throw new Error('不该用到')
      },
      modelLabel: '脚本化',
      profile: 'scripted',
      scripted: true,
    })

    assert.equal(report.summary.failed, 1)
    assert.equal(report.summary.invariantFailures, 0, '这不该算成产品层面的失败')
    const failure = report.results[0]!.failures[0]!
    assert.equal(failure.kind, 'expectation')
    assert.match(failure.message, /out\.txt/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('跑起来：--only 只跑指定的那个', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-eval-run-'))
  try {
    const scenariosDir = path.join(dir, 'scenarios')
    await mkdir(scenariosDir, { recursive: true })
    for (const id of ['a', 'b']) {
      await writeFile(
        path.join(scenariosDir, `${id}.json`),
        JSON.stringify({ id, description: '', prompt: '看看', expect: { maxSteps: 2 } }),
        'utf8',
      )
    }

    const report = await runScenarios({
      scenarios: await loadScenarios(scenariosDir),
      modelFactory: () => {
        throw new Error('不该用到')
      },
      modelLabel: '脚本化',
      profile: 'scripted',
      scripted: true,
      only: ['b'],
    })

    assert.equal(report.summary.total, 1)
    assert.equal(report.results[0]!.id, 'b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
