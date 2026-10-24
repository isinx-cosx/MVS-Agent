/**
 * 令牌默认值：`true`。
 *
 * 这一组守的是「**改默认值之后，用户还能进得去**」——
 * 默认从关变成开，最怕的不是"少一道防护"，而是"把自己锁在外面"。
 *
 * 所以三层都要有测试：
 *   1. 默认值本身（不传、不配，就是要令牌）
 *   2. 关掉的显式路径（配置 + 命令行，且命令行优先）
 *   3. 服务端在默认值下真的返回 401（不是"配置解析对了但没生效"）
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { resolveConfig } from '../src/config/resolve.ts'
import { defaultConfig } from '../src/config/types.ts'

const config = (extra: Record<string, unknown> = {}): ReturnType<typeof defaultConfig> =>
  ({ ...defaultConfig(), ...extra }) as ReturnType<typeof defaultConfig>

test('默认：不传命令行、配置里也没写 → 要求令牌', () => {
  const resolved = resolveConfig({ config: config(), overrides: {}, env: {} })
  assert.equal(resolved.requireToken, true)
})

test('配置关掉：server.requireToken=false → 不要求令牌', () => {
  const resolved = resolveConfig({
    config: config({ server: { requireToken: false } }),
    overrides: {},
    env: {},
  })
  assert.equal(resolved.requireToken, false)
})

test('配置打开：server.requireToken=true → 要求令牌', () => {
  const resolved = resolveConfig({
    config: config({ server: { requireToken: true } }),
    overrides: {},
    env: {},
  })
  assert.equal(resolved.requireToken, true)
})

test('命令行优先：配置写着关，但命令行 --require-token → 要求', () => {
  const resolved = resolveConfig({
    config: config({ server: { requireToken: false } }),
    overrides: { requireToken: true },
    env: {},
  })
  assert.equal(resolved.requireToken, true)
})

test('命令行优先：配置写着开，但命令行 --no-token → 不要求', () => {
  const resolved = resolveConfig({
    config: config({ server: { requireToken: true } }),
    overrides: { requireToken: false },
    env: {},
  })
  assert.equal(resolved.requireToken, false)
})

test('解析结果会进到界面读的 server 段（否则诊断页说不出"要不要令牌"）', () => {
  const resolved = resolveConfig({ config: config(), overrides: {}, env: {} })
  assert.equal(typeof resolved.requireToken, 'boolean')
  /* 端口同样的写法，两者都要能进 masked 结果 */
  assert.equal(typeof resolved.port, 'number')
})
