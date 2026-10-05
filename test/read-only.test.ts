/**
 * 只读命令分类器的测试。
 *
 * ⚠️ 这一组测试的性质和别处不同：**它守的是一道自动放行的门。**
 * 别的地方错了顶多多问一次；这里错了就是「把一个会执行任意命令的东西当成只读放行」，
 * 而那正好是这套权限层花大力气要避免的事（同类 CVE 全是靠前缀匹配绕过去的）。
 *
 * 所以用例分了四类，第 2、3 类才是重点：
 *   1. 真正只读的 → 必须放行（否则就等于没做这个功能）
 *   2. **像只读但其实会写/会执行** → 必须拦住
 *   3. **含 shell 元字符的组合** → 必须拦住（前缀相同的陷阱）
 *   4. 策略层接上之后的行为
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyReadOnly, isProvablyReadOnly } from '../src/policy/read-only.ts'
import { Policy } from '../src/policy/index.ts'
import type { PolicyRequest } from '../src/policy/types.ts'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const ctx = { root: path.join(projectRoot, 'some-workspace') }

const command = (cmd: string): PolicyRequest => ({ tool: 'run_command', risk: 'execute', args: { command: cmd } })

function why(commandText: string): string {
  return classifyReadOnly(commandText).reason
}

// ---------------------------------------------------------------------------
// 1. 真正只读的：必须放行
// ---------------------------------------------------------------------------

test('只读命令必须被放行 —— 否则这个功能等于没做', () => {
  const allowed = [
    'git status',
    'git status --short',
    'git diff',
    'git diff HEAD~1',
    'git log --oneline',
    'git show HEAD',
    'git blame a.ts',
    'git rev-parse HEAD',
    'git ls-files',
    'git branch',
    'git branch -a',
    'git tag',
    'git remote -v',
    'ls',
    'ls -la',
    'dir',
    'pwd',
    'cat a.txt',
    'type a.txt',
    'head -n 20 a.txt',
    'tail -n 20 a.txt',
    'wc -l a.txt',
    'grep -n foo a.txt',
    'rg TODO',
    'echo hello',
    'whoami',
    'date',
    'node --version',
    'npm --version',
    'npm ls',
    'go version',
  ]

  for (const cmd of allowed) {
    assert.equal(isProvablyReadOnly(cmd), true, `应当放行：${cmd}（${why(cmd)}）`)
  }
})

// ---------------------------------------------------------------------------
// 2. 像只读但其实会写 —— 必须拦住
// ---------------------------------------------------------------------------

test('★ 带位置参数就会写东西的子命令必须拦住', () => {
  // `git branch` 只读，`git branch newname` 会**创建分支**。
  // 这正是「按子命令放行」不够、还要看参数形状的原因。
  assert.equal(isProvablyReadOnly('git branch'), true)
  assert.equal(isProvablyReadOnly('git branch newfeature'), false)
  assert.equal(isProvablyReadOnly('git branch -D old'), false, '-D 后面带分支名，是删除操作')

  assert.equal(isProvablyReadOnly('git tag'), true)
  assert.equal(isProvablyReadOnly('git tag v1.0'), false)

  assert.equal(isProvablyReadOnly('git remote -v'), true)
  assert.equal(isProvablyReadOnly('git remote add origin https://x'), false)
})

test('★ 不在子命令白名单里的 git 子命令一律拦住', () => {
  // 白名单之外**不能**默认放行：git 里会写东西的子命令太多了
  for (const cmd of [
    'git config --get user.name',
    'git push',
    'git commit -m x',
    'git checkout main',
    'git reset --hard',
    'git clean -fd',
    'git stash',
    'git apply patch.diff',
    'git worktree add ../x',
  ]) {
    assert.equal(isProvablyReadOnly(cmd), false, `不该放行：${cmd}`)
  }
})

test('★ 让只读命令去执行别的东西的选项必须拦住', () => {
  // git 的 `-c` 能改配置从而触发 hook；`--ext-diff` / `--textconv` 会调用外部程序
  assert.equal(isProvablyReadOnly('git log -c core.pager=evil'), false)
  assert.equal(isProvablyReadOnly('git diff --ext-diff'), false)
  assert.equal(isProvablyReadOnly('git show --textconv HEAD'), false)
  assert.equal(isProvablyReadOnly('git log --output=leak.txt'), false)
  assert.equal(isProvablyReadOnly('git log --exec-path=/tmp/evil'), false)
})

test('★★ `--flag=值` 形式必须同样拦住 —— 这是实测漏过的一个洞', () => {
  // `--output=leak.txt` 是**一个** token。按整串比对黑名单只能匹配到 `--output`，
  // 于是所有 `--flag=值` 形式的危险选项全部漏过去。
  // 最典型的一类过滤器漏洞：**检查的是名字，喂进来的却是名字加值。**
  const holes = [
    'git log --output=leak.txt',
    'git log --exec-path=/tmp/evil',
    'git log --upload-pack=/tmp/evil',
    'git ls-files --files0-from=evil.txt',
    'git log --to-command=evil',
  ]
  for (const cmd of holes) {
    assert.equal(isProvablyReadOnly(cmd), false, `绝不能放行：${cmd}`)
  }
})

test('★ 能执行任意代码的程序名整体不在表里', () => {
  // `npm` 只在 --version / ls 这种没有副作用的形态下放行。
  // Cursor 的示例把 `npm` 整条放进允许列表，于是 `npm publish`
  // 和**所有 postinstall 脚本**都被覆盖了 —— 这里不能重复那个错误。
  assert.equal(isProvablyReadOnly('npm install'), false)
  assert.equal(isProvablyReadOnly('npm publish'), false)
  assert.equal(isProvablyReadOnly('npm run build'), false)
  assert.equal(isProvablyReadOnly('npx create-whatever'), false)
  assert.equal(isProvablyReadOnly('node -e "require(\'fs\').rmSync(\'/\',{recursive:true})"'), false)
  assert.equal(isProvablyReadOnly('python -c "print(1)"'), false)

  // 参数里能塞执行的程序也整体不放行
  assert.equal(isProvablyReadOnly('find . -exec rm {} ;'), false)
  assert.equal(isProvablyReadOnly('xargs rm'), false)
  assert.equal(isProvablyReadOnly('awk \'BEGIN{system("rm -rf /")}\''), false)
  assert.equal(isProvablyReadOnly('rm -rf /'), false)
})

// ---------------------------------------------------------------------------
// 3. shell 元字符：前缀相同的陷阱（本组最关键）
// ---------------------------------------------------------------------------

test('★★ 前缀相同的链式命令必须拦住 —— 这是同类 CVE 的形态', () => {
  // 靠前缀匹配放行 `git status`，就等于把这些全放行了。
  // 所以只要有 shell 元字符，一律判为「证明不了」。
  const chained = [
    'git status && rm -rf /',
    'git status; rm -rf /',
    'git status || rm -rf /',
    'git status & rm -rf /',
    'git status | sh',
    'git status | tee /etc/x',
    'git status > /etc/passwd',
    'git status >> ~/.bashrc',
    'git status < /etc/shadow',
    'git status $(whoami)',
    'git status `whoami`',
    'git status ${HOME}',
    'ls\nrm -rf /',
    'ls\rm -rf /',
  ]

  for (const cmd of chained) {
    assert.equal(isProvablyReadOnly(cmd), false, `绝不能放行：${JSON.stringify(cmd)}`)
  }
})

test('★ 引号一律不接受 —— 不做引号解析就不会有引号解析的 bug', () => {
  // 代价是 `git log --pretty='%h %s'` 会被多问一次。宁可多问，不可错放。
  assert.equal(isProvablyReadOnly("git log --pretty='%h %s'"), false)
  assert.equal(isProvablyReadOnly('git log --pretty="%h %s"'), false)
  assert.equal(isProvablyReadOnly('echo "a; rm -rf /"'), false)
})

test('空命令与纯空白不构成只读', () => {
  assert.equal(isProvablyReadOnly(''), false)
  assert.equal(isProvablyReadOnly('   '), false)
})

// ---------------------------------------------------------------------------
// 4. 接上策略层之后的行为
// ---------------------------------------------------------------------------

function judge(mode: 'read-only' | 'workspace-write' | 'full-access', cmd: string) {
  return new Policy({ mode }).evaluate(command(cmd), ctx)
}

test('★ workspace-write 下只读命令自动放行，有副作用的照常问', () => {
  const status = judge('workspace-write', 'git status')
  assert.equal(status.decision, 'allow')
  assert.equal(status.reason, 'read-only-command', '理由要和「按规则放行」区分开')

  const test = judge('workspace-write', 'npm test')
  assert.equal(test.decision, 'ask', '跑测试会执行任意代码，必须照常问')

  const rm = judge('workspace-write', 'rm -rf build')
  assert.equal(rm.decision, 'ask')
})

test('★ 只读模式是硬天花板：连只读命令也不放行', () => {
  // 「只读模式」的定义就是「不许执行任何命令」，这是模式本身的天花板。
  // 分类器排在能力上限**之后**，所以不会绕过它 —— 顺序就是设计。
  const verdict = judge('read-only', 'git status')
  assert.equal(verdict.decision, 'deny')
  assert.equal(verdict.reason, 'mode-no-command')
})

test('★ 只读命令不受抗疲劳影响（它没碰任何东西）', () => {
  // 抗疲劳是为了拦住「闭眼批准有后果的事」。`git status` 没有后果，
  // 把它也降级成询问，只会让用户更烦、更容易闭眼点。
  const policy = new Policy({ mode: 'workspace-write', fatigueConsecutive: 1 })
  policy.observe('blocked')
  assert.equal(policy.status().fatigued, true)

  const verdict = policy.evaluate(command('git status'), ctx)
  assert.equal(verdict.decision, 'allow')
  assert.equal(verdict.reason, 'read-only-command')

  // 但有副作用的照旧被降级
  assert.equal(policy.evaluate(command('npm test'), ctx).decision, 'ask')
})

test('只读判定要给出能显示给用户的理由', () => {
  // 自动放行必须说得出为什么 —— 说不出来的自动放行等于没有审计
  assert.match(why('git status'), /只读子命令/)
  assert.match(why('git status && rm -rf /'), /元字符/)
  assert.match(why('npm publish'), /不在只读白名单/)
  assert.match(why('npx create-x'), /不在只读程序表/)
})
