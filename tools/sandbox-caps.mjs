/**
 * 沙箱能力探针：**把"推测"变成"实测"**。
 *
 * 之前的挡不住清单里，这几条一直标着"未测"：
 *
 *   · 注册表 `HKCU\…\Run`（持久化）
 *   · 命名管道 `\\.\pipe\…`
 *   · NTFS 替代数据流（`file.txt:secret`）
 *   · 剪贴板
 *
 * 这个脚本在**默认沙箱**（AppContainer 断网 + Job 上限）里逐条试，
 * 每条都输出 `allowed` 或 `denied`，不猜。
 *
 *     node tools/sandbox-caps.mjs
 *
 * 管道那一条需要一个服务端，所以由本进程先起一个命名管道服务器，
 * 再让沙箱里的子进程去连 —— 这样"连不上"才有意义（而不是因为没服务端）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

const RUNNER = path.join(process.cwd(), 'tools', 'sandbox-net-run.mjs')

/** 在沙箱里跑一段 node 脚本，返回 { ok, exitCode, output, denied } */
function sandboxed(code, cwd) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [RUNNER, '--cwd', cwd, '--timeout-ms', '30000', '--', process.execPath, '-e', code],
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
      const line = out.split('\n').filter((item) => item.trim().startsWith('{')).at(-1)
      let parsed = {}
      try {
        parsed = line === undefined ? {} : JSON.parse(line)
      } catch {
        parsed = {}
      }
      const text = `${parsed.stdout ?? ''}${parsed.stderr ?? ''}`
      resolve({
        ok: parsed.ok === true,
        exitCode: parsed.exitCode,
        network: parsed.network,
        job: parsed.job,
        text: text.slice(0, 240),
        denied: /denied|EPERM|EACCES|ERROR_ACCESS/i.test(text),
      })
    })
  })
}

/** 跑一个脚本文件（比 -e 稳：没有第二层引号/转义） */
function sandboxedFile(scriptPath, cwd) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [RUNNER, '--cwd', cwd, '--timeout-ms', '30000', '--', process.execPath, scriptPath],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    let out = ''
    child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.on('close', () => {
      const line = out.split('\n').filter((item) => item.trim().startsWith('{')).at(-1)
      let parsed = {}
      try { parsed = line === undefined ? {} : JSON.parse(line) } catch { parsed = {} }
      const text = `${parsed.stdout ?? ''}${parsed.stderr ?? ''}`
      resolve({
        ok: parsed.ok === true,
        exitCode: parsed.exitCode,
        network: parsed.network,
        job: parsed.job,
        text: text.slice(0, 240),
        denied: /denied|EPERM|EACCES|ERROR_ACCESS|CONNECTED/i.test(text) ? /denied|EPERM|EACCES|ERROR_ACCESS/i.test(text) : false,
      })
    })
  })
}

const dir = mkdtempSync(path.join(tmpdir(), 'mvs-caps-'))
const results = []

/* ① 注册表：HKCU 的 Run 键（持久化最经典的一条路） */
results.push({
  case: 'registry HKCU\\…\\Run',
  ...(await sandboxed(
    "const { execSync } = require('child_process');" +
      "try { execSync('reg add HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run /v MVSCaps /d calc /f', { stdio: 'pipe' }); console.log('WROTE') }" +
      "catch (e) { console.log('DENIED ' + (e.stderr ? 'reg-denied' : e.code)) }",
    dir,
  )),
})

/* ② 替代数据流：工作区里（已被授权）能不能写 ADS */
results.push({
  case: 'NTFS ADS file.txt:secret',
  ...(await sandboxed(
    "const fs = require('fs');" +
      "try { fs.writeFileSync('a.txt:secret', 'x'); console.log('WROTE ' + fs.readFileSync('a.txt:secret', 'utf8')) }" +
      "catch (e) { console.log('DENIED ' + e.code) }",
    dir,
  )),
})

/* ③ 命名管道：本进程起服务端，沙箱子进程去连（脚本写成文件，避免 -e 的反斜杠转义） */
const pipeName = `\\\\.\\pipe\\mvs-caps-${process.pid}`
const server = net.createServer((socket) => socket.end())
await new Promise((resolve) => server.listen(pipeName, resolve))
const pipeScript = path.join(dir, 'pipe.mjs')
writeFileSync(
  pipeScript,
  [
    "import net from 'node:net'",
    `const s = net.connect(${JSON.stringify(pipeName)})`,
    "s.on('connect', () => { console.log('CONNECTED'); s.end() })",
    "s.on('error', (e) => console.log('DENIED ' + (e.code ?? e.message)))",
    '',
  ].join(String.fromCharCode(10)),
  'utf8',
)
results.push({
  case: 'named pipe connect',
  ...(await sandboxedFile(pipeScript, dir)),
})
server.close()

/* ④ 剪贴板：能读就说明进程能看到用户复制过的任何东西 */
results.push({
  case: 'clipboard read',
  ...(await sandboxed(
    "const { execSync } = require('child_process');" +
      "try { const v = execSync('powershell -NoProfile -Command Get-Clipboard', { stdio: 'pipe' }).toString();" +
      " console.log('READ ' + v.length) }" +
      "catch (e) { console.log('DENIED ' + (e.code ?? 'error')) }",
    dir,
  )),
})

rmSync(dir, { recursive: true, force: true })

for (const item of results) {
  process.stdout.write(
    `${item.case.padEnd(28)} ${item.denied ? 'denied' : 'allowed'}  ` +
      `(exit=${String(item.exitCode)}, job=${String(item.job)}, net=${String(item.network)})\n`,
  )
}
void existsSync

process.stdout.write(String.fromCharCode(10) + '--- 原文 ---' + String.fromCharCode(10))
for (const item of results) {
  process.stdout.write(item.case + ': exit=' + String(item.exitCode) + ' text=' + JSON.stringify(item.text) + String.fromCharCode(10))
}
