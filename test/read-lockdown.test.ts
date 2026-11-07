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
import { describePii, looksLikeSensitivePathLine, redactEncoded, redactPii } from '../src/guard/scan.ts'

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
