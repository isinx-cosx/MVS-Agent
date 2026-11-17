/**
 * 查我们**自己**那个 AppContainer profile 的 SID。
 *
 * ## 为什么要换成专属 SID
 *
 * 授权一直用的是 `S-1-15-2-1`（**ALL APPLICATION PACKAGES**）—— 也就是**任何**
 * AppContainer（包括商店应用）都能拿到工作区那条 ACE。为了"只给自己的沙箱"，
 * 需要用 profile 自己的 SID。
 *
 * ## 为什么不是算出来的
 *
 * 我按文档实现过 SHA-256 推导（名字大写 → UTF-16LE → 前 6 个 uint32，0 换 1），
 * 结果**与本机注册表里实际存在的 SID 对不上** —— 所以那条路没被采用。
 * 一个"可能算错"的 SID 比"范围偏大"危险得多：算错之后授权加在空气上，
 * 检查看起来一切正常，实际什么都没保护。
 *
 * ## 所以查注册表
 *
 * Windows 会为每个存在的 profile 在下面这棵键里写一条映射：
 *
 * ```
 * HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\
 *   AppContainer\Mappings\<SID>  →  Moniker = <profile 名>
 * ```
 *
 * 这是**操作系统自己写的**，不需要推导、也不会错。
 */

import { execFileSync } from 'node:child_process'

const MAPPINGS_KEY = String.raw`HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppContainer\Mappings`

/**
 * 按 profile 名查 SID。
 *
 * 返回 `undefined` 表示"这个 profile 还不存在"（第一次跑之前是正常的），
 * 调用方应退回到范围更大的 SID 并**说明**这一点，而不是假装拿到了。
 */
export function lookupProfileSid(profileName: string): string | undefined {
  if (process.platform !== 'win32') return undefined
  let output: string
  try {
    output = execFileSync('reg', ['query', MAPPINGS_KEY, '/s', '/v', 'Moniker'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20_000,
    })
  } catch {
    return undefined
  }

  const wanted = profileName.toLowerCase()
  for (const block of output.split(/\r?\n\r?\n/)) {
    const sid = /Mappings\\(S-1-15-2-[\d-]+)/.exec(block)?.[1]
    if (sid === undefined) continue
    const moniker = /Moniker\s+REG_SZ\s+(.+)/.exec(block)?.[1]?.trim().toLowerCase()
    if (moniker === wanted) return sid
  }
  return undefined
}
