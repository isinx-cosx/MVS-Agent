/**
 * 探针：沙箱里的命令**还能不能起子进程**。
 *
 * ## 为什么这条决定了注册表/剪贴板
 *
 * 想把一个值写进注册表、或读剪贴板，Node 自身两个办法都没有 —— 只能：
 *
 *   · 起一个外部 exe（`reg.exe` / `powershell.exe`），或
 *   · 加载一个原生模块（koffi 这类）去调 API
 *
 * 之前已经实测：**加载原生模块在容器里过不去**（`realpath 'C:\'` 被拒）。
 * 那么剩下的唯一通道就是"起子进程"。这个探针只回答一个问题：
 *
 *     `child_process.execFileSync(process.execPath, ['-v'])` 在容器里能不能跑通？
 *
 * 结论只有两种，各自意味着：
 *   · **不能** → 注册表/剪贴板对"node 命令"这条路径**结构上就够不着**，
 *                不是"我们没测"，而是"没有可用手段"
 *   · **能**   → 那两条仍然敞开，得回去继续测（用 `reg.exe` 全路径）
 *
 *     node tools/spawn-capability-probe.mjs
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const RUNNER = path.join(process.cwd(), 'tools', 'sandbox-net-run.mjs')
const dir = mkdtempSync(path.join(tmpdir(), 'mvs-spawn-'))
const results = []

/** 跑一段 `node -e`，返回执行器结论与子进程输出 */
function runInSandbox(code, args = [], timeoutMs = 30_000) {
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
        job: parsed.job,
        text: `${parsed.stdout ?? ''}${parsed.stderr ?? ''}`.trim().slice(0, 240),
      })
    })
  })
}

/* ① 起一个**自己**（node -v）：最保守的 spawn 测试 */
results.push({
  case: 'spawn node -v',
  ...(await runInSandbox(
    [
      "const { execFileSync } = require('child_process')",
      'const exe = process.argv[1]',
      'try {',
      "  const out = execFileSync(exe, ['-v'], { stdio: 'pipe' }).toString().trim()",
      "  console.log('SPAWNED ' + out)",
      '} catch (error) {',
      "  console.log('DENIED ' + (error.code ?? error.status ?? 'error'))",
      '}',
    ].join('\n'),
    [process.execPath],
  )),
})

/* ② 起外部 exe（reg.exe 全路径）：注册表那条路真正需要的动作 */
const regExe = String.raw`C:\Windows\System32\reg.exe`
results.push({
  case: 'spawn reg.exe',
  ...(await runInSandbox(
    [
      "const { execFileSync } = require('child_process')",
      'const [exe, key] = process.argv.slice(1)',
      'try {',
      "  execFileSync(exe, ['add', key, '/v', 'MVSSpawn', '/d', 'calc', '/f'], { stdio: 'pipe' })",
      "  console.log('SPAWNED ok')",
      '} catch (error) {',
      "  console.log('DENIED ' + (error.code ?? error.status ?? 'error'))",
      '}',
    ].join('\n'),
    [regExe, String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`],
  )),
})

rmSync(dir, { recursive: true, force: true })

for (const item of results) {
  const verdict = /SPAWNED/.test(item.text)
    ? 'allowed'
    : /DENIED|EPERM|EACCES|spawn/i.test(item.text)
      ? 'denied'
      : 'inconclusive'
  process.stdout.write(`${item.case.padEnd(18)} ${verdict.padEnd(13)} job=${String(item.job)}\n  ${JSON.stringify(item.text)}\n`)
}
