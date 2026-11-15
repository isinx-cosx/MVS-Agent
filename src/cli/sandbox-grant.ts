/**
 * 一次性授权：让断网沙箱**能读任何地方、只能写工作区**。
 *
 *     npm run sandbox:grant -- <工作区>...        # 工作区可写，用户目录可读
 *     npm run sandbox:grant -- --remove <工作区>  # 撤销
 *
 * ## 为什么单独一个命令
 *
 * 授权要递归到成千上万个文件（`%USERPROFILE%` 一次要跑几十秒），
 * 放在每条命令前面会让每次执行都卡住 —— 实测 15 秒超时，然后被记成"授权失败"。
 * 所以：**一次性做完，之后每条命令只授权工作区那一个目录**（毫秒级）。
 *
 * ## 为什么读给整个用户目录
 *
 * 读是刻意不设限的：工具链要读的东西本来就在工作区外（`~/.npmrc`、`~/.gitconfig`、
 * 包缓存、System32 的 dll…）。挡住读只会让沙箱不可用。
 *
 * 挡泄密靠的不是"读不到"，而是：网络被 AppContainer 切断 + 读出的内容进上下文前
 * 过输出审核（打码 / 扣留 / taint）。
 */

import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import process from 'node:process'

const APP_PACKAGES_SID = 'S-1-15-2-1'

const argv = process.argv.slice(2)
const remove = argv.includes('--remove')
const workspaces = argv.filter((item) => !item.startsWith('--'))

if (workspaces.length === 0) {
  process.stderr.write('用法：npm run sandbox:grant -- <工作区>... [--remove]\n')
  process.exitCode = 2
} else {
  /**
   * 授权项。
   *
   * `M` = 修改（读 + 写 + 删），`RX` = 读 + 执行。
   * 工作区与临时目录给 `M`（工具要写），用户目录只给 `RX`（读得到、改不了）。
   */
  const targets: Array<{ path: string; rights: 'M' | 'RX' }> = [
    ...workspaces.map((item) => ({ path: item, rights: 'M' as const })),
    { path: tmpdir(), rights: 'M' as const },
    ...(process.env.USERPROFILE === undefined
      ? []
      : [{ path: process.env.USERPROFILE, rights: 'RX' as const }]),
  ]

  let failed = 0
  for (const target of targets) {
    const spec = `*${APP_PACKAGES_SID}:${remove ? '' : `(OI)(CI)${target.rights}`}`
    const args = remove
      ? [target.path, '/remove', `*${APP_PACKAGES_SID}`]
      : [target.path, '/grant', spec]
    /*
     * 超时给足 120 秒：`%USERPROFILE%` 递归要几十秒，15 秒会被记成失败 ——
     * 那是我第一版踩的坑（看起来"授权失败"，实际是超时）。
     */
    /*
     * `/C` 让 icacls 遇到个别无权限的子项继续跑（用户目录里总有这种），
     * `/Q` 少打日志。退出码不可靠，所以失败时再**查一次 ACE 是否真的在**。
     */
    const probe = spawnSync('icacls', [...args, '/C', '/Q'], { stdio: 'ignore', windowsHide: true, timeout: 120_000 })
    let ok = probe.status === 0
    if (!ok && !remove) {
      const check = spawnSync('icacls', [target.path], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
      ok = typeof check.stdout === 'string' && check.stdout.includes(APP_PACKAGES_SID)
    }
    if (!ok) failed += 1
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${remove ? '移除' : '授权'} ${target.path}（${target.rights}）\n`)
  }

  process.stdout.write(
    failed === 0
      ? `\n完成：工作区可写、临时目录可写、用户目录只读。\n`
      : `\n${failed} 个路径失败 —— 见上面每一行。\n`,
  )
  process.exitCode = failed === 0 ? 0 : 1
}
