/**
 * 生成一次性确认码。
 *
 *     npm run reveal:code
 *
 * 码 5 分钟过期、只能用一次、磁盘上只留哈希。用法：把它作为
 * `revealSensitive` 的值传给 `read_file`，非交互模式下就会被接受。
 */

import process from 'node:process'

import { issueRevealCode } from '../guard/reveal-code.ts'

const root = process.argv[2] ?? process.cwd()
const { code, expiresAt } = await issueRevealCode(root)

process.stdout.write(
  `一次性确认码：${code}\n` +
    `有效期至 ${expiresAt}（5 分钟），只能用一次。\n\n` +
    `把它作为 revealSensitive 的值传给 read_file，例如：\n` +
    `  {"path": ".env", "revealSensitive": "${code}"}\n`,
)
