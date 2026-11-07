/**
 * 读的收口：**shell 不许读文件，读只走我们自己的工具**。
 *
 * ## 为什么这是必要的
 *
 * 沙箱只管"写"，不管"读"（见 `docs/沙箱替代方案.md` 的挡不住清单）。所以真正
 * 能控制"模型看见什么"的地方只有一处：**工具结果进上下文的那个闸门**。
 * 只要 shell 还能 `cat .env`，那个闸门就是可绕过的 —— 绕过一次，做它就没意义。
 *
 * ## 这些拒绝不是"更安全"，是"唯一有效"
 *
 * `type` 读文件本身完全无害；问题是它读出来的东西**不经过审核**。所以拒绝文案
 * 必须指向 `read_file` / `grep`，否则模型会换写法重试（`Get-Content` → `gc` →
 * `[IO.File]::ReadAllText` → 自己写个小程序）。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { Policy } from '../src/policy/policy.ts'
import { describePii, looksLikeSensitivePathLine, redactPii } from '../src/guard/scan.ts'


function judge(mode: 'workspace-write' | 'full-access', command: string) {
  const policy = new Policy({ mode })
  return policy.evaluate(
    { tool: 'run_command', risk: 'execute', args: { command } },
    { root: process.cwd(), interactive: true },
  )
}

test('读命令：统统拒绝，并且指向 read_file / grep', () => {
  const cases = [
    'cat .env',
    'type config.txt',
    'head -5 a.txt',
    'tail -f log.txt',
    'more readme.md',
    'less readme.md',
    'Get-Content .env',
    'gc .env',
    'Select-String -Pattern secret .',
    'findstr secret .',
    'strings app.bin',
    'od -c file',
    'xxd file',
    'base64 file.bin',
    'certutil -encode a.txt b.b64',
    'copy a.txt b.txt',
    'xcopy a b /s',
  ]
  for (const command of cases) {
    const verdict = judge('full-access', command)
    assert.equal(verdict.decision, 'deny', `${command} 应当被拒绝，实际 ${verdict.decision}`)
    assert.match(
      verdict.message ?? '',
      /read_file|grep|glob/,
      `${command} 的拒绝文案必须指向替代工具，否则模型会换写法重试`,
    )
  }
})

test('读命令：真正只读的仍自动放行（git status / ls）', () => {
  for (const command of ['git status', 'ls']) {
    const verdict = judge('workspace-write', command)
    assert.equal(verdict.decision, 'allow', `${command} 不该被牵连`)
  }
})

test('私密内容：手机号 / 身份证 / 银行卡打码保留形状，邮箱保留域名', () => {
  const phone = redactPii('联系人 13812345678')
  assert.equal(phone.hits[0]?.category, 'phone')
  assert.match(phone.text, /138\*{4}5678/)

  const id = redactPii('身份证 11010519491231002X')
  assert.equal(id.hits[0]?.category, 'id-card')
  assert.equal(id.text.includes('11010519491231002X'), false)

  /* 银行卡：用合法 Luhn 的测试卡号 */
  const card = redactPii('卡号 4111111111111111')
  assert.equal(card.hits[0]?.category, 'bank-card')
  assert.match(card.text, /4111\*{8}1111/)

  const email = redactPii('联系 zhang.san@example.com')
  assert.equal(email.hits[0]?.category, 'email')
  assert.match(email.text, /zh\*\*\*@example\.com/)

  assert.match(describePii(phone.hits), /phone/)
})

test('私密内容：误报边界 —— 订单号不算银行卡，订单号不算身份证', () => {
  /* 16 位但过不了 Luhn 的纯数字：是订单号，不是卡号 */
  const order = redactPii('订单号 1234567890123456')
  assert.equal(order.hits.length, 0, 'Luhn 不通过就不该当银行卡')

  /* 普通短数字串 */
  assert.equal(redactPii('端口 8080，超时 30000').hits.length, 0)
})

test('grep 行：认出「这行来自敏感路径」', () => {
  assert.equal(looksLikeSensitivePathLine('.env:3:SECRET=1'), true)
  assert.equal(looksLikeSensitivePathLine('config/.npmrc:1:token=x'), true)
  assert.equal(looksLikeSensitivePathLine('src/index.ts:12:export const a = 1'), false)
  /* 正文里出现 ".env" 字样不算 —— 判的是路径位置，不是内容 */
  assert.equal(looksLikeSensitivePathLine('docs/env.md:4:  .env 用来放密钥'), false)
})
