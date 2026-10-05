/**
 * 守护进程令牌的**持久化**。
 *
 * ## 为什么要有这个文件
 *
 * 原来令牌是构造 `HostServer` 时随机生成的 —— 于是**每次重启都换一个**，
 * 而带令牌的链接和已经发出去的 cookie 全部作废。
 *
 * 表现是：「链接贴出去，重启一次就打不开了」「换个窗口就要重新拿令牌」。
 * 而这不是「本地服务需要令牌」的必然结果 —— DSH 也用令牌
 * （`?token=` 换签名 cookie），但它的令牌**按进程属主缓存**，服务重启不换，
 * 所以日常用起来感觉不到它存在。
 *
 * 这个模块就是补上那一块：**令牌生成一次、存下来、以后复用。**
 *
 * ## 存哪儿、权限
 *
 * 放在 `defaultHomeDir()` 下（`MVS_HOME` 或 `~/.mvs-agent`），和配置同处。
 *
 * ⚠️ **`mode: 0o600` 在 Windows 上是个空操作** —— Windows 用 ACL，不用 POSIX
 * 权限位；Node 不会报错，但文件实际的 mode 会显示成 `666`。我第一版注释里
 * 直接写了「权限 0600」，那是**错的**，实测 `icacls` 才对：
 *
 *     NT AUTHORITY\SYSTEM        (F)
 *     BUILTIN\Administrators     (F)
 *     <当前用户>                  (F)
 *
 * 也就是说只有 SYSTEM、管理员、和本人能读 —— **别的普通用户读不到**。
 * 但这是 `%USERPROFILE%` 继承下来的 ACL 给的，不是这行 `mode` 给的。
 *
 * 所以：`mode` 保留（POSIX 上真有用，Windows 上无害），但**别把安全性
 * 记在它头上**。真正的边界是「文件放在用户 profile 里」这件事。
 *
 * ⚠️ 明文存盘是**有意的**：它要能在重启后复用，就必然要被读回来。
 * 想「加密存」是自欺 —— 解密所需的密钥也得放同一个地方。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

/** 24 字节 → 48 个十六进制字符。和原来的长度一致，不改变任何下游假设 */
const TOKEN_BYTES = 24
const TOKEN_PATTERN = /^[0-9a-f]{48}$/

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

export interface LoadedToken {
  token: string
  /** 这次是不是新建的（首次运行 / 文件损坏 / 内容非法） */
  created: boolean
  /** 读到了内容但不合法，于是重新生成 —— 调用方值得把它说出来 */
  replaced?: string
}

/**
 * 读令牌；没有、读不动、或者内容不合法就生成一个并写回去。
 *
 * **任何读取失败都不抛异常**：令牌拿不到就生成一个新的，服务照常起来。
 * 一个坏掉的令牌文件不该让整个守护进程起不来 —— 那比「换了个令牌」严重得多。
 *
 * @param file - 令牌文件路径
 */
export function loadOrCreateToken(file: string): LoadedToken {
  let existing: string | undefined
  try {
    if (existsSync(file)) existing = readFileSync(file, 'utf8').trim()
  } catch {
    // 读不动就当没有 —— 下面会重新生成
    existing = undefined
  }

  if (existing !== undefined && TOKEN_PATTERN.test(existing)) {
    return { token: existing, created: false }
  }

  const token = newToken()
  try {
    mkdirSync(dirname(file), { recursive: true })
    /*
     * `mode` 只在**新建**文件时生效，已存在的文件权限不会被改。
     * ⚠️ 而且它在 Windows 上是空操作 —— 见文件头的说明，别把安全性记在它头上。
     */
    writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  } catch {
    /*
     * 写不进去也**不抛**：这一次服务仍然能用（用内存里这个令牌），
     * 只是下次重启又会换一个。为了「能持久化」而拒绝启动是本末倒置。
     */
  }

  return {
    token,
    created: true,
    ...(existing === undefined ? {} : { replaced: existing }),
  }
}
