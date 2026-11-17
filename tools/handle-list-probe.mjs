/**
 * 断言：`HANDLE_LIST` 真的挡住了"别的句柄被继承"。
 *
 * ## 为什么需要这个断言
 *
 * 之前只验证了"属性被接受、输出仍然通"。那证明的是**没弄坏 stdout**，
 * 不是**别的句柄拿不到** —— 两件事差得很远。
 *
 * ## 做法
 *
 * 1. 父进程用 `CreateFileW` 开一个句柄，并且**显式标成可继承**（`bInheritHandle = 1`）
 * 2. 把这个句柄的数值通过 argv 传给沙箱里的子进程
 * 3. 子进程尝试 `fs.writeSync(句柄, …)`
 *
 * 判定：
 *   · 子进程报 `EBADF`（bad file descriptor）→ **拦截生效**（它的句柄表里没有这个句柄）
 *   · 子进程写成功（`WROTE`）→ 拦截失效，是可继承句柄泄漏
 *
 * ## 一处诚实的限制
 *
 * 这里**没有正向对照**。要证明"没有这层拦截时子进程能拿到"，需要一个不做 HANDLE_LIST
 * 的启动路径 —— 那等于在代码里留一条"不安全的开关"，为了测试而降低安全性，不值得。
 * 所以这条断言的结论是单向的：**EBADF = 拿不到**（足够），不证明"否则一定拿得到"。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CANDIDATES = [
  process.env.MVS_KOFFI,
  'koffi',
  'file:///C:/Program Files/DSH NEXT/resources/app/node_modules/koffi/index.cjs',
].filter((item) => typeof item === 'string' && item !== '')

async function loadKoffi() {
  for (const candidate of CANDIDATES) {
    try {
      const loaded = await import(String(candidate))
      const koffi = loaded.default ?? loaded
      if (typeof koffi?.load === 'function') return koffi
    } catch {
      /* 下一个 */
    }
  }
  return null
}

const koffi = await loadKoffi()
if (koffi === null) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'koffi 不可用' })}\n`)
  process.exit(1)
}

const RUNNER = path.join(process.cwd(), 'tools', 'sandbox-net-run.mjs')
const dir = mkdtempSync(path.join(tmpdir(), 'mvs-handle-'))
const probeFile = path.join(dir, 'inheritable.txt')

/* 父进程开一个**可继承**句柄 */
const kernel = koffi.load('kernel32.dll')
const SECURITY_ATTRIBUTES = koffi.struct('SECURITY_ATTRIBUTES', {
  nLength: 'uint32',
  lpSecurityDescriptor: 'void *',
  bInheritHandle: 'int32',
})
const CreateFileW = kernel.func(
  'void * __stdcall CreateFileW(str16, uint32, uint32, SECURITY_ATTRIBUTES *, uint32, uint32, void *)',
)
const sa = { nLength: koffi.sizeof(SECURITY_ATTRIBUTES), lpSecurityDescriptor: null, bInheritHandle: 1 }
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_ALL = 0x00000007
const OPEN_ALWAYS = 4
const handle = CreateFileW(probeFile, GENERIC_WRITE, FILE_SHARE_ALL, sa, OPEN_ALWAYS, 0x80, null)
if (handle === null) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'CreateFileW 失败' })}\n`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
const handleValue = Number(koffi.address(handle))

/* 子进程：拿这个句柄号去写 */
const childCode = [
  "const fs = require('fs')",
  'const handle = Number(process.argv[1])',
  'try {',
  "  fs.writeSync(handle, Buffer.from('leaked'))",
  "  console.log('WROTE')",
  '} catch (error) {',
  "  console.log('DENIED ' + (error.code ?? error.message))",
  '}',
].join('\n')

const outcome = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [RUNNER, '--cwd', dir, '--timeout-ms', '30000', '--', process.execPath, '-e', childCode, String(handleValue)],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  let out = ''
  child.stdout?.on('data', (chunk) => {
    out += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk) => {
    out += chunk.toString('utf8')
  })
  child.on('close', () => {
    const line = out
      .split('\n')
      .filter((item) => item.trim().startsWith('{'))
      .at(-1)
    let parsed = {}
    try {
      parsed = line === undefined ? {} : JSON.parse(line)
    } catch {
      parsed = {}
    }
    resolve({
      exitCode: parsed.exitCode,
      text: `${parsed.stdout ?? ''}${parsed.stderr ?? ''}`.trim().slice(0, 200),
    })
  })
})

rmSync(dir, { recursive: true, force: true })

const verdict = outcome.text.includes('EBADF')
  ? 'isolated'
  : /\bWROTE\b/.test(outcome.text)
    ? 'LEAKED'
    : 'inconclusive'

process.stdout.write(
  `${JSON.stringify({ verdict, handle: handleValue, exitCode: outcome.exitCode, text: outcome.text })}\n`,
)
process.exitCode = verdict === 'isolated' ? 0 : 1
