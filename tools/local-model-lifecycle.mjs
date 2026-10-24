/**
 * 本地模型的完整生命周期测试：停干净 → 启动 → 等就绪 → 停止 → 确认关掉了。
 *
 * 写成脚本而不是 `node -e`：里面有引号、中文、await 序列，
 * 走 shell 会被转义吃掉（今天栽过好几次）。
 *
 * 用法：node tools/local-model-lifecycle.mjs
 */

import { spawnSync } from 'node:child_process'

const BASE = 'http://127.0.0.1:3092'

const llamaProcesses = () => {
  const out = spawnSync('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'latin1',
  })
  const text = (out.stdout ?? '').trim()
  if (text === '' || /No tasks|没有运行/i.test(text)) return []
  return text
    .split(/\r?\n/)
    .map((line) => line.split('","')[1])
    .filter((pid) => pid !== undefined && /^\d+$/.test(pid))
}

const killAllLlama = () => {
  for (const pid of llamaProcesses()) {
    spawnSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore' })
  }
}

const get = async (path) => await (await fetch(BASE + path)).json()
const post = async (body) =>
  await (
    await fetch(BASE + '/local-model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json()

const json = (value) => JSON.stringify(value)

console.log('  ── 1. 排干净：杀掉所有 llama-server')
killAllLlama()
await new Promise((r) => setTimeout(r, 3000))
console.log(`     还剩 ${llamaProcesses().length} 个`)

console.log('')
console.log('  ── 2. 启动（计时，验证「立刻返回」）')
const t0 = Date.now()
const started = await post({ action: 'start' })
const postMs = Date.now() - t0
console.log(`     POST 耗时 ${postMs} ms`)
console.log(`     状态 ${started.status.state}  ${started.status.detail}`)
if (postMs > 3000) {
  console.log('    太慢了 —— 它不该等到就绪才回响应')
  process.exitCode = 1
}

console.log('')
console.log('  ── 3. 等就绪')
const deadline = Date.now() + 240_000
let final = null
for (;;) {
  const status = await get('/local-model')
  if (status.state === 'ready' || status.state === 'failed' || status.state === 'external') {
    final = status
    break
  }
  if (Date.now() > deadline) {
    final = status
    console.log('     ⏱ 超时')
    break
  }
  await new Promise((r) => setTimeout(r, 3000))
}
console.log(`     状态 ${final.state}  ${final.detail}`)
if (final.ctxSize !== undefined) console.log(`     窗口 ${final.ctxSize}`)

console.log('')
console.log('  ── 4. 停止')
const stopped = await post({ action: 'stop' })
console.log(`     状态 ${stopped.status.state}  ${stopped.status.detail}`)
await new Promise((r) => setTimeout(r, 3000))
const left = llamaProcesses()
console.log(`     还剩 ${left.length} 个 llama-server 进程 ${json(left)}`)

console.log('')
const ok =
  postMs <= 3000 &&
  final.state === 'ready' &&
  final.ctxSize === 131072 &&
  stopped.status.state === 'stopped' &&
  left.length === 0
console.log(ok ? ' 生命周期全部通过' : ' 有环节不对')
process.exitCode = ok ? 0 : 1
