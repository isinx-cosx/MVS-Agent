/**
 * 原子写：临时文件 → fsync → rename。
 *
 * 放在这里而不是 host 里，是因为**配置层和会话层都要用**，
 * 而重复实现 fsync 顺序正是最容易各自漂移的那类代码。
 */

import { open, rename, rm } from 'node:fs/promises'

/**
 * 临时文件名里的计数器。
 *
 * ⚠️ **临时名必须逐次唯一，只带 pid 是不够的。**
 *
 * 这里踩过一次，代价是整个守护进程退出：同一个进程里两次**并发**写同一个目标
 * 时，两边算出的是同一个临时路径。第一个 rename 把它移走了，第二个去 rename 时
 * 源已经不存在 —— `ENOENT`。
 *
 * 而并发是真实发生的：界面选中一个会话时，WS 上的 `watch`（服务端要
 * `ensureSession`）和 HTTP 的 `/projection`（也要 `ensureSession`）是同一瞬间
 * 发出的两条路，于是同一个会话会被加载两次、写两次检查点。
 */
let counter = 0

export async function writeFileAtomic(target: string, data: string): Promise<void> {
  const tmp = `${target}.tmp-${process.pid}-${counter++}`
  const handle = await open(tmp, 'w')
  try {
    await handle.writeFile(data, 'utf8')
    // ★ fsync 不能省：崩溃正好发生在写的中间，文件就是半个 JSON。
    // 那比没有文件更糟 —— 你会以为状态损坏了，实际它只是不确定的。
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await renameWithRetry(tmp, target)
  } catch (err) {
    // 失败时把临时文件收掉，别在用户的配置目录里留一地 .tmp-*
    await rm(tmp, { force: true })
    throw err
  }
}

async function renameWithRetry(from: string, to: string, attempts = 5): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      // Windows 上目标被占用时会 EBUSY / EPERM（杀毒、索引器都可能占用）
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 20 * (i + 1)))
    }
  }
  throw lastError
}
