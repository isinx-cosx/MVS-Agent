/**
 * 起 / 停 / 看 **llama.cpp 的 `llama-server`**（那个 35B）。
 *
 * ## 为什么需要它
 *
 * `D:\models\35b` 里只有两个 GGUF，**没有启动脚本** —— 参数是你每次手打的。
 * 而参数是这个部署里最要紧的东西：`--ctx-size` 直接决定 KV cache 多大，
 * 而内存就是这台机器的瓶颈。
 *
 * ## 参数是算出来的，不是抄的
 *
 * 实测这个模型（`tools/gguf-kv.mjs` 读 GGUF 元数据得到）：
 *
 *     41 层 · 16 个注意力头 · **只有 2 个 KV 头**（GQA）· key/value 维度 256
 *     → 每 token 的 KV = 82 KB（fp16）
 *
 *     128K 上下文：fp16 10.25 GB · q8_0 5.13 GB · q4_0 2.56 GB
 *
 * 模型文件本身 20.23 GB，机器 31.8 GB 内存、12 GB 显存（RTX 5070）。所以：
 *
 *   · `--ctx-size 131072` + **q8_0 的 KV** → 20.2 + 5.1 ≈ 25.4 GB，留 6 GB 给系统
 *   · 不量化 KV 的话是 30.5 GB —— 在 31.8 GB 上没有余量，会换页
 *   · `-ngl 0`：**故意不往显存里放**。全在 CPU 上实测约 46 t/s，够用；
 *     而显存留给小模型（那个要跑几十轮工具循环，慢下来代价更大）
 *
 * ## 为什么用 q8_0 而不是 q4_0
 *
 * q4_0 能省到 2.56 GB，但 KV 量化的质量损失在**长上下文**下会被放大
 * （而长上下文正是我们要它的理由）。q8_0 省一半、损失很小，是这里的甜点。
 *
 * 用法：
 *   node tools/serve-llama.mjs               # 起
 *   node tools/serve-llama.mjs --status
 *   node tools/serve-llama.mjs --stop
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MODEL = 'D:\\models\\35b\\Qwen3.6-35B-A3B-MTP-Q4_K_M.gguf'
const SERVER = join(
  process.env['LOCALAPPDATA'] ?? '',
  'Programs',
  'Ollama',
  'lib',
  'ollama',
  'llama-server.exe',
)
const PORT = '8080'
const CTX = '131072'

/**
 * 对外暴露的模型名。
 *
 * ⚠️ **不给 `--alias` 的话，llama-server 拿模型文件的完整路径当模型 id** ——
 * 于是 `/v1/models` 回的是 `D:\models\35b\Qwen3.6-35B-A3B-MTP-Q4_K_M.gguf`。
 * 那个名字没法写进配置（换路径就失效），而且日志里全是它。
 *
 * 这个别名要和 `src/config/resolve.ts` 里 `llama` 预设的 `model` 一致。
 */
const ALIAS = 'qwen3.6'

const STATE = join(tmpdir(), 'mvs-llama-server.json')
const LOG = join(tmpdir(), 'mvs-llama-server.log')
const ERR = join(tmpdir(), 'mvs-llama-server.err.log')

const argv = process.argv.slice(2)
const mode = argv[0] === '--stop' || argv[0] === '--status' ? argv[0] : null

const readState = () => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return null
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

if (mode === '--status') {
  const state = readState()
  console.log(`  模型    ${MODEL}`)
  console.log(`  服务    ${SERVER}`)
  console.log(`  存在:   ${existsSync(SERVER)}`)
  if (state === null) {
    console.log('  没有记录 —— 不是用这个脚本起的')
  } else if (alive(state.pid)) {
    console.log(`  活着:   pid ${state.pid}  http://127.0.0.1:${state.port}/`)
  } else {
    console.log(`  记录里的 pid ${state.pid} 已经不在了`)
  }
  process.exit(0)
}

if (mode === '--stop') {
  const state = readState()
  if (state !== null && alive(state.pid)) {
    process.kill(state.pid)
    console.log(`  已停 pid ${state.pid}`)
  } else {
    console.log('  没有活着的进程')
  }
  process.exit(0)
}

if (!existsSync(SERVER)) throw new Error(`找不到 llama-server：${SERVER}`)
if (!existsSync(MODEL)) throw new Error(`找不到模型：${MODEL}`)

const previous = readState()
if (previous !== null && alive(previous.pid)) {
  process.kill(previous.pid)
  console.log(`  先停掉旧的 pid ${previous.pid}`)
  await new Promise((r) => setTimeout(r, 2000))
}

mkdirSync(tmpdir(), { recursive: true })
const outFd = openSync(LOG, 'w')
const errFd = openSync(ERR, 'w')

const args = [
  '-m', MODEL,
  '--ctx-size', CTX,
  // KV 量化 —— 128K 能跑起来的关键
  '--cache-type-k', 'q8_0',
  '--cache-type-v', 'q8_0',
  // flash attention：KV 量化在多数构建上要求它开着。
  //
  // ⚠️ 这个构建里 `-fa` **要一个值**，不是开关 —— 写成裸 `-fa` 的话
  // 它会把**下一个参数**当成值吃掉，报的是
  //
  //     error: unknown value for --flash-attn: '-ngl'
  //
  // 那句话看起来像「-ngl 有问题」，实际是 `-fa` 少给了值。
  '-fa', 'on',
  // 不往显存里放层 —— 显存留给小模型
  '-ngl', '0',
  // 对外暴露的名字。**不给的话模型 id 就是完整路径**
  '--alias', ALIAS,
  '--host', '127.0.0.1',
  '--port', PORT,
]

console.log('  启动参数：')
console.log('    ' + args.join(' '))
console.log('')

const child = spawn(SERVER, args, {
  detached: true,
  stdio: ['ignore', outFd, errFd],
})

closeSync(outFd)
closeSync(errFd)
child.unref()

writeFileSync(STATE, JSON.stringify({ pid: child.pid, port: PORT, at: new Date().toISOString() }), 'utf8')
console.log(`  已启动 pid ${child.pid}  http://127.0.0.1:${PORT}/`)
console.log(`  日志  ${LOG}`)

/*
 * 载入 20 GB 要一会儿 —— 轮询 `/health` 比死等一个固定秒数可靠。
 * （llama-server 的 /health 在加载期间回 503，就绪后回 200。）
 */
const deadline = Date.now() + 180_000
let ready = false
for (;;) {
  if (!alive(child.pid)) break
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`)
    if (res.ok) {
      ready = true
      break
    }
  } catch {
    /* 还没起来 */
  }
  if (Date.now() > deadline) break
  await new Promise((r) => setTimeout(r, 2000))
}

if (ready) {
  const props = await (await fetch(`http://127.0.0.1:${PORT}/props`)).json()
  console.log('')
  console.log(`  ✓ 就绪    n_ctx = ${props.default_generation_settings?.n_ctx ?? '(没读到)'}`)
  const models = await (await fetch(`http://127.0.0.1:${PORT}/v1/models`)).json()
  console.log(`  模型 id   ${models.data.map((m) => m.id).join(', ')}   （--alias ${ALIAS}）`)
  console.log('')
  console.log('  守护进程那边用 `profile: "llama"` 连它（见 src/config/resolve.ts）。')
} else {
  console.log('')
  console.log(`  ✗ 没能就绪（进程${alive(child.pid) ? '还在' : '已退出'}）`)
  if (existsSync(ERR)) {
    /*
     * ⚠️ 取**含 Error/failed 的那一行**，不是尾部几行 —— 尾部全是参数回显。
     * 这个错我今天已经犯过两次了（PowerShell 的 stderr、Node 的 EADDRINUSE）。
     */
    const lines = readFileSync(ERR, 'utf8').trim().split(/\r?\n/)
    const at = lines.findIndex((l) => /error|failed|unknown argument|invalid/i.test(l))
    const shown = at >= 0 ? lines.slice(at, at + 4) : lines.slice(-8)
    console.log('  stderr：')
    for (const line of shown) console.log('    ' + line.trim())
  }
  process.exitCode = 1
}
