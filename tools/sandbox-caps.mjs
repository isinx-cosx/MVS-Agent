/**
 * 沙箱能力探针：把"推测"变成"实测"。
 *
 *     node tools/sandbox-caps.mjs
 *
 * 覆盖四条之前标着"未测"的通道：注册表 `HKCU\…\Run`、命名管道、NTFS 替代数据流、剪贴板。
 *
 * ## 两次失败换来的写法（别再走一遍）
 *
 * 1. **值不要拼进代码字符串，用 argv 传。**
 *    拼字符串时路径里的反斜杠与引号要过三层转义（spawn → cmd → node -e），
 *    错一次就变成语法错误，而错的样子和"被挡住"一模一样。
 *    现在代码里只写 `process.argv.slice(1)`，路径从 argv 来。
 * 2. **先确认探针自己跑通了，再看结论。**
 *    `node -e` 语法错误时 stderr 会把**源码**回显出来 —— 而源码里就写着
 *    `'CONNECTED'` / `'WROTE'`，用正则判"成功"会被自己的代码骗过去（上次就是这样）。
 *    所以判定前先看 `[eval]` 标记：有它就是探针坏了，一律 `probe-broken`。
 * 3. `node <脚本文件>` 在容器里起不来（启动要 `realpath C:\`，被拒），所以只用 `-e`。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const RUNNER = path.join(process.cwd(), 'tools', 'sandbox-net-run.mjs')
const dir = mkdtempSync(path.join(tmpdir(), 'mvs-caps-'))

/** 在沙箱里跑 `node -e <code> <args…>` */
function sandboxed(code, args = [], timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [RUNNER, '--cwd', dir, '--timeout-ms', String(timeoutMs), '--', process.execPath, '-e', code, ...args],
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
        network: parsed.network,
        job: parsed.job,
        text: `${parsed.stdout ?? ''}${parsed.stderr ?? ''}`.trim().slice(0, 300),
      })
    })
  })
}

/** 判定：先排除"探针自己坏了"，再下结论 */
function verdictOf(text) {
  if (text.includes('[eval]') || text.includes('SyntaxError')) return 'probe-broken'
  if (/DENIED|EPERM|EACCES|access is denied/i.test(text)) return 'denied'
  if (/\bWROTE\b|\bCONNECTED\b|\bREAD \d+/.test(text)) return 'allowed'
  return 'inconclusive'
}

const results = []
const push = (name, outcome) => results.push({ name, verdict: verdictOf(outcome.text), ...outcome })

/* ① 注册表：HKCU 的 Run 键（持久化最经典的一条路） */
push(
  'registry HKCU Run',
  await sandboxed(
    [
      "const { execFileSync } = require('child_process')",
      'const [exe, key] = process.argv.slice(1)',
      "try { execFileSync(exe, ['add', key, '/v', 'MVSCaps', '/d', 'calc', '/f'], { stdio: 'pipe' }); console.log('WROTE') }",
      "catch (e) { console.log('DENIED ' + (e.status ?? e.code ?? 'error')) }",
    ].join(String.fromCharCode(10)),
    [String.raw`C:\Windows\System32\reg.exe`, String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`],
  ),
)

/* ② 命名管道：本进程起服务端，沙箱子进程去连（管道名走 argv） */
const PIPE_PREFIX = String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92)
const pipeName = `${PIPE_PREFIX}mvs-caps-${process.pid}`
const server = net.createServer((socket) => socket.end())
await new Promise((resolve) => server.listen(pipeName, resolve))
push(
  'named pipe connect',
  await sandboxed(
    [
      "const net = require('net')",
      'const name = process.argv[1]',
      'const s = net.connect(name)',
      "s.on('connect', () => { console.log('CONNECTED'); s.end() })",
      "s.on('error', (e) => console.log('DENIED ' + (e.code ?? e.message)))",
    ].join(String.fromCharCode(10)),
    [pipeName],
  ),
)
server.close()

/* ③ 替代数据流：工作区（已授权）里能不能写 */
push(
  'NTFS ADS write',
  await sandboxed(
    [
      "const fs = require('fs')",
      'const name = process.argv[1]',
      "try { fs.writeFileSync(name, 'x'); console.log('WROTE') }",
      "catch (e) { console.log('DENIED ' + e.code) }",
    ].join(String.fromCharCode(10)),
    ['ads.txt:secret'],
  ),
)

/* ④ 剪贴板：能读就说明进程能看到用户复制过的一切 */
push(
  'clipboard read',
  await sandboxed(
    [
      "const { execFileSync } = require('child_process')",
      'const ps = process.argv[1]',
      "try { const v = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'], { stdio: 'pipe' }); console.log('READ ' + String(v.length)) }",
      "catch (e) { console.log('DENIED ' + (e.status ?? e.code ?? 'error')) }",
    ].join(String.fromCharCode(10)),
    [String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`],
    40_000,
  ),
)

rmSync(dir, { recursive: true, force: true })

for (const item of results) {
  process.stdout.write(
    `${item.name.padEnd(22)} ${item.verdict.padEnd(13)} job=${String(item.job)} net=${String(item.network)}\n`,
  )
  process.stdout.write(`  ${JSON.stringify(item.text.slice(0, 170))}\n`)
}
