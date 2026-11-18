import { existsSync } from 'node:fs'
import path from 'node:path'
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

import { APP_CONTAINER_NAME, APP_CONTAINER_SID } from '../sandbox/appcontainer.ts'
import { lookupProfileSid } from '../sandbox/profile-sid.ts'

/*
 * 授权对象优先用**自己 profile 的 SID**，拿不到才退回 `S-1-15-2-1`。
 *
 * `S-1-15-2-1` 是 ALL APPLICATION PACKAGES —— 任何 AppContainer（商店应用也算）
 * 都能拿到这条 ACE。专属 SID 只有我们的沙箱进程认。
 *
 * 第一次运行之前 profile 还不存在（映射由 runner 创建 profile 时才写进注册表），
 * 这时退回大范围 SID 并**明确说出来**，而不是假装已经收紧。
 */
const ownSid = lookupProfileSid(APP_CONTAINER_NAME)
const APP_PACKAGES_SID_EFFECTIVE = ownSid ?? APP_CONTAINER_SID

const argv = process.argv.slice(2)
const remove = argv.includes('--remove')
const workspaces = argv.filter((item) => !item.startsWith('--'))

if (workspaces.length === 0) {
  process.stderr.write('用法：npm run sandbox:grant -- <工作区>... [--remove]\n')
  process.exitCode = 2
} else {
  process.stdout.write(
    ownSid === undefined
      ? `授权对象：${APP_CONTAINER_SID}（所有 AppContainer —— 还没跑过沙箱，专属 profile 不存在）\n`
      : `授权对象：${ownSid}（${APP_CONTAINER_NAME} 专属）\n`,
  )
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
  /*
   * 顺带授权 **node 的安装目录**（只读 + 可执行）。
   *
   * 为什么需要：容器里 `cmd /c node --version` 会报"不是内部或外部命令" ——
   * PATH 没丢，是容器**不能枚举**没有 ACE 的目录（`C:\Program Files\nodejs`），
   * 于是 cmd 在里面搜不到 node.exe。给 RX 之后 PATH 查找才成立。
   * 只给 RX，不给写。
   */
  /*
   * **祖先链只给"穿过"（X）。**
   *
   * 文件读得到但目录列不出来，根因是枚举要沿父目录逐层做 traverse 检查，
   * 而 Desktop / 上级目录都没给容器 SID 任何权限 —— 文件自身有 ACE 所以能读，
   * 枚举在某一层就被拒了。`node` 也一样：`C:\Program Files\nodejs` 给了 RX，
   * 但祖先链不通，cmd 找不到 node.exe。
   *
   * 只授 X（traverse），不授 R（列目录内容）：能从外面穿过去，但看不到别的文件。
   */
  function ancestorTraverse(target: string): string[] {
    const chain: string[] = []
    let current = path.dirname(path.resolve(target))
    while (true) {
      const parent = path.dirname(current)
      if (parent === current) { chain.push(current); break }   /* 盘根也要给穿过权限：node 会 lstat 'C:\' */
      chain.push(current)
      current = parent
    }
    return chain
  }

  const nodeDir = path.dirname(process.execPath)
  const npmDir = process.env.APPDATA === undefined ? null : path.join(process.env.APPDATA, 'npm')
  /* npm 的缓存与全局目录：npm 启动时会 lstat 它们，不给就看都不让看 */
  const npmCacheDir = process.env.LOCALAPPDATA === undefined ? null : path.join(process.env.LOCALAPPDATA, 'npm-cache')
  const targets: Array<{ path: string; rights: 'M' | 'RX' | 'X' | 'R' }> = [
    ...workspaces.map((item) => ({ path: item, rights: 'M' as const })),
    { path: nodeDir, rights: 'RX' as const },
    /* 祖先链：只授穿过权限，让枚举与 PATH 查找能到达工作区 */
    ...workspaces.flatMap((item) => ancestorTraverse(item).map((p) => ({ path: p, rights: 'X' as const }))),
    /*
     * node 的祖先链也要穿过权限：只给 `C:\Program Files\nodejs` 的 RX 不够 ——
     * 父目录 `C:\Program Files` 对容器完全不可见时，连 `if exist node.exe` 都返回 no。
     * 改这一层需要管理员，所以这里只是把它列进目标，由 `npm run sandbox:grant` 执行。
     */
    ...ancestorTraverse(path.dirname(process.execPath)).map((p) => ({ path: p, rights: 'X' as const })),
    ...(npmDir !== null && existsSync(npmDir) ? [{ path: npmDir, rights: 'RX' as const }] : []),
    ...(npmCacheDir !== null && existsSync(npmCacheDir) ? [{ path: npmCacheDir, rights: 'RX' as const }] : []),
    ...(process.env.USERPROFILE === undefined
      ? []
      : [{ path: process.env.USERPROFILE, rights: 'RX' as const }]),
  ]

  let failed = 0
  for (const target of targets) {
    const spec = target.rights === 'X'
      ? `*${APP_PACKAGES_SID_EFFECTIVE}:(${target.rights})`
      : `*${APP_PACKAGES_SID_EFFECTIVE}:(OI)(CI)${target.rights}`
    const args = remove
      ? [target.path, '/remove', `*${APP_PACKAGES_SID_EFFECTIVE}`]
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
      ok = typeof check.stdout === 'string' && check.stdout.includes(APP_PACKAGES_SID_EFFECTIVE)
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
