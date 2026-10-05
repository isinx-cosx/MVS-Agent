/**
 * 造一份「改之前」的垫片给 web/ 用，跑完探针再还原。
 *
 * 只摘掉这次为任务 2 加的两处（session/modelCatalog 分支、modelSelection 投影项），
 * 其余逐字不动 —— 这样"改之前"测出来的就是真实的前一版行为。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const real = readFileSync('tools/replica-shim.js', 'utf8')
let before = real

// 1. 摘掉 modelSelection 投影项那两行
const sel = `            // 模型铭牌读的就是这一项，见 modelSelectionValue 的长注释
            ...(selection === undefined ? {} : { modelSelection: selection }),
`
if (!before.includes(sel)) throw new Error('找不到 modelSelection 投影项')
before = before.replace(sel, '')

// 2. 摘掉 session/modelCatalog 分支
const at = before.indexOf("    if (method === 'session/modelCatalog') {")
const end = before.indexOf("    if (method === 'session/selectModel') {")
if (at < 0 || end < 0 || end < at) throw new Error('找不到 modelCatalog 分支')
before = before.slice(0, at) + before.slice(end)

writeFileSync('web/replica-shim.js', before, 'utf8')
console.log('已写出「改之前」的 web/replica-shim.js，字节', Buffer.byteLength(before, 'utf8'))
