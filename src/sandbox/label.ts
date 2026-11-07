/**
 * 给目录打 **Low 完整性标签** —— 沙箱要能默认打开，就差这一步。
 *
 * ## 为什么必须做
 *
 * Low 完整性进程只能写 Low 标签的目录（这是它挡住的机制）。所以"打开沙箱"和
 * "工作区可写"是同一件事的两面：**不label，构建就写不进去**。
 *
 * ## 为什么用 `icacls` 而不是原生 API
 *
 * `icacls <dir> /setintegritylevel (OI)(CI)Low` 就是这一步的标准做法，而且
 * **不改变已有的访问控制** —— 它只加一个完整性标签（一条 `Mandatory Label`
 * 的 ACE），DACL 原封不动。实测非管理员对自己目录可以设（见 docs/沙箱替代方案.md E1）。
 *
 * 用原生 `SetNamedSecurityInfo` 也能做，但那要写几十行结构体编组，换来的是同一件事。
 * 这条命令是 Windows 自带工具，行为可复核（`icacls` 输出的就是真实状态）。
 *
 * ## ⚠️ 一处必须说清的地方
 *
 * 打标签**改的是用户的目录**。所以：
 *
 * · 只在 `MVS_SANDBOX=low-il` 打开时做，不偷偷做
 * · 结果（成功/失败/为什么）要能被看见，不能静默跳过
 * · 提供撤销：`Medium` 就是"恢复默认"
 */

import { spawnSync } from 'node:child_process'

export interface LabelResult {
  ok: boolean
  /** 人话说明，成功与失败都有 */
  message: string
}

/**
 * 给一个或多个目录打 Low 完整性标签（对本目录及之后新建的子项生效）。
 *
 * `(OI)(CI)` 是关键：不加的话只有目录本身是 Low，里面新建的文件不是 ——
 * 结果就是"能建文件、建完写不进去"，那种现象很难查。
 */
export function labelLow(paths: string[]): LabelResult {
  if (process.platform !== 'win32') {
    return { ok: false, message: '完整性标签只有 Windows 有' }
  }
  const failures: string[] = []
  for (const target of paths) {
    /* stdio 必须是 ignore：这个环境里 pipe 会同步抛 EPERM（见 command-tool 顶部注释） */
    const probe = spawnSync('icacls', [target, '/setintegritylevel', '(OI)(CI)Low'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    })
    if (probe.status !== 0) {
      failures.push(`${target}（icacls 退出码 ${probe.status ?? '超时'}）`)
    }
  }
  if (failures.length > 0) {
    return {
      ok: false,
      message:
        `没能给这些路径打 Low 标签：${failures.join('、')}。` +
        '沙箱打开后这些目录里的写入会被拒绝 —— 要么手动执行 ' +
        '`icacls <dir> /setintegritylevel (OI)(CI)Low`，要么先关掉 MVS_SANDBOX。',
    }
  }
  return { ok: true, message: `已给 ${paths.length} 个路径打上 Low 完整性标签（含子项）` }
}

/** 撤销：把完整性级别设回 Medium（Windows 的默认） */
export function unlabelLow(paths: string[]): LabelResult {
  if (process.platform !== 'win32') {
    return { ok: false, message: '完整性标签只有 Windows 有' }
  }
  const failures: string[] = []
  for (const target of paths) {
    const probe = spawnSync('icacls', [target, '/setintegritylevel', '(OI)(CI)Medium'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10_000,
    })
    if (probe.status !== 0) failures.push(target)
  }
  return failures.length === 0
    ? { ok: true, message: `已把 ${paths.length} 个路径恢复成 Medium` }
    : { ok: false, message: `没能恢复：${failures.join('、')}` }
}

/**
 * 读当前标签（给人看的字符串，例如 `Low` / `Medium`）。
 *
 * 用 `icacls` 的文本输出解析 —— 它就是这个状态的**权威呈现**；
 * 单独查 API 还要再写一遍结构体，而结果未必更好读。
 */
export function integrityOf(target: string): string | undefined {
  if (process.platform !== 'win32') return undefined
  const probe = spawnSync('icacls', [target], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  })
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return undefined
  const match = /Mandatory Label\\(Low|Medium|High|System)/i.exec(probe.stdout)
  return match?.[1]
}
