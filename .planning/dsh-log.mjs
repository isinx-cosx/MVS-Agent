/**
 * 读一份 DSH 的 session.v4.jsonl.zstd 原始日志。
 *
 * ⚠️ 这类文件是**追加写**的 zstd：盘上是**很多个独立 frame 串联**，
 * 每个 frame 就是一次追加。`zstdDecompressSync(整个文件)` 只解第一个 frame
 * （实测 187 KB 的文件只出来 301 字节，正好是那行 session 头），
 * `createZstdDecompress()` 流也一样只解第一个 frame。所以必须按魔数切开逐帧解。
 *
 * 用途：拿 `user/message` / `assistant/message` / `tool/result` 的**运行时真实形状**。
 *
 * 用法：node .planning/dsh-log.mjs <日志文件> [事件类型前缀...] [--limit N]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [file, ...rest] = process.argv.slice(2)
const limitAt = rest.indexOf('--limit')
const limit = limitAt < 0 ? 2 : Number(rest[limitAt + 1])
const only = (limitAt < 0 ? rest : rest.slice(0, limitAt)).filter((s) => !s.startsWith('--'))

function readLog(path) {
  const buf = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let at = buf.indexOf(magic, 0)
  while (at >= 0) {
    offsets.push(at)
    at = buf.indexOf(magic, at + 4)
  }
  const outs = []
  for (let i = 0; i < offsets.length; i += 1) {
    const slice = buf.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buf.length)
    try {
      outs.push(zstdDecompressSync(slice))
    } catch {
      // 压缩数据里偶然出现的魔数 —— 跳过
    }
  }
  return Buffer.concat(outs).toString('utf8')
}

const text = readLog(file)
const lines = text.split('\n').filter((l) => l.trim() !== '')
console.error(`解压后 ${text.length} 字节 / ${lines.length} 行`)

const counts = new Map()
const shown = new Map()
for (const line of lines) {
  let row
  try {
    row = JSON.parse(line)
  } catch {
    continue
  }
  const ev = row.event ?? row
  const type = ev?.type ?? '?'
  counts.set(type, (counts.get(type) ?? 0) + 1)
  if (only.length > 0 && !only.some((p) => type.startsWith(p))) continue
  const n = shown.get(type) ?? 0
  if (n >= limit) continue
  shown.set(type, n + 1)
  console.log(`\n===== ${type} (seq=${ev?.seq}) =====`)
  console.log(JSON.stringify(ev, null, 2))
}

console.log('\n===== 事件类型统计 =====')
for (const [type, n] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(6)}  ${type}`)
