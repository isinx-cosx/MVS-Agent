import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
console.log('原始长度', text.length, '换行数', (text.match(/\n/g) ?? []).length)
console.log(text.slice(0, 3000))
