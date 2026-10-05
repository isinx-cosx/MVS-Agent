import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const buf = readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
let at = buf.indexOf(magic, 0)
while (at >= 0) {
  offsets.push(at)
  at = buf.indexOf(magic, at + 4)
}
console.log('文件', buf.length, '字节；候选 frame 起点', offsets.length)
let ok = 0
let bytes = 0
const outs = []
for (let i = 0; i < offsets.length; i += 1) {
  const slice = buf.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buf.length)
  try {
    const out = zstdDecompressSync(slice)
    ok += 1
    bytes += out.length
    outs.push(out)
  } catch (e) {
    // 假起点（压缩数据里偶然出现的魔数）
  }
}
console.log('可解 frame', ok, '总解压', bytes, '字节')
const text = Buffer.concat(outs).toString('utf8')
console.log('换行数', (text.match(/\n/g) ?? []).length)
console.log(text.slice(0, 1200))
