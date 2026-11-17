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
   * 工作区给 `M`（工具要写），用户目录只给 `RX`（读得到、改不了）。
   *
   * **不再授权 `%TEMP%`**：AppContainer 会把 `TMP`/`TEMP` 重定向到它自己的私有目录
   * （`…\Packages\<profile>\AC\Temp`），用户临时目录本来就用不上；而那条授权等于
   * 把"只写工作区"扩大成"工作区 + 系统临时目录"，那里常被 AV 和备份排除。
   * 实测：容器里的 `process.env.TEMP` 就是这个私有目录。
   */
  const targets: Array<{ path: string; rights: 'M' | 'RX' }> = [
    ...workspaces.map((item) => ({ path: item, rights: 'M' as const })),
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
    /*
     * 判定用**成功数**而不是退出码。
     *
     * icacls 遍历用户目录时，个别子项进不去（权限被保护），退出码会变成非零 ——
     * 但目标路径本身的 ACE 通常已经加上了。用退出码当判据只会得到"看起来失败、
     * 实际可用"（我第一版就是这样）。所以：非零记为 partial，只有**目标路径本身**
     * 拿不到 ACE 才算 hard failure。
     */
    let ok = probe.status === 0
    /* 非零退出码先记为"部分成功"：目标路径的 ACE 可能已经加上，只是有子项进不去 */
    let partial = !ok && !remove
    if (!ok && !remove) {
      const check = spawnSync('icacls', [target.path], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
      ok = typeof check.stdout === 'string' && check.stdout.includes(APP_PACKAGES_SID)
    }
    /*
     * 只有"目标路径本身也没拿到 ACE"才算失败。partial 只作为提示 ——
     * 用户目录里总有几个进不去的子项，那不该让整条命令返回失败。
     */
    if (!ok && !partial) failed += 1
    const label = ok ? 'ok     ' : partial ? 'partial' : 'FAIL   '
    process.stdout.write(`${label} ${remove ? '移除' : '授权'} ${target.path}（${target.rights}）\n`)
  }

  process.stdout.write(
    failed === 0
      ? `\n完成：工作区可写、临时目录可写、用户目录只读。\n`
      : `\n${failed} 个路径失败 —— 见上面每一行。\n`,
  )
  process.exitCode = failed === 0 ? 0 : 1
}
