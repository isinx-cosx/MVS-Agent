/**
 * 一次性：把 `localModel` 写进 `~/.mvs-agent/config.json`。
 *
 * ## 参数来自实测，不是猜的
 *
 * 来自 `C:\Users\fsafsafsa\Downloads\Venture-main\run-35b.ps1` 和
 * `README-30B-MoE.md` —— 那是用户自己在 RTX 5070 12GB + 32GB DDR5 上扫出来的。
 *
 * ## 我第一版错在哪
 *
 * 我写的是 `-ngl 0`（**零层上 GPU**），理由是「显存留给小模型」——
 * 那是我自己编的约束，代价是**一点 GPU 都没用上**：载入 155 秒、12 GB 显存空着。
 *
 * 正确的形状是：**attention 全部上 GPU（`-ngl 999`），专家层按显存余量分档
 * （`-ncmoe N`）**。因为 MoE 模型 85% 的权重是专家张量，而注意力那些
 * 密集部分很小、却算得最频繁 —— 放 GPU 是纯赚。
 *
 * ## 为什么专门写个脚本而不是 `node -e`
 *
 * 反斜杠要经过 **两层** 转义（shell 一层、JS 字符串一层），而 `D:\models\...`
 * 多转一层就变成一个**不存在的路径** —— 它不会报错，只会「找不到模型文件」。
 *
 * 用法：node tools/set-local-model.mjs [--no-autostart]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG = join(homedir(), '.mvs-agent', 'config.json')

/** 反斜杠就是单个的 —— 见文件头 */
const MODEL_PATH = 'D:\\models\\35b\\Qwen3.6-35B-A3B-MTP-Q4_K_M.gguf'

/** 用户实测调参用的那个 llama.cpp 构建。`-ncmoe` / `-cram` 是较新的旗标，Ollama 那份未必认 */
const LLAMACPP_ROOT = join(homedir(), 'Downloads', 'Venture-main', '_repos', 'llamacpp')

function findServer() {
  if (!existsSync(LLAMACPP_ROOT)) return null
  try {
    for (const entry of readdirSync(LLAMACPP_ROOT)) {
      const exe = join(LLAMACPP_ROOT, entry, 'llama-server.exe')
      if (existsSync(exe)) return exe
    }
  } catch {
    /* 读不了就算了 */
  }
  return null
}

if (!existsSync(CONFIG)) {
  console.error(`  没有 ${CONFIG} —— 先跑一次守护进程让它生成`)
  process.exit(1)
}

if (!existsSync(MODEL_PATH)) {
  console.error(`  ⚠️ 模型文件不存在：${MODEL_PATH}`)
  console.error('     写进去只会得到一个「找不到模型」的状态，所以先停下。')
  process.exit(1)
}

const serverPath = findServer()

const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
config.localModel = {
  autoStart: !process.argv.includes('--no-autostart'),
  ...(serverPath === null ? {} : { serverPath }),
  modelPath: MODEL_PATH,
  port: 8080,
  alias: 'qwen3.6',

  /*
   * 128K + ncmoe 26 —— 这是 `run-35b.ps1 -Agent` 那档，也是 128K 下实测最好的：
   *
   *     ncmoe 24 = 43.15 tok/s（只剩 121 MiB，危险）
   *     ncmoe 26 = 45.06 tok/s（1063 MiB 余量）← 这个
   *     ncmoe 28 = 40.30 tok/s（余量多，但慢 11%）
   *
   * ⚠️ **改 ctxSize 必须重扫 ncmoe。** 实测：同样 ncmoe 20，
   * 在 512 上下文下 69.78 tok/s，在 8192 下崩到 27.65 —— KV cache 吃掉了
   * 本该留给专家层的显存。这两个数是**一对**，不能单独改。
   */
  ctxSize: 131072,
  cpuMoeLayers: 26,

  /*
   * attention 全上 GPU，专家留 CPU —— 见 run-35b.ps1。
   * **不是 0。** 0 等于 12 GB 显存全空着不用，我第一版就是这么错的。
   */
  gpuLayers: 999,

  cacheTypeK: 'q8_0',
  cacheTypeV: 'q8_0',
  flashAttention: true,
  cacheRam: 2048,

  /*
   * ⚠️ 单用户必须设 1。默认是多 slot，会把显存切成几份，
   * 而显存在这个配置里是最稀缺的资源。
   */
  parallel: 1,

  /*
   * 思考模式**开着**（用户要求）。
   *
   * 实测三种取值（同一个问题、900 token 上限）：
   *
   *     off    1.6s  finish=stop    思考 0 字符     正文 5 字符（答对）
   *     auto  17.5s  finish=length  思考 2552 字符  正文 0 字符
   *     on    17.3s  finish=length  思考 2510 字符  正文 0 字符
   *
   * ⚠️ `auto` / `on` 那两行**没有正文**不是坏了 —— 是 900 token 被思考吃光了。
   * 守护进程不设 `max_tokens`，所以实际用服务端的默认值；要压上限就设
   * `reasoningBudget`。
   *
   * 我一度把默认写成 `off`，理由是「on 会把服务打崩」——**那个结论是错的**，
   * 崩是反复 taskkill 留下的半死进程造成的。复测用
   * `tools/probe-reasoning-sweep.mjs`（起→探→关，逐个取值）。
   */
  reasoningFormat: 'deepseek',
  /*
   * 明确写 `on`，不写 `auto`。
   *
   * 实测两者差别可以忽略（思考 2552 vs 2510 字符），但语义不同：
   * `auto` 是「让服务端决定」，而「默认开启」是个明确的默认值 ——
   * 明确的默认值不该把决定权再交出去。要关掉就写 `'off'`。
   */
  reasoning: 'on',
}

writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

// 回读：让「写进去的」和「以为写进去的」对得上
const back = JSON.parse(readFileSync(CONFIG, 'utf8')).localModel
console.log(`  ${CONFIG}`)
for (const [key, value] of Object.entries(back)) {
  console.log(`    ${key.padEnd(16)} ${JSON.stringify(value)}`)
}
console.log('')
console.log(`  modelPath 指向的文件存在：${existsSync(back.modelPath)}`)
console.log(`  llama-server：${back.serverPath ?? '（没找到，会用兜底搜索）'}`)
console.log(`  llama-server 存在：${back.serverPath === undefined ? '-' : existsSync(back.serverPath)}`)
