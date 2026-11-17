/**
 * 原生 exe 在容器里能干什么：注册表与剪贴板。
 *
 * ## 为什么需要它
 *
 * 之前测"注册表/剪贴板够不着"用的是 **node 命令**：模块加载被拒、spawn 静默死。
 * 但那只能证明"node 命令够不着"。一个**原生程序**既不加载 JS 模块、也不 spawn，
 * 它直接调 Win32 —— 结论不能平移。
 *
 * ## 做法
 *
 * 不自己编 exe：直接把 `C:\Windows\System32\reg.exe` / `powershell.exe` 交给
 * `sandbox-net-run.mjs` 启动（容器里的子进程就是它们），然后由**父进程**去查结果：
 *
 *   · 注册表：写 `HKCU\…\Run` 一个测试值，父进程 `reg query` 看存不存在，再删掉
 *   · 剪贴板：让 powershell 读一次，看它能不能启动并输出
 *
 *     node tools/native-exe-probe.mjs
 */

import { spawnSync } from 'node:child_process'
/* 不建临时目录：容器读不到未授权路径，那会把'起不来'误读成'被挡住' */
import { tmpdir } from 'node:os'
import path from 'node:path'

const RUNNER = path.join(process.cwd(), 'tools', 'sandbox-net-run.mjs')
const dir = process.cwd()
const SYSTEM32 = String.raw`C:\Windows\System32`
const RUN_KEY = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
const VALUE_NAME = 'MVS Native Probe'

function inSandbox(exe, args, timeoutMs = 40_000) {
  const result = spawnSync(
    process.execPath,
    [RUNNER, '--cwd', dir, '--timeout-ms', String(timeoutMs), '--', exe, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: timeoutMs + 10_000 },
  )
  let report = {}
  const line = String(result.stdout ?? '')
    .split('\n')
    .filter((item) => item.trim().startsWith('{'))
    .at(-1)
  try {
    report = line === undefined ? {} : JSON.parse(line)
  } catch {
    report = {}
  }
  return {
    exitCode: report.exitCode,
    text: `${report.stdout ?? ''}${report.stderr ?? ''}`.trim().slice(0, 200),
    network: report.network,
  }
}

const results = []

/* ① 注册表：原生 reg.exe 能不能写 HKCU\…\Run */
const regWrite = inSandbox(`${SYSTEM32}\\reg.exe`, ['add', RUN_KEY, '/v', VALUE_NAME, '/d', 'calc', '/f'])
const check = spawnSync('reg', ['query', RUN_KEY, '/v', VALUE_NAME], { encoding: 'utf8', windowsHide: true })
const written = check.status === 0
if (written) spawnSync('reg', ['delete', RUN_KEY, '/v', VALUE_NAME, '/f'], { encoding: 'utf8', windowsHide: true })
results.push({
  case: 'registry (reg.exe in container)',
  verdict: written ? 'allowed' : /denied|EPERM|EACCES|access is denied/i.test(regWrite.text) ? 'denied' : regWrite.exitCode === undefined ? 'inconclusive' : 'denied',
  exitCode: regWrite.exitCode,
  text: regWrite.text.slice(0, 120),
})

/* ② 剪贴板：原生 powershell 能不能读 */
const ps = `${SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe`
/* 命令尽量简单：成功打 READ，失败打 DENIED 加异常类型 —— 少一个引号少一次误判 */
const clipScript = 'try { $c = Get-Clipboard -ErrorAction Stop; Write-Output READ } catch { Write-Output DENIED; Write-Output $_.Exception.GetType().Name }'
const clip = inSandbox(ps, ['-NoProfile', '-NonInteractive', '-Command', clipScript], 45_000)
const read = /\bREAD\b/.test(clip.text)
results.push({
  case: 'clipboard (powershell in container)',
  verdict: read ? 'allowed' : /DENIED|denied|EPM|denied/i.test(clip.text) ? 'denied' : clip.exitCode === undefined ? 'inconclusive' : 'inconclusive',
  exitCode: clip.exitCode,
  text: clip.text.slice(0, 120),
})

/* cwd 用工作区：临时目录没被授权，powershell 连启动都失败（会误判成"被挡"） */

process.stdout.write(`${JSON.stringify(results, null, 0)}\n`)
