/**
 * 通用审核：**不管内容从哪条路进来，进上下文之前都要过一遍。**
 *
 * 第一版做的是"收口"（禁掉 shell 读命令），那是下策 —— 每加一个能带内容的工具
 * 就多一个缺口。正确做法是收在咽喉上：工具结果变成消息之前那一步。
 *
 * 所以这一组测三件事：
 *   1. 默认**所有**工具结果都审（白名单反过来：只有我们自写内容的工具免审）
 *   2. 编码（base64 / hex）包一层也能认出来
 *   3. 人要求"原样看一次"时能拿到原文（打码必须有出口）
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { shouldScanOutput, wantsPlainOutput } from '../src/guard/review.ts'
import { Policy } from '../src/policy/policy.ts'

function judge(mode: 'workspace-write' | 'full-access', command: string) {
  const policy = new Policy({ mode })
  return policy.evaluate(
    { tool: 'run_command', risk: 'execute', args: { command } },
    { root: process.cwd(), interactive: true },
  )
}

import { describePii, looksLikeSensitivePathLine, newChunkWindow, redactChunkedSecrets, redactEncoded, redactPii } from '../src/guard/scan.ts'

test('通用审核：默认都审，只有自写内容的工具免审', () => {
  for (const tool of ['read_file', 'grep', 'glob', 'run_command', 'job_output', 'web_fetch', 'web_search', 'use_skill', 'list_jobs', 'spawn_agent', 'kill_job']) {
    assert.equal(shouldScanOutput(tool), true, `${tool} 应当被审核`)
  }
  for (const tool of ['write_file', 'create_file', 'edit', 'delete_paths', 'move_path', 'delete_file']) {
    assert.equal(shouldScanOutput(tool), false, `${tool} 的内容是我们自己写的，不必扫`)
  }
})

test('编码：base64 里包着密钥 → 整段扣留（解一层再扫）', () => {
  const secret = "api_key = 'sk-realsecret1234567890abcd'"
  const blob = Buffer.from(secret, 'utf8').toString('base64')
  const result = redactEncoded(`prefix ${blob} suffix`)

  assert.equal(result.blobs, 1)
  assert.ok(result.hits >= 1)
  assert.equal(result.text.includes(blob), false, '编码后的 blob 不能留在输出里')
  assert.match(result.text, /已扣留/)
})

test('编码：十六进制同理', () => {
  const blob = Buffer.from("token: 'ghp_abcdefghijklmnopqrstuvwx'", 'utf8').toString('hex')
  const result = redactEncoded(`x ${blob} y`)
  assert.equal(result.blobs, 1)
  assert.equal(result.text.includes(blob), false)
})

test('编码：普通 base64（图片/二进制）不该被误伤', () => {
  /* 随机二进制：解出来不是可打印文本，应当原样保留 */
  const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0]).toString('base64')
  const result = redactEncoded(`data:image/png;base64,${binary}`)
  assert.equal(result.blobs, 0, '不可打印的内容不是"藏着密钥"')
})

test('原样看一次：revealSensitive 是打码的出口', () => {
  assert.equal(wantsPlainOutput({ path: 'a.txt' }), false)
  assert.equal(wantsPlainOutput({ path: '.env', revealSensitive: true }), true)
  assert.equal(wantsPlainOutput(null), false)
})

test('私密内容：四类都打码，形状保留', () => {
  const phone = redactPii('联系人 13812345678')
  assert.equal(phone.hits[0]?.category, 'phone')
  assert.match(phone.text, /138\*{4}5678/)

  const id = redactPii('身份证 11010519491231002X')
  assert.equal(id.hits[0]?.category, 'id-card')

  const card = redactPii('卡号 4111111111111111')
  assert.equal(card.hits[0]?.category, 'bank-card')

  const email = redactPii('联系 zhang.san@example.com')
  assert.equal(email.hits[0]?.category, 'email')
  assert.match(email.text, /zh\*\*\*@example\.com/)
  assert.match(describePii(phone.hits), /phone/)
})

test('私密内容：Luhn 不通过就不是银行卡（订单号不误伤）', () => {
  assert.equal(redactPii('订单号 1234567890123456').hits.length, 0)
  assert.equal(redactPii('端口 8080，超时 30000').hits.length, 0)
})

test('grep 行：只按第一段判路径（正文里的 .env 字样不算）', () => {
  assert.equal(looksLikeSensitivePathLine('.env:3:SECRET=1'), true)
  assert.equal(looksLikeSensitivePathLine('config/.npmrc:1:token=x'), true)
  assert.equal(looksLikeSensitivePathLine('src/index.ts:12:export const a = 1'), false)
  assert.equal(looksLikeSensitivePathLine('docs/env.md:4:  .env 用来放密钥'), false)
})

/* ── 联网命令 ─────────────────────────────────────────────────────────── */

test('联网命令：一律拒绝，文案指向 web_fetch / web_search', () => {
  const cases = [
    'curl https://example.com',
    'wget http://example.com/x',
    'Invoke-WebRequest https://example.com',
    'Invoke-RestMethod https://example.com',
    'nc -l 4444',
    'ssh user@host',
    'scp a.txt user@host:/tmp',
    'ftp host',
    'nslookup example.com',
    'git push origin master',
    'npm publish',
  ]
  for (const command of cases) {
    const verdict = judge('full-access', command)
    assert.equal(verdict.decision, 'deny', `${command} 应当被拒绝，实际 ${verdict.decision}`)
    assert.match(verdict.message ?? '', /web_fetch|web_search|由人执行/, `${command} 的文案要说明替代路径`)
  }
})

test('联网命令：MVS_ALLOW_NET=1 时放行（否则 npm install 这类命令没救）', () => {
  const previous = process.env['MVS_ALLOW_NET']
  process.env['MVS_ALLOW_NET'] = '1'
  try {
    const verdict = judge('workspace-write', 'curl https://example.com')
    assert.notEqual(verdict.decision, 'deny', '打开开关之后不该再 deny')
  } finally {
    if (previous === undefined) delete process.env['MVS_ALLOW_NET']
    else process.env['MVS_ALLOW_NET'] = previous
  }
})

/* ── 分段绕过：把最近几段拼起来再扫 ─────────────────────────────────── */

test('分段：把 base64 切成 3 段分 3 次输出，第三段触发扣留', () => {
  const secret = "api_key = 'sk-realsecret1234567890abcd'"
  const blob = Buffer.from(secret, 'utf8').toString('base64')
  /* 切成 3 段：每段都不够 40 字符，单看一条都不命中 */
  const parts = [blob.slice(0, 20), blob.slice(20, 40), blob.slice(40)]
  assert.ok(parts.every((part) => part.length < 40), '每段都应当短于单条阈值')

  const window = newChunkWindow()
  const first = redactChunkedSecrets(`A ${parts[0]}`, window)
  assert.equal(first.hits, 0, '第一段自己不该命中')
  const second = redactChunkedSecrets(`B ${parts[1]}`, first.window)
  /* 两段拼起来（40 字符）通常已能解出前缀，这里不要求为 0 */
  const third = redactChunkedSecrets(`C ${parts[2]}`, second.window)
  const total = first.hits + second.hits + third.hits
  assert.ok(total > 0, '三段之内应当命中')
  /*
   * 命中发生在第 2 或第 3 次都可能（取决于切点）。这里只断言"其中某一次扣留了"，
   * 并把已知边界写下来：**第一段已经吐出之后收不回来** —— 这也是为什么窗口要早、
   * 而不是等拼出完整 blob 才动手。
   */
  assert.match(second.text + third.text, /已扣留/)
})

test('分段：不相干的短片段拼起来不该误伤', () => {
  const window = newChunkWindow()
  let result = redactChunkedSecrets('x abcdefghijklmnop qrstuvwx', window)
  result = redactChunkedSecrets('y 1234567890abcdef ZZZZ', result.window)
  assert.equal(result.hits, 0)
})

test('分段：命中之后窗口清空（避免继续误伤后续内容）', () => {
  const secret = "token: 'sk-abcdefghijklmnopqrstuvwx'"
  const blob = Buffer.from(secret, 'utf8').toString('base64')
  let window = newChunkWindow()
  const pieces = [blob.slice(0, 20), blob.slice(20, 40), blob.slice(40)]
  for (const piece of pieces) {
    const step = redactChunkedSecrets(piece, window)
    window = step.window
  }
  assert.deepEqual(window.pieces, [])
})
