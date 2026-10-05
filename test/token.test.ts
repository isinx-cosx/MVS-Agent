/**
 * 令牌持久化测试。
 *
 * 为什么值得单独测：这块东西的存在理由是**「链接重启后还能开」**，
 * 而那是个**跨进程**的性质 —— 单看一次运行看不出来。这里就是把它变成
 * 可验证的：同一个文件读两次必须是同一个令牌。
 *
 * 另外两条是「别把小故障放大成大故障」：
 *   · 令牌文件坏了 → 重新生成，**而不是拒绝启动**
 *   · 写不进去 → 这次服务照常起来，只是下次会换
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadOrCreateToken, newToken } from '../src/host/token.ts'

const HEX_48 = /^[0-9a-f]{48}$/

async function inTemp<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mvs-token-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('首次调用：生成令牌并落盘', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'host-token')
    const loaded = loadOrCreateToken(file)

    assert.match(loaded.token, HEX_48, '要是 48 个十六进制字符')
    assert.equal(loaded.created, true, '第一次必然是新建')
    assert.equal((await readFile(file, 'utf8')).trim(), loaded.token, '内容要落盘')
  })
})

test('第二次调用：**读到同一个令牌**（这就是「链接不失效」的全部含义）', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'host-token')
    const first = loadOrCreateToken(file)
    const second = loadOrCreateToken(file)

    assert.equal(second.token, first.token, '重启后必须还是同一个')
    assert.equal(second.created, false, '第二次是复用，不是新建')
  })
})

test('POSIX 下文件权限是 0600（Windows 上这条测不了，见下）', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'host-token')
    loadOrCreateToken(file)
    const info = await stat(file)

    /*
     * ⚠️ **Windows 上不能这么断言。**
     *
     * Node 在 Windows 上忽略 `mode` —— Windows 用 ACL 不用 POSIX 权限位，
     * 文件实际会显示成 `666`。我第一版注释里写了「权限 0600」，那是错的，
     * 是实测 `icacls` 才发现的（真实 ACL 只给 SYSTEM / 管理员 / 本人）。
     *
     * 所以这里分平台：POSIX 断言 mode，Windows 只断言「确实是个普通文件」。
     * 不假装测到了在 Windows 上测不到的东西。
     */
    if (process.platform !== 'win32') {
      assert.equal(info.mode & 0o777, 0o600)
    } else {
      assert.ok(info.isFile(), 'Windows 上至少确认它是个普通文件')
    }
  })
})

test('文件内容不合法 → 重新生成，**并说清楚替换了什么**', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'host-token')
    await writeFile(file, 'not-a-token\n', 'utf8')

    const loaded = loadOrCreateToken(file)
    assert.match(loaded.token, HEX_48)
    assert.equal(loaded.created, true)
    assert.equal(loaded.replaced, 'not-a-token', '要告诉调用方旧值是什么')
    assert.equal((await readFile(file, 'utf8')).trim(), loaded.token, '新值要写回')
  })
})

test('空文件也当成没有', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'host-token')
    await writeFile(file, '   \n', 'utf8')
    const loaded = loadOrCreateToken(file)
    assert.match(loaded.token, HEX_48)
    assert.equal(loaded.created, true)
  })
})

test('目录不存在时会自己建出来', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'nested', 'deeper', 'host-token')
    const loaded = loadOrCreateToken(file)
    assert.match(loaded.token, HEX_48)
    assert.equal((await readFile(file, 'utf8')).trim(), loaded.token)
  })
})

test('令牌不可猜：两次 newToken 不重复，且长度稳定', () => {
  const seen = new Set<string>()
  for (let i = 0; i < 200; i += 1) {
    const token = newToken()
    assert.match(token, HEX_48)
    assert.ok(!seen.has(token), '不该撞出重复的令牌')
    seen.add(token)
  }
})

test('文件只读时不抛异常 —— 这次仍能用，只是下次会换', async () => {
  await inTemp(async (dir) => {
    const file = path.join(dir, 'host-token')
    await writeFile(file, 'bad\n', 'utf8')
    // 让文件不可写（Windows 上 chmod 基本无效，所以这条在那里会退化成一个普通断言）
    await chmod(file, 0o400).catch(() => {})

    // 无论写不写得进去，都必须**正常返回一个可用令牌**而不是抛
    const loaded = loadOrCreateToken(file)
    assert.match(loaded.token, HEX_48)
  })
})
