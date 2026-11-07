/**
 * Low 完整性标签：打上之后，沙箱里的命令**能写工作区**，而写不到别处。
 *
 * 这一组测的是"标签真的生效"—— 打标签本身返回 0 不算数（`icacls` 报成功但路径不存在
 * 也会返回 0 的情况有过），必须用沙箱真的写一次。
 */

import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { integrityOf, labelLow, unlabelLow } from '../src/sandbox/label.ts'
import { runInSandbox } from '../src/tools/sandbox-exec.ts'

const isWindows = process.platform === 'win32'

test('标签：打上 Low、读得回来、撤销回 Medium', { skip: !isWindows }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-label-'))
  try {
    assert.notEqual(integrityOf(dir), 'Low', '新建的临时目录不该已经是 Low')

    const labelled = labelLow([dir])
    assert.equal(labelled.ok, true, labelled.message)
    assert.equal(integrityOf(dir), 'Low')

    const restored = unlabelLow([dir])
    assert.equal(restored.ok, true, restored.message)
    assert.equal(integrityOf(dir), 'Medium')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('标签：路径不存在时报失败（不假装成功）', { skip: !isWindows }, async () => {
  const ghost = path.join(os.tmpdir(), `mvs-ghost-${Date.now()}`, 'nope')
  const result = labelLow([ghost])
  assert.equal(result.ok, false)
  assert.match(result.message, /icacls/)
})

test('标签 + 沙箱：打了 Low 的目录里能写，区外写不进去', { skip: !isWindows }, async () => {
  const inside = await mkdtemp(path.join(os.tmpdir(), 'mvs-label-in-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'mvs-label-out-'))
  try {
    const labelled = labelLow([inside])
    assert.equal(labelled.ok, true, labelled.message)

    /* 区内：应该成功 */
    const within = await runInSandbox({
      command: process.execPath,
      args: ['-e', "require('fs').writeFileSync('ok.txt', 'INSIDE')"],
      cwd: inside,
      timeoutMs: 20_000,
    })
    if (within.ok !== true && within.error !== undefined) {
      /* koffi 不可用时跳过（这台机器跑不了沙箱），而不是假装通过 */
      assert.match(within.error, /koffi/)
      return
    }
    assert.equal(within.exitCode, 0, `${within.stderr}`)
    assert.equal(await readFile(path.join(inside, 'ok.txt'), 'utf8'), 'INSIDE')

    /* 区外：应该被拒 */
    const beyond = await runInSandbox({
      command: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(path.join(outside, 'no.txt'))}, 'X')`],
      cwd: inside,
      timeoutMs: 20_000,
    })
    assert.notEqual(beyond.exitCode, 0, '区外写入必须失败')
    /*
     * 用「文件根本没出现」当证据，不去匹配报错文案 —— 文案随 Node 版本变，
     * 而"文件不存在"是这条护栏真正要保证的事。
     */
    let leaked = true
    try {
      await readFile(path.join(outside, 'no.txt'), 'utf8')
    } catch {
      leaked = false
    }
    assert.equal(leaked, false, '区外文件不该被创建出来')
  } finally {
    unlabelLow([inside])
    await rm(inside, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('标签：普通写文件不受影响（打标签不改 DACL）', { skip: !isWindows }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-label-'))
  try {
    assert.equal(labelLow([dir]).ok, true)
    /* 当前进程仍能正常读写 —— 说明只加了完整性标签，没动访问控制 */
    await writeFile(path.join(dir, 'a.txt'), 'still writable', 'utf8')
    assert.equal(await readFile(path.join(dir, 'a.txt'), 'utf8'), 'still writable')
  } finally {
    unlabelLow([dir])
    await rm(dir, { recursive: true, force: true })
  }
})
