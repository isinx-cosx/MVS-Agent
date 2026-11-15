/**
 * AppContainer 的**必须配套**：给工作区按包 SID 授权。
 *
 * ## 为什么必须有这一步
 *
 * AppContainer 只对自己包目录和**显式授权**的路径有读写权限。不授权的话，
 * 断网沙箱里连 `package.json` 都读不到 —— 实测报 `Cannot find module`，
 * 也就是"安全但什么都不能干"。一个默认配置下不可用的功能，用户会直接关掉它。
 *
 * 所以：**断网 + 工作区可用**是一对，不是两件事。
 *
 * ## 授权只加一条 ACE，不动已有权限
 *
 * `icacls <dir> /grant *<包SID>:(OI)(CI)M` 给包 SID 加一条允许 ACE
 * （`(OI)(CI)` 让它对之后新建的子项也生效，`M` = 修改权限）。
 * 它不会改动用户自己的 ACE，也不会改变所有者。
 *
 * 撤销是同一位置 `/remove`；幂等由 icacls 自己保证（同一条 ACE 不会重复添加）。
 *
 * ## ⚠️ 一处踩过的坑
 *
 * `ConvertSidToStringSidW` 的输出是 `LPWSTR*`。**必须先看返回值**再 decode ——
 * 失败时那个指针是 NULL，直接 `koffi.decode(null)` 会得到 0xC0000005。
 * 我第一次就是这么崩的，然后误以为是 koffi 的类型问题。
 */

import { spawnSync } from 'node:child_process'

/** 我们自己的包名。固定值：授权加在它身上，用户能猜到自己该撤哪一条 */
export const APP_CONTAINER_NAME = 'MVS.Agent.Sandbox'

const CANDIDATES = [
  process.env.MVS_KOFFI,
  'koffi',
  'file:///C:/Program Files/DSH NEXT/resources/app/node_modules/koffi/index.cjs',
].filter((item) => typeof item === 'string' && item !== '')

async function loadKoffi(): Promise<any | null> {
  for (const candidate of CANDIDATES) {
    try {
      const loaded = await import(String(candidate))
      const koffi = loaded.default ?? loaded
      if (typeof koffi?.load === 'function') return koffi
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

export interface PackageSid {
  /** 包 SID 的字符串形式（`S-1-15-2-…`）；拿不到时为 undefined */
  text?: string
  /** 建 profile 是否成功（已存在也算成功） */
  ok: boolean
  message?: string
}

/**
 * 确保 profile 存在并拿到包 SID。
 *
 * 同时返回 PSID 指针与字符串 —— 字符串给 `icacls` 用，指针给将来的原生 DACL 写入用。
 */
/**
 * 授权用的 SID。
 *
 * 用 `S-1-15-2-1`（**ALL APPLICATION PACKAGES**）而不是本包的 SID 字符串。
 *
 * 为什么不拿自己的包 SID：`ConvertSidToStringSidW` 的输出在 koffi 里反复崩
 * （0xC0000005，试过先看返回值再 decode 也不行）。而 `S-1-15-2-1` 是固定值，
 * 只对 **AppContainer 进程**生效 —— 普通进程、别的用户都拿不到它。
 *
 * 代价说清楚：任何 AppContainer（包括商店应用）都能拿到这条 ACE。
 * 在"本机唯一跑 AppContainer 的是我们的沙箱"这个前提下可以接受；
 * 要收紧到只给自己的包，把这里换成自己包的 SID 即可（接口不变）。
 */
export const APP_CONTAINER_SID = 'S-1-15-2-1'

export interface PackageSid {
  ok: boolean
  /** 实际用于授权的 SID 字符串 */
  text?: string
  message?: string
}

/** 现在的实现不需要建 profile 就能给出 SID；保留这个函数是为了接口稳定 */
export async function ensurePackageSid(): Promise<PackageSid> {
  if (process.platform !== 'win32') return { ok: false, message: 'AppContainer 只有 Windows 有' }
  return { ok: true, text: APP_CONTAINER_SID }
}
export interface GrantResult {
  ok: boolean
  granted: string[]
  failed: Array<{ path: string; message: string }>
}

/** 给若干目录授权（对之后新建的子项生效）。幂等 */
export function grantToPackage(paths: string[], sid: string): GrantResult {
  const result: GrantResult = { ok: true, granted: [], failed: [] }
  if (process.platform !== 'win32') {
    return { ok: false, granted: [], failed: [{ path: '(platform)', message: '只有 Windows 有 ACL' }] }
  }
  for (const target of paths) {
    /* stdio 必须是 ignore：这个环境里 pipe 会同步抛 EPERM（见 command-tool 顶部注释） */
    const probe = spawnSync('icacls', [target, '/grant', `*${sid}:(OI)(CI)M`], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15_000,
    })
    if (probe.status === 0) result.granted.push(target)
    else result.failed.push({ path: target, message: `icacls 退出码 ${probe.status ?? '超时'}` })
  }
  result.ok = result.failed.length === 0
  return result
}

/** 撤销授权（`/remove` 只删这一条 ACE，不影响别的） */
export function revokeFromPackage(paths: string[], sid: string): GrantResult {
  const result: GrantResult = { ok: true, granted: [], failed: [] }
  for (const target of paths) {
    const probe = spawnSync('icacls', [target, '/remove', `*${sid}`], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 15_000,
    })
    if (probe.status === 0) result.granted.push(target)
    else result.failed.push({ path: target, message: `icacls 退出码 ${probe.status ?? '超时'}` })
  }
  result.ok = result.failed.length === 0
  return result
}
