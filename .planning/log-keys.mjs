/**
 * 只打印每条事件信封的**键**和 data 的**键**（不打印内容），
 * 用来确认 surfaceOp / sourceEventSeqs / id / source 这些字段到底在不在。
 *
 * 用法：node .planning/log-keys.mjs <日志文件> [事件类型前缀...]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const [file, ...only] = process.argv.slice(2)

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
      /* 假起点 */
    }
  }
  return Buffer.concat(outs).toString('utf8')
}

const seen = new Map()
for (const line of readLog(file).split('\n')) {
  if (line.trim() === '') continue
  let row
  try {
    row = JSON.parse(line)
  } catch {
    continue
  }
  const ev = row.event ?? row
  const type = ev?.type ?? '?'
  if (only.length > 0 && !only.some((p) => type.startsWith(p))) continue
  if (seen.has(type)) continue
  seen.set(type, true)
  const dataKeys = ev?.data !== null && typeof ev?.data === 'object' ? Object.keys(ev.data) : typeof ev?.data
  console.log(`${type}`)
  console.log(`   信封键: ${JSON.stringify(Object.keys(ev))}`)
  console.log(`   data 键: ${JSON.stringify(dataKeys)}`)
  if (type === 'user/message') console.log(`   content 块: ${JSON.stringify((ev.data.content ?? []).map((b) => Object.keys(b)))}`)
  if (type === 'assistant/message') {
    console.log(`   message 键: ${JSON.stringify(Object.keys(ev.data.message ?? {}))}`)
    console.log(`   content 块: ${JSON.stringify((ev.data.message?.content ?? []).map((b) => ({ keys: Object.keys(b), type: b.type })))}`)
    console.log(`   stream 条数: ${(ev.data.stream ?? []).length}; stream[0] 键: ${JSON.stringify(Object.keys((ev.data.stream ?? [])[0] ?? {}))}`)
  }
}
