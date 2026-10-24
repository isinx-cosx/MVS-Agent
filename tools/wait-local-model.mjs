/**
 * 轮询本地模型状态直到就绪（或超时）。
 *
 * 单独写个脚本而不是 `node -e`：要打印的东西里有中文和引号，
 * 走 shell 会被吃掉（今天已经栽过好几次）。
 *
 * 用法：node tools/wait-local-model.mjs [超时秒数]
 */

const timeoutSec = Number(process.argv[2] ?? 180)
const deadline = Date.now() + timeoutSec * 1000

let last = ''
for (;;) {
  let status
  try {
    status = await (await fetch('http://127.0.0.1:3092/local-model')).json()
  } catch (err) {
    console.log(` 问不到守护进程：${err.message}`)
    process.exit(1)
  }

  const line = `${status.state}  ${status.detail}${status.error === undefined ? '' : `  [${status.error}]`}`
  if (line !== last) {
    const elapsed = Math.round((Date.now() - (deadline - timeoutSec * 1000)) / 1000)
    console.log(`  ${String(elapsed).padStart(4)}s  ${line}`)
    last = line
  }

  if (status.state === 'ready' || status.state === 'failed' || status.state === 'external') {
    console.log('')
    console.log(`  最终：${status.state}`)
    if (status.ctxSize !== undefined) console.log(`  窗口：${status.ctxSize}`)
    process.exit(status.state === 'ready' ? 0 : 1)
  }

  if (Date.now() > deadline) {
    console.log('')
    console.log(`  ⏱ 超过 ${timeoutSec} 秒还没就绪 —— 状态停在「${status.state}」`)
    process.exit(1)
  }

  await new Promise((r) => setTimeout(r, 2000))
}
