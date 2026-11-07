/**
 * 输出审核：扫描器 + taint 表。
 *
 * 两组都是纯函数或纯文件操作，不依赖会话 —— 真正接线的地方在
 * `src/host/session.ts` 的闸门（结果进消息之前）。
 *
 * 这里守的是三条最容易做错的事：
 *
 *   · **按行打码**：整份扣掉会让用户关掉这个功能
 *   · **打码也要 taint**：否则模型会把打码串写回文件，真密钥永久丢失
 *   · **路径分级优先**：`.env` / 私钥这类按定义就敏感，不靠内容匹配
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import {
  describeHits,
  isSensitivePath,
  looksHighEntropy,
  maskSecret,
  scanText,
} from '../src/guard/scan.ts'
import { TaintStore, shouldScanOutput, writtenPaths } from '../src/guard/review.ts'

/* ── 扫描器 ───────────────────────────────────────────────────────────── */

test('扫描：sk- 前缀的 key 被打码，其余行原样', () => {
  const text = ['const x = 1', "const key = 'sk-abcdefghijklmnop1234'", 'const y = 2'].join('\n')
  const result = scanText(text)

  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]!.category, 'api-key')
  assert.ok(result.text.includes('const x = 1'), '未命中的行必须原样保留')
  assert.ok(result.text.includes('const y = 2'))
  assert.equal(result.text.includes('sk-abcdefghijklmnop1234'), false, '原文不能留在输出里')
  assert.ok(result.text.includes('〔已扣留〕'))
  /* 预览只露前 3 后 4，用来让用户判断"这是哪一把" */
  assert.equal(result.hits[0]!.preview, 'sk-…1234')
})

test('扫描：PEM 私钥块整行打码', () => {
  const result = scanText('-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----')
  assert.equal(result.hits.length, 1)
  assert.equal(result.hits[0]!.category, 'private-key')
  assert.ok(result.text.includes('已扣留私钥'))
})

test('扫描：Authorization 头与 JWT 都能认', () => {
  const auth = scanText('Authorization: Bearer abcdefghijklmnop')
  assert.equal(auth.hits[0]?.category, 'authorization')

  const jwt = scanText('token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijkl')
  assert.equal(jwt.hits.length, 1)
  assert.equal(jwt.hits[0]!.category, 'jwt')
})

test('扫描：赋值形态认得出，但空值与纯数字不算（防误报）', () => {
  const real = scanText('api_key = "abcd1234efgh5678"')
  assert.equal(real.hits.length, 1)
  assert.equal(real.hits[0]!.category, 'assignment')

  assert.equal(scanText('password = ""').hits.length, 0)
  assert.equal(scanText('token: 3').hits.length, 0)
  assert.equal(scanText('password: hunter2').hits.length, 0, '短小写单词不算密钥，避免误报')
})

test('扫描：高熵判定排除 git hash 与普通长标识符', () => {
  assert.equal(looksHighEntropy('a'.repeat(40)), false, '单一字符不算')
  assert.equal(
    looksHighEntropy('0123456789abcdef0123456789abcdef01234567'),
    false,
    '纯十六进制（git hash / 校验和）放行',
  )
  /* 长度必须 ≥ 32：30 字符的串按定义就不算高熵（那是刻意的保守阈值） */
  assert.equal(looksHighEntropy('Ab3+Zx9/Qw2-Lm8=Ty4+Rp6Xy8/Vn2'), false, '不到 32 字符不算')
  assert.equal(
    looksHighEntropy('Ab3+Zx9/Qw2-Lm8=Ty4+Rp6Xy8/Vn2Qz7-Wk5'),
    true,
    '混合字符集、长度够，才算密钥',
  )
})

test('扫描：整份扣留（已知敏感路径）不逐行判断', () => {
  const result = scanText('看起来完全正常的几行\n第二行', { wholeFile: true, pathHint: '.env' })
  assert.equal(result.hits.length, 1)
  assert.match(result.text, /整份输出已扣留/)
  assert.equal(result.text.includes('看起来完全正常'), false)
})

test('扫描：被扣留过的输出里，说明文字也不含原文', () => {
  const result = scanText('key=sk-abcdefghijklmnopqrstuvwx')
  const join = `${result.text}${describeHits(result.hits)}`
  assert.equal(join.includes('sk-abcdefghijklmnopqrstuvwx'), false)
})

test('路径分级：敏感路径按定义判定，不依赖内容', () => {
  for (const rel of ['.env', '.env.local', 'config/.npmrc', '.aws/credentials', 'id_rsa', 'cert.pem', 'a.key']) {
    assert.equal(isSensitivePath(rel), true, `${rel} 应当被判为敏感`)
  }
  for (const rel of ['src/index.ts', 'README.md', 'package.json', 'docs/env.md']) {
    assert.equal(isSensitivePath(rel), false, `${rel} 不该被判为敏感`)
  }
})

test('打码预览：太短就整体打掉，不留可猜的碎片', () => {
  assert.equal(maskSecret('abc'), '…')
  assert.equal(maskSecret('abcdefghijkl'), 'abc…jkl'.replace('jkl', 'ijkl'))
})

/* ── taint 表 ─────────────────────────────────────────────────────────── */

test('taint：加、查、列、清，并且落盘（重启后仍然成立）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-taint-'))
  try {
    const file = path.join(dir, '.mvs', 'taint.json')
    const store = new TaintStore(file)

    assert.equal(await store.has('a.txt'), undefined)
    await store.add('a.txt', 'api-key', '读取时命中敏感内容')
    assert.equal((await store.has('a.txt'))?.category, 'api-key')
    assert.equal((await store.list()).length, 1)

    /* 同一路径只留一条：重复遇到不改变结论 */
    await store.add('a.txt', 'jwt', '又一次')
    assert.equal((await store.has('a.txt'))?.category, 'api-key')

    /* 新实例 = 模拟重启：必须读得回来 */
    const reopened = new TaintStore(file)
    assert.equal((await reopened.has('a.txt'))?.path, 'a.txt')

    assert.equal(await store.clear('a.txt'), true)
    assert.equal(await store.has('a.txt'), undefined)
    assert.equal(await store.clear('a.txt'), false, '重复清除返回 false，而不是假装成功')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('taint：路径分隔符归一（Windows 的反斜杠也算同一个文件）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-taint-'))
  try {
    const store = new TaintStore(path.join(dir, 'taint.json'))
    await store.add('src\\a.ts', 'api-key', 'x')
    assert.equal((await store.has('src/a.ts'))?.path, 'src/a.ts')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ── 闸门的两个判断 ───────────────────────────────────────────────────── */

test('闸门：写类工具才需要取路径，其它工具返回空', () => {
  assert.deepEqual(writtenPaths('write_file', { path: 'a.txt', content: 'x' }), ['a.txt'])
  assert.deepEqual(writtenPaths('edit', { path: 'a.ts', oldString: 'a' }), ['a.ts'])
  assert.deepEqual(writtenPaths('delete_paths', { paths: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(writtenPaths('move_path', { from: 'a', to: 'b' }), ['a', 'b'])
  assert.deepEqual(writtenPaths('read_file', { path: 'a.txt' }), [])
  assert.deepEqual(writtenPaths('delete_paths', { paths: [1, 2] }), [])
})

test('闸门：除自写内容的工具外一律要扫（通用审核）', () => {
  for (const tool of ['read_file', 'grep', 'run_command', 'job_output', 'web_fetch']) {
    assert.equal(shouldScanOutput(tool), true, `${tool} 应当被扫描`)
  }
  for (const tool of ['write_file', 'edit', 'delete_paths']) {
    assert.equal(shouldScanOutput(tool), false, `${tool} 不必扫`)
  }
})

test('taint 文件里的内容是可读的 JSON（人也要能看）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-taint-'))
  try {
    const file = path.join(dir, 'taint.json')
    const store = new TaintStore(file)
    await store.add('.env', 'private-key', '读取时命中敏感内容')
    const raw = JSON.parse(await readFile(file, 'utf8')) as { version: number; paths: unknown[] }
    assert.equal(raw.version, 1)
    assert.equal(raw.paths.length, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
