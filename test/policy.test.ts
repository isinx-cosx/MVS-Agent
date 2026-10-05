/**
 * 权限层测试。
 *
 * 重点不是「规则能匹配」，而是三件更难的事：
 *   1. 熔断器能在 allow 规则之上生效
 *   2. headless 环境下 ask 会变成 deny，而不是假装问过了
 *   3. 抗疲劳熔断触发后，读操作仍然畅通
 *
 * 另有一条刻意记录**已知边界**的测试 —— 见文件末尾。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Policy, matchKey } from '../src/policy/index.ts'
import type {
  PermissionMode,
  PolicyOptions,
  PolicyRequest,
  PolicyVerdict,
} from '../src/policy/types.ts'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const ROOT = path.join(projectRoot, 'some-workspace')
const ctx = { root: ROOT }

function req(tool: string, risk: 'read' | 'write' | 'execute', args: unknown): PolicyRequest {
  return { tool, risk, args }
}

function judge(
  mode: PermissionMode,
  request: PolicyRequest,
  options: Partial<PolicyOptions> = {},
): PolicyVerdict {
  return new Policy({ mode, ...options }).evaluate(request, ctx)
}

const writeFile = (p: string): PolicyRequest =>
  req('write_file', 'write', { path: p, content: 'x' })

const command = (cmd: string): PolicyRequest => req('run_command', 'execute', { command: cmd })

// ---------------------------------------------------------------------------
// 能力上限：模式本身是硬天花板
// ---------------------------------------------------------------------------

test('只读模式：拒绝写入与命令，但读一律放行', () => {
  assert.equal(judge('read-only', writeFile('a.txt')).reason, 'mode-read-only')
  assert.equal(judge('read-only', command('ls')).reason, 'mode-no-command')

  const read = judge('read-only', req('read_file', 'read', { path: 'a.txt' }))
  assert.equal(read.decision, 'allow')
  assert.equal(read.reason, 'read-auto-allow')
})

test('能力上限是硬拒绝：allow 规则越不过只读模式', () => {
  const verdict = judge('read-only', writeFile('a.txt'), {
    rules: [{ pattern: 'write_file', decision: 'allow' }],
  })
  assert.equal(verdict.decision, 'deny')
  assert.equal(verdict.reason, 'mode-read-only')
})

test('workspace-write：工作区内写入放行，工作区外硬拒绝', () => {
  const inside = judge('workspace-write', writeFile('src/app.ts'))
  assert.equal(inside.decision, 'allow')
  assert.equal(inside.reason, 'write-inside-workspace')

  const outside = judge('workspace-write', writeFile('../outside.txt'))
  assert.equal(outside.decision, 'deny')
  assert.equal(outside.reason, 'write-outside-workspace')
})

test('full-access：工作区外写入变成询问，而不是放行', () => {
  const verdict = judge('full-access', writeFile('../outside.txt'))
  assert.equal(verdict.decision, 'ask')
  assert.equal(verdict.reason, 'write-outside-workspace')
})

test('命令默认值随模式变：workspace-write 询问，full-access 放行', () => {
  assert.equal(judge('workspace-write', command('npm test')).decision, 'ask')
  assert.equal(judge('workspace-write', command('npm test')).reason, 'command-default')
  assert.equal(judge('full-access', command('npm test')).decision, 'allow')
})

// ---------------------------------------------------------------------------
// 规则
// ---------------------------------------------------------------------------

test('匹配键：run_command 用完整命令行，文件工具用 path', () => {
  assert.equal(
    matchKey(req('run_command', 'execute', { command: 'git', args: ['log', '--oneline'] })),
    'git log --oneline',
  )
  assert.equal(matchKey(req('run_command', 'execute', { command: 'git status' })), 'git status')
  assert.equal(matchKey(writeFile('a/b.txt')), 'a/b.txt')
})

test('JSON 字符串形式的参数也能解析出匹配键', () => {
  assert.equal(matchKey(req('run_command', 'execute', '{"command":"npm test"}')), 'npm test')
})

test('没有规则时命令需要确认；加上窄规则后放行', () => {
  // ⚠️ 这里用的是 npm test 而不是 git status / ls：后两者现在会被只读分类器
  // 自动放行（见 read-only.test.ts），拿它们当「需要确认」的样本会得到 allow。
  // 换回只读命令之前先想清楚这个测试要测的是**规则优先级**，不是只读判定。
  assert.equal(judge('workspace-write', command('npm test')).decision, 'ask')

  const allowed = judge('workspace-write', command('npm test'), {
    rules: [{ pattern: 'run_command:npm test', decision: 'allow' }],
  })
  assert.equal(allowed.decision, 'allow')
  assert.equal(allowed.rule, 'run_command:npm test')
})

test('deny 优先：内置拒绝规则压过用户写的宽 allow', () => {
  const verdict = judge('full-access', command('sudo apt install x'), {
    rules: [{ pattern: 'run_command:sudo', decision: 'allow' }],
  })
  assert.equal(verdict.decision, 'deny', 'allow 规则不该能从 deny 里挖出例外')
  assert.equal(verdict.reason, 'deny-rule')
})

test('内置询问规则压过宽的 allow：`git ` 放行不能连带放行 `git push`', () => {
  const policy = new Policy({
    mode: 'full-access',
    rules: [{ pattern: 'run_command:git ', decision: 'allow' }],
  })
  assert.equal(policy.evaluate(command('git status'), ctx).decision, 'allow')
  const push = policy.evaluate(command('git push origin main'), ctx)
  assert.equal(push.decision, 'ask')
  assert.equal(push.rule, 'run_command:git push')
})

test('同决策类内最长 pattern 胜（用于诊断「哪条规则生效了」）', () => {
  const policy = new Policy({
    mode: 'workspace-write',
    rules: [
      { pattern: 'run_command', decision: 'allow' },
      { pattern: 'run_command:npm test', decision: 'allow' },
    ],
  })
  // ⚠️ 用非只读命令。换成 `git status` / `ls` 会先被只读分类器放行，
  // 于是拿不到 `rule`，这个测试就测不到「哪条规则生效」了。
  const verdict = policy.evaluate(command('npm test'), ctx)
  assert.equal(verdict.decision, 'allow')
  assert.equal(verdict.rule, 'run_command:npm test', '应报告最具体的那条')
})

test('deny-first：更长的 allow 压不过更短的 ask —— 具体程度不改变决策类别顺序', () => {
  // 这是刻意选择的安全一侧：allow 规则**不能**从 ask / deny 里挖出例外。
  // 想要这种能力就必须显式切到 precedence: 'most-specific'，那时风险自负。
  const policy = new Policy({
    mode: 'workspace-write',
    rules: [
      { pattern: 'run_command:npm test', decision: 'ask' },
      { pattern: 'run_command:npm test --watch', decision: 'allow' },
    ],
  })
  // 同上：非只读命令，否则测不到规则优先级
  assert.equal(policy.evaluate(command('npm test --watch'), ctx).decision, 'ask')
})

test('most-specific 模式下，长 allow 可以从短 ask 里挖出例外', () => {
  const verdict = judge('full-access', command('git push --force origin'), {
    precedence: 'most-specific',
    rules: [{ pattern: 'run_command:git push --force', decision: 'allow' }],
  })
  assert.equal(verdict.decision, 'allow')
})

// ---------------------------------------------------------------------------
// 熔断器：这一层真正有价值的地方
// ---------------------------------------------------------------------------

test('熔断器：保护路径 —— allow 规则无权批准', () => {
  const policy = new Policy({
    mode: 'workspace-write',
    rules: [{ pattern: 'write_file:.npmrc', decision: 'allow' }],
  })

  const protectedWrite = policy.evaluate(writeFile('.npmrc'), ctx)
  assert.equal(protectedWrite.decision, 'ask', '保护路径不能被 allow 规则预批准')
  assert.equal(protectedWrite.reason, 'protected-path')
  assert.equal(protectedWrite.allowSuppressed, true)

  // 同样的 allow 规则，写在普通路径上就正常生效 —— 证明剥夺是精确的
  const normal = policy.evaluate(writeFile('notes.txt'), ctx)
  assert.equal(normal.decision, 'allow')
})

test('熔断器：嵌套在子目录里的保护路径同样生效', () => {
  const policy = new Policy({
    mode: 'workspace-write',
    rules: [{ pattern: 'write_file', decision: 'allow' }],
  })
  const verdict = policy.evaluate(writeFile('packages/app/.git/config'), ctx)
  assert.equal(verdict.reason, 'protected-path')
  assert.equal(verdict.allowSuppressed, true)
})

test('熔断器：读保护路径不受影响（只拦写）', () => {
  const policy = new Policy({
    mode: 'workspace-write',
    rules: [{ pattern: 'read_file', decision: 'allow' }],
  })
  const verdict = policy.evaluate(req('read_file', 'read', { path: '.git/config' }), ctx)
  assert.equal(verdict.decision, 'allow')
})

test('熔断器：删除关键路径', () => {
  const cases: Array<[string, string]> = [
    ['rm -rf /', '文件系统根'],
    ['rm -rf ..', '工作区的父目录'],
    ['rm -rf ~', '家目录'],
    ['rm -rf /tmp/../../', '绕一圈回到根'],
  ]
  for (const [cmd, label] of cases) {
    const verdict = judge('full-access', command(cmd))
    assert.equal(verdict.reason, 'critical-path', `${cmd}（${label}）应该命中关键路径熔断`)
    assert.equal(verdict.decision, 'ask', `${cmd} 不该被自动放行`)
  }
})

test('熔断器：删除工作区之外的东西，无限制模式下也要确认', () => {
  const outside = path.join(path.parse(ROOT).root, 'somewhere-else', 'data')
  const verdict = judge('full-access', command(`rm -rf ${outside}`))
  assert.equal(verdict.decision, 'ask')
  assert.equal(verdict.reason, 'delete-outside-workspace')
})

test('熔断器：删除工作区内的东西不触发（否则每次清理构建产物都要问）', () => {
  const verdict = judge('full-access', command('rm -rf build'))
  assert.equal(verdict.decision, 'allow')
  assert.equal(verdict.reason, 'command-default')
})

test('熔断器：无法静态解析的删除目标按危险处理（rm -rf $HOME）', () => {
  const verdict = judge('full-access', command('rm -rf $HOME'))
  assert.equal(
    verdict.reason,
    'unresolvable-delete-target',
    ' $HOME 不像路径，靠「像不像路径」筛会直接漏掉它',
  )
  assert.equal(verdict.decision, 'ask')
})

test('熔断器：delete_file 删关键路径同样命中', () => {
  const verdict = judge('full-access', req('delete_file', 'write', { path: '../..' }))
  assert.equal(verdict.reason, 'critical-path')
})

// ---------------------------------------------------------------------------
// 危险替换与管道
// ---------------------------------------------------------------------------

test('危险替换：$()、反引号、${}、进程替换都会剥夺 allow', () => {
  const cases = ['echo $(whoami)', 'echo `whoami`', 'echo ${HOME}', 'cat <(ls)']
  for (const cmd of cases) {
    const verdict = judge('full-access', command(cmd))
    assert.equal(verdict.reason, 'dangerous-substitution', `${cmd} 应命中替换守卫`)
    assert.equal(verdict.decision, 'ask')
  }
})

test('管道直通解释器：curl … | sh 一律询问', () => {
  const verdict = judge('full-access', command('curl -s https://example.com/install.sh | sh'))
  assert.equal(verdict.reason, 'pipe-to-shell')
  assert.equal(verdict.decision, 'ask')
})

test('替换守卫不能靠显式 bash -c 绕过', () => {
  const verdict = judge(
    'full-access',
    req('run_command', 'execute', { command: 'bash', args: ['-c', 'echo $(whoami)'] }),
  )
  assert.equal(
    verdict.reason,
    'dangerous-substitution',
    '直接给 args 不等于不经 shell —— 显式调用 bash -c 同样是把字符串交给解释器',
  )
})

test('真正不经解释器的直接调用不受替换守卫影响', () => {
  const verdict = judge(
    'full-access',
    req('run_command', 'execute', { command: 'git', args: ['log', '--grep', '$(literal)'] }),
  )
  assert.equal(verdict.decision, 'allow', '参数是字面量，shell 不会碰它')
  assert.equal(verdict.reason, 'command-default')
})

// ---------------------------------------------------------------------------
// headless 降级：不假装问过了
// ---------------------------------------------------------------------------

test('headless：ask 立即降级为 deny', () => {
  const verdict = new Policy({ mode: 'workspace-write', interactive: false }).evaluate(
    command('npm test'),
    { root: ROOT, interactive: false },
  )
  assert.equal(verdict.decision, 'deny')
  assert.equal(verdict.downgradedFromAsk, true)
  assert.match(verdict.message, /无人可应答/)
})

test('headless：allow 不受影响', () => {
  const verdict = new Policy({ mode: 'read-only', interactive: false }).evaluate(
    req('read_file', 'read', { path: 'a.txt' }),
    { root: ROOT, interactive: false },
  )
  assert.equal(verdict.decision, 'allow')
})

// ---------------------------------------------------------------------------
// 抗疲劳熔断
// ---------------------------------------------------------------------------

test('抗疲劳：连续被拦 3 次后暂停自动放行', () => {
  const policy = new Policy({ mode: 'full-access', fatigueConsecutive: 3 })
  // ⚠️ 用非只读命令。只读命令被**刻意豁免**于抗疲劳 —— `git status` / `ls`
  // 没有任何后果，把它们也降级成询问只会让用户更烦、更容易闭眼点同意，
  // 而那正是熔断器想避免的事。这条豁免由 read-only.test.ts 单独钉着。
  assert.equal(policy.evaluate(command('npm test'), ctx).decision, 'allow')

  policy.observe('blocked')
  policy.observe('blocked')
  policy.observe('blocked')

  const verdict = policy.evaluate(command('npm test'), ctx)
  assert.equal(verdict.decision, 'ask')
  assert.equal(verdict.reason, 'fatigue-downgrade')
  assert.equal(policy.status().fatigued, true)
})

test('抗疲劳：成功一次就重置连续计数', () => {
  const policy = new Policy({ mode: 'full-access', fatigueConsecutive: 3 })
  policy.observe('blocked')
  policy.observe('blocked')
  policy.observe('allowed')
  policy.observe('blocked')

  assert.equal(policy.status().consecutiveBlocks, 1)
  assert.equal(policy.status().fatigued, false)
  assert.equal(policy.evaluate(command('ls'), ctx).decision, 'allow')
})

test('抗疲劳：累计阈值也会触发', () => {
  const policy = new Policy({ mode: 'full-access', fatigueConsecutive: 99, fatigueTotal: 3 })
  policy.observe('blocked')
  policy.observe('allowed')
  policy.observe('blocked')
  policy.observe('allowed')
  policy.observe('blocked')
  assert.equal(policy.status().fatigued, true)
})

test('抗疲劳：observe 只在「刚好打开」的那一次返回 true', () => {
  const policy = new Policy({ mode: 'full-access', fatigueConsecutive: 3 })

  assert.equal(policy.observe('blocked'), false)
  assert.equal(policy.observe('blocked'), false)
  assert.equal(policy.observe('blocked'), true, '第三次才跳变')
  assert.equal(
    policy.observe('blocked'),
    false,
    '已经命中之后要返回 false —— 否则每次被拦都发一条通知，真正该被看见的第一次反而被刷没了',
  )
})

test('★ 抗疲劳：allowed 不会自动解除熔断 —— 那是刻意的', () => {
  // 熔断器命中的前提就是「人在连续打回」，所以此刻的「允许」正是我们不再信任
  // 的那个动作。如果放行能自动解除，熔断器一命中就会被下一次点击关掉，等于没有。
  // 离开这个状态**只有** resetFatigue 一条路。
  const policy = new Policy({ mode: 'full-access', fatigueConsecutive: 1 })
  policy.observe('blocked')
  assert.equal(policy.status().fatigued, true)

  policy.observe('allowed')

  assert.equal(
    policy.status().fatigued,
    true,
    '放行不该解除熔断，否则它就是一次点击就能自己关掉的锁',
  )
  assert.equal(policy.status().consecutiveBlocks, 0, '但「连续」计数该被打断')
})

test('抗疲劳：命中后读操作仍然畅通（熔断不等于瘫痪）', () => {
  const policy = new Policy({ mode: 'full-access', fatigueConsecutive: 1 })
  policy.observe('blocked')

  assert.equal(
    policy.evaluate(req('read_file', 'read', { path: 'a.txt' }), ctx).decision,
    'allow',
    '熔断后连看一眼文件都要点确认，那不是更安全，是没法用',
  )
})

test('抗疲劳：复位之后重新开始累计', () => {
  const policy = new Policy({ mode: 'full-access', fatigueConsecutive: 3 })
  policy.observe('blocked')
  policy.observe('blocked')
  policy.observe('blocked')
  assert.equal(policy.status().fatigued, true)

  policy.resetFatigue()

  assert.deepEqual(
    {
      fatigued: policy.status().fatigued,
      consecutive: policy.status().consecutiveBlocks,
      total: policy.status().totalBlocks,
    },
    { fatigued: false, consecutive: 0, total: 0 },
    '复位要连累计一起清 —— 只清连续数的话，下一次被拦会立刻又命中',
  )
  assert.equal(policy.evaluate(command('ls'), ctx).decision, 'allow')
})

test('抗疲劳不影响读操作', () => {
  const policy = new Policy({ mode: 'full-access', fatigueConsecutive: 2 })
  policy.observe('blocked')
  policy.observe('blocked')

  const read = policy.evaluate(req('read_file', 'read', { path: 'a.txt' }), ctx)
  assert.equal(read.decision, 'allow', '熔断后连读文件都要确认，那不是更安全，那是瘫痪')
  assert.equal(read.reason, 'read-auto-allow')
})

test('resetFatigue 把人确认过的状态清干净', () => {
  const policy = new Policy({ mode: 'full-access', fatigueConsecutive: 1 })
  policy.observe('blocked')
  assert.equal(policy.status().fatigued, true)

  policy.resetFatigue()
  assert.equal(policy.status().fatigued, false)
  assert.equal(policy.evaluate(command('ls'), ctx).decision, 'allow')
})

// ---------------------------------------------------------------------------
// 模式切换
// ---------------------------------------------------------------------------

test('提权之后需要显式重新评估，不会追溯既有判定', () => {
  const policy = new Policy({ mode: 'read-only' })
  const before = policy.evaluate(writeFile('a.txt'), ctx)
  assert.equal(before.decision, 'deny')

  policy.setMode('workspace-write')
  assert.equal(policy.evaluate(writeFile('a.txt'), ctx).decision, 'allow')
})

test('status 报告完整，便于诊断「为什么没生效」', () => {
  const policy = new Policy({ mode: 'workspace-write', interactive: false })
  const status = policy.status()
  assert.equal(status.mode, 'workspace-write')
  assert.equal(status.interactive, false)
  assert.ok(status.rules > 0)
  assert.equal(status.fatigued, false)
})

// ---------------------------------------------------------------------------
// 已知边界
// ---------------------------------------------------------------------------

test('已知边界：无法静态解析的删除会被抓住，但这不是解析器', () => {
  // 这一条刻意断言**当前行为**，用来钉住边界、防止有人误以为覆盖是完整的。
  //
  // 现实：真正的做法是用 bash 解析器（doover 就是这么做的），并把无法解析的
  // 命令整档按危险处理。我们只做启发式，因此：
  //   - 抓得住：显式的关键路径、工作区外路径、`$VAR` 形式的删除目标
  //   - 抓不住：把路径藏进不经 shell 的解释器字符串，且不含可识别删除动词的情况
  //
  // 缓解是结构性的：workspace-write 下命令本来就默认 ask，
  // 所以熔断器只需要在 **full-access** 下承担重量，而那一档本来就意味着高风险。
  const obfuscated = judge(
    'full-access',
    req('run_command', 'execute', { command: 'git', args: ['clean', '-fdx'] }),
  )
  // `git clean` 命中了内置的询问规则，所以这里仍然是 ask —— 这是我们有意加的
  assert.equal(obfuscated.decision, 'ask')
})
