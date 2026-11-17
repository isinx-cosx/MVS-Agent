/**
 * ADS 内容快照与恢复。
 *
 * 只报"有这个流"不够 —— 用户要知道里面是什么，事后要能写回去。
 * 这里验三件事：
 *   1. 能枚举出流（`secret`）
 *   2. 能读出内容，写回后内容一致
 *   3. 被覆盖之后能恢复成原内容（这就是 `npm run ads:restore` 做的事）
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { listStreams, readStream, writeStream } from '../src/recovery/ads.ts'

test('ADS：枚举、读出、写回（恢复路径）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mvs-adsrt-'))
  try {
    const file = path.join(root, 'a.txt')
    await writeFile(file, 'main', 'utf8')
    await writeFile(`${file}:secret`, 'hidden-bytes', 'utf8')

    const listing = await listStreams(file)
    if (!listing.available) {
      /* koffi 不可用（枚举需要它）：读内容这条路不依赖 FFI，仍然可以验 */
      assert.equal(listing.streams.length, 0)
    } else {
      assert.deepEqual(listing.streams, ['secret'])
    }

    /* 快照 */
    const snapshot = await readStream(file, 'secret')
    assert.equal(snapshot?.toString('utf8'), 'hidden-bytes')

    /* 模拟命令把它覆盖掉 */
    await writeFile(`${file}:secret`, 'overwritten', 'utf8')
    assert.equal((await readStream(file, 'secret'))?.toString('utf8'), 'overwritten')

    /* 恢复 */
    assert.equal(await writeStream(file, 'secret', snapshot ?? Buffer.alloc(0)), true)
    assert.equal((await readStream(file, 'secret'))?.toString('utf8'), 'hidden-bytes')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ADS：读不存在的流返回 undefined（不抛）', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mvs-adsrt2-'))
  try {
    const file = path.join(root, 'b.txt')
    await writeFile(file, 'main', 'utf8')
    assert.equal(await readStream(file, 'nope'), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
