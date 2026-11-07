/**
 * 给工作区打 / 撤 Low 完整性标签。
 *
 *     npm run sandbox:label -- <目录>…          # 打 Low
 *     npm run sandbox:label -- --remove <目录>… # 恢复 Medium
 *     npm run sandbox:label -- --check <目录>…  # 只读当前标签
 *
 * 为什么要这个命令而不是"守护进程自己悄悄打"：**打标签改的是用户的目录**。
 * 让人能自己看见、自己撤销，比"默认帮你改"重要。
 */

import process from 'node:process'

import { integrityOf, labelLow, unlabelLow } from '../sandbox/label.ts'

const argv = process.argv.slice(2)
const remove = argv.includes('--remove')
const check = argv.includes('--check')
const paths = argv.filter((item) => !item.startsWith('--'))

if (paths.length === 0) {
  process.stderr.write(
    '用法：npm run sandbox:label -- <目录>…\n' +
      '      --remove  恢复 Medium（撤销）\n' +
      '      --check   只读当前标签\n',
  )
  process.exitCode = 2
} else if (check) {
  for (const target of paths) {
    const level = integrityOf(target)
    process.stdout.write(`${target}：${level ?? '读不到（路径不存在或没有标签）'}\n`)
  }
} else {
  const result = remove ? unlabelLow(paths) : labelLow(paths)
  process.stdout.write(`${result.message}\n`)
  process.exitCode = result.ok ? 0 : 1
}
