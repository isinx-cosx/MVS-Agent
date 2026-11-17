/**
 * 一次性确认码：给**非交互模式**（CLI）留一个 look-once 的出口。
 *
 * ## 为什么要它
 *
 * `revealSensitive` 现在必须人工批准 —— 但批准只在交互界面里存在。
 * CLI 用户等于没有出口：想看一次 `.env` 只能自己去编辑器开，然后重开会话。
 *
 * ## 设计
 *
 * 用户在**终端里**执行 `npm run reveal:code`，拿到 6 位码；把码作为
 * `revealSensitive` 的值传给工具。码满足三条：
 *
 *   · **一次性**：用过就删
 *   · **短命**：5 分钟过期
 *   · **只存哈希**：磁盘上看不到码本身，看到的是 sha256
 *
 * 这不是"把审批自动化"，而是"把人的动作搬到终端"：码只有能读那个终端的人拿得到，
 * 而且每次都要重新拿。
 */

import { createHash, randomInt } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

const TTL_MS = 5 * 60 * 1000

interface Record_ {
  hash: string
  expiresAt: string
}

function fileOf(root: string): string {
  return path.join(root, '.mvs', 'reveal-code.json')
}

function hashOf(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/** 生成并保存一个新码（覆盖旧的：同一时刻只该有一个有效码） */
export async function issueRevealCode(root: string): Promise<{ code: string; expiresAt: string }> {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString()
  const file = fileOf(root)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ hash: hashOf(code), expiresAt } satisfies Record_, null, 2)}\n`, 'utf8')
  return { code, expiresAt }
}

/**
 * 校验并**消费**一个码。
 *
 * 无论成功与否都会删掉文件 —— 失败时删除是刻意的：猜错一次就让码失效，
 * 避免对着同一个码暴力枚举。
 */
export async function consumeRevealCode(root: string, code: string): Promise<boolean> {
  const file = fileOf(root)
  let record: Record_
  try {
    record = JSON.parse(await readFile(file, 'utf8')) as Record_
  } catch {
    return false
  }
  const ok = record.hash === hashOf(code) && Date.parse(record.expiresAt) > Date.now()
  await unlink(file).catch(() => {})
  return ok
}
