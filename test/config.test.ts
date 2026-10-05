/**
 * 配置层测试。
 *
 * 重点在三处容易出错的地方：
 *   1. **打码占位符不能被写回文件** —— 否则 UI 每保存一次别的字段就抹掉密钥
 *   2. **坏配置不能让 daemon 起不来，但也不能被静默覆盖**
 *   3. **密钥来源要能说清楚** —— 「我的 key 到底从哪来的」是个真问题
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ConfigStore, normalizeConfig } from '../src/config/index.ts'
import { maskResolved, modelIdentity, resolveConfig } from '../src/config/resolve.ts'
import { API_KEY_MASK, defaultConfig, maskApiKey } from '../src/config/types.ts'
import { writeFileAtomic } from '../src/config/atomic.ts'
import os from 'node:os'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

async function withStore(fn: (store: ConfigStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    await fn(new ConfigStore(dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

// ---------------------------------------------------------------------------
// 首次运行与读写
// ---------------------------------------------------------------------------

test('首次运行会生成默认配置，并报告「已创建」', async () => {
  await withStore(async (store) => {
    const result = await store.load()
    assert.equal(result.created, true)
    assert.deepEqual(result.warnings, [])

    const written = JSON.parse(await readFile(store.configPath, 'utf8')) as Record<string, unknown>
    assert.equal(written.version, 1)
  })
})

test('保存后能读回同样的内容', async () => {
  await withStore(async (store) => {
    await store.load()
    await store.save({
      version: 1,
      model: { baseUrl: 'https://api.example.com/v1', model: 'my-model' },
      server: { port: 4000 },
    })

    const reloaded = await new ConfigStore(store.dir).load()
    assert.equal(reloaded.config.model?.baseUrl, 'https://api.example.com/v1')
    assert.equal(reloaded.config.model?.model, 'my-model')
    assert.equal(reloaded.config.server?.port, 4000)
  })
})

test('保存会通知订阅者，供运行时做热更新', async () => {
  await withStore(async (store) => {
    await store.load()
    const seen: string[] = []
    store.subscribe((config) => seen.push(config.model?.model ?? '(none)'))

    await store.save({ version: 1, model: { model: 'first' } })
    await store.save({ version: 1, model: { model: 'second' } })

    assert.deepEqual(seen, ['first', 'second'])
  })
})

// ---------------------------------------------------------------------------
// ★ 打码占位符
// ---------------------------------------------------------------------------

test('★ 打码占位符 = 不要动密钥 —— 否则 UI 保存别的字段会把密钥抹掉', async () => {
  await withStore(async (store) => {
    await store.load()
    await store.save({ version: 1, model: { apiKey: 'sk-real-secret-12345', model: 'a' } })

    // 前端拿不到明文，它回传的是打码值
    await store.save({ version: 1, model: { apiKey: API_KEY_MASK, model: 'b' } })

    const raw = JSON.parse(await readFile(store.configPath, 'utf8')) as {
      model?: { apiKey?: string; model?: string }
    }
    assert.equal(raw.model?.apiKey, 'sk-real-secret-12345', '密钥必须被保留')
    assert.equal(raw.model?.model, 'b', '同一份提交里的其他字段要正常保存')
  })
})

test('显式传空字符串才是真的清掉密钥', async () => {
  await withStore(async (store) => {
    await store.load()
    await store.save({ version: 1, model: { apiKey: 'sk-real' } })
    await store.save({ version: 1, model: { apiKey: '' } })

    const raw = JSON.parse(await readFile(store.configPath, 'utf8')) as {
      model?: { apiKey?: string }
    }
    assert.equal(raw.model?.apiKey, '')
  })
})

test('maskApiKey：任何地方显示密钥都要走它', () => {
  assert.equal(maskApiKey('sk-1234567890abcdef'), 'sk-…cdef')
  assert.equal(maskApiKey('short'), API_KEY_MASK)
  assert.equal(maskApiKey(''), '')
})

// ---------------------------------------------------------------------------
// ★ 坏配置
// ---------------------------------------------------------------------------

test('★ 坏配置不让 daemon 起不来，但要报警并说明是哪个文件', async () => {
  await withStore(async (store) => {
    await writeFile(store.configPath, '{ 这不是 JSON', 'utf8')

    const result = await store.load()
    assert.equal(result.broken, true)
    assert.equal(result.config.version, 1, '解析失败要退回默认值，而不是抛出去')
    assert.ok(
      result.warnings.some((w) => w.includes('config.json') && w.includes('合法 JSON')),
      `必须说清楚是哪个文件、错在哪，实际：${JSON.stringify(result.warnings)}`,
    )
  })
})

test('★ 坏配置不会被静默覆盖 —— 保存前先备份', async () => {
  await withStore(async (store, dir) => {
    const broken = '{ 我手写的，但是少了个引号 '
    await writeFile(store.configPath, broken, 'utf8')
    await store.load()

    const result = await store.save({ version: 1, model: { model: 'new' } })
    assert.ok(
      result.warnings.some((w) => w.includes('备份')),
      `保存时要说明备份了，实际：${JSON.stringify(result.warnings)}`,
    )

    const files = await readdir(dir)
    const backup = files.find((f) => f.startsWith('config.json.broken-'))
    assert.ok(backup !== undefined, `应该留下备份，实际目录：${JSON.stringify(files)}`)
    assert.equal(await readFile(path.join(dir, backup), 'utf8'), broken, '备份必须是原文')
  })
})

test('BOM 不会让配置解析失败（PowerShell / 记事本会塞进来）', async () => {
  await withStore(async (store) => {
    await writeFile(store.configPath, '\uFEFF{"version":1,"model":{"model":"bom"}}', 'utf8')
    const result = await store.load()
    assert.equal(result.broken, false)
    assert.equal(result.config.model?.model, 'bom')
  })
})

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

test('校验：坏字段被逐项丢弃并报警，而不是整份拒绝', () => {
  const result = normalizeConfig({
    version: 1,
    model: { model: 'ok', contextWindow: -5, baseUrl: 123 },
    server: { port: 99999 },
    permissions: { defaultMode: 'yolo' },
    context: { triggerRatio: 2, keepRecentTurns: 3 },
    unknownField: true,
  })

  assert.equal(result.config.model?.model, 'ok', '能认的字段要留下')
  assert.equal(result.config.model?.contextWindow, undefined, '负数窗口要丢掉')
  assert.equal(result.config.model?.baseUrl, undefined, '类型不对要丢掉')
  assert.equal(result.config.server, undefined)
  assert.equal(result.config.permissions, undefined)
  assert.equal(result.config.context?.triggerRatio, undefined, '超出 (0,1] 要丢掉')
  assert.equal(result.config.context?.keepRecentTurns, 3, '同一个对象里合法的那项要留下')

  const joined = result.warnings.join(' ')
  assert.match(joined, /contextWindow/)
  assert.match(joined, /port/)
  assert.match(joined, /defaultMode/)
  assert.match(joined, /triggerRatio/)
  assert.match(joined, /unknownField/)
})

// ---------------------------------------------------------------------------
// ★ 密钥来源
// ---------------------------------------------------------------------------

test('★ 密钥来源优先级：命令行 > 环境变量 > 配置文件明文 > apiKeyEnv', () => {
  const config = { version: 1, model: { apiKey: 'from-file', apiKeyEnv: 'MY_KEY' } }

  const cli = resolveConfig({
    config,
    overrides: { apiKey: 'from-cli' },
    env: { MY_KEY: 'from-env', MVS_API_KEY: 'from-mvs-env' },
  })
  assert.equal(cli.apiKey, 'from-cli')
  assert.equal(cli.apiKeySource, 'command-line')

  const envFirst = resolveConfig({
    config,
    overrides: {},
    env: { MVS_API_KEY: 'from-mvs-env' },
  })
  assert.equal(envFirst.apiKey, 'from-mvs-env')
  assert.equal(envFirst.apiKeySource, 'environment')

  const fromFile = resolveConfig({
    config: { version: 1, model: { apiKey: 'from-file' } },
    overrides: {},
    env: {},
  })
  assert.equal(fromFile.apiKey, 'from-file')
  assert.equal(fromFile.apiKeySource, 'config-plaintext')

  const fromEnvName = resolveConfig({ config, overrides: {}, env: { MY_KEY: 'named-env' } })
  assert.equal(fromEnvName.apiKey, 'named-env')
  assert.equal(fromEnvName.apiKeySource, 'environment')
})

test('配置里指定的环境变量不存在时明确警告', () => {
  const resolved = resolveConfig({
    config: { version: 1, model: { apiKeyEnv: 'MISSING_KEY' } },
    overrides: {},
    env: {},
  })
  assert.equal(resolved.apiKey, undefined)
  assert.equal(resolved.apiKeySource, 'none')
  assert.ok(
    resolved.warnings.some((w) => w.includes('MISSING_KEY')),
    `要说清楚是哪个变量空了，实际：${JSON.stringify(resolved.warnings)}`,
  )
})

test('打码后的配置里没有明文密钥，但会标出「它是明文存的」', () => {
  const resolved = resolveConfig({
    config: { version: 1, model: { apiKey: 'sk-super-secret-value' } },
    overrides: {},
    env: {},
  })
  const masked = maskResolved(resolved)

  assert.equal(masked.model.apiKey, 'sk-…alue')
  assert.equal(masked.model.apiKeyIsPlaintext, true, 'UI 要把这个风险显示出来')
  assert.equal(
    JSON.stringify(masked).includes('super-secret'),
    false,
    '打码后的对象里绝不能出现明文',
  )
})

test('用环境变量提供密钥时不标为明文风险', () => {
  const resolved = resolveConfig({
    config: { version: 1, model: { apiKeyEnv: 'K' } },
    overrides: {},
    env: { K: 'sk-x' },
  })
  assert.equal(maskResolved(resolved).model.apiKeyIsPlaintext, false)
})

// ---------------------------------------------------------------------------
// 解析优先级与窗口
// ---------------------------------------------------------------------------

test('解析优先级：命令行 > 环境变量 > 配置文件 > profile 预设', () => {
  const config = { version: 1, profile: 'deepseek', model: { model: 'from-file' } }

  const resolved = resolveConfig({
    config,
    overrides: { model: 'from-cli' },
    env: { MVS_MODEL: 'from-env', MVS_BASE_URL: 'https://env.example/v1' },
  })
  assert.equal(resolved.model, 'from-cli', '命令行最优先')
  assert.equal(resolved.baseUrl, 'https://env.example/v1', '环境变量压过配置文件与预设')

  const fileWins = resolveConfig({
    config: { version: 1, profile: 'deepseek', model: { baseUrl: 'https://file.example/v1' } },
    overrides: {},
    env: {},
  })
  assert.equal(fileWins.baseUrl, 'https://file.example/v1', '配置文件压过 profile 预设')
})

test('★ 窗口：没声明就是 undefined，交给探测 —— 绝不在这里编一个数', () => {
  const unset = resolveConfig({ config: { version: 1 }, overrides: {}, env: {} })
  assert.equal(
    unset.contextWindow,
    undefined,
    '解析层不能替探测做决定；默认值由 serve.ts 在探测之后才补上',
  )

  const declared = resolveConfig({
    config: { version: 1, model: { contextWindow: 128_000 } },
    overrides: {},
    env: {},
  })
  assert.equal(declared.contextWindow, 128_000)
})

test('未知 profile 会警告并退回 ollama', () => {
  const resolved = resolveConfig({
    config: { version: 1, profile: 'does-not-exist' },
    overrides: {},
    env: {},
  })
  assert.equal(resolved.profileName, 'ollama')
  assert.ok(resolved.warnings.some((w) => w.includes('does-not-exist')))
})

test('模型身份指纹变了就说明该校准重置', () => {
  const a = resolveConfig({
    config: { version: 1, model: { baseUrl: 'https://a.example/v1', model: 'm1' } },
    overrides: {},
    env: {},
  })
  const sameModel = resolveConfig({
    config: { version: 1, model: { baseUrl: 'https://a.example/v1', model: 'm1', apiKey: 'new' } },
    overrides: {},
    env: {},
  })
  const otherModel = resolveConfig({
    config: { version: 1, model: { baseUrl: 'https://a.example/v1', model: 'm2' } },
    overrides: {},
    env: {},
  })

  assert.equal(modelIdentity(a), modelIdentity(sameModel), '只换密钥不该重置校准')
  assert.notEqual(modelIdentity(a), modelIdentity(otherModel), '换模型必须重置校准')
})

test('默认配置本身是合法且能通过的', () => {
  const result = normalizeConfig(defaultConfig())
  assert.deepEqual(result.warnings, [])
  assert.equal(result.config.version, 1)
})

// ---------------------------------------------------------------------------
// 原子写
// ---------------------------------------------------------------------------

/**
 * ★ 并发写同一个目标不能互相踩。
 *
 * 这条是**用一个真崩溃换来的**：临时文件名原来只带 `process.pid`，于是同一进程里
 * 两次并发写同一个文件用的是同一个临时路径。第一个 rename 把它移走，第二个去
 * rename 时源已经不存在 → `ENOENT`，而那个异常一路冒到 HTTP 处理器外面，
 * **把整个守护进程带走了**。
 *
 * 触发它的是一条完全正常的路径：界面选中会话时，WS 的 `watch` 和 HTTP 的
 * `/projection` 同一瞬间都要加载同一个会话，于是并发写两次检查点。
 */
test('★ writeFileAtomic：并发写同一个目标不能互相踩', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  try {
    const target = path.join(base, 'checkpoint.json')

    await Promise.all([
      writeFileAtomic(target, JSON.stringify({ n: 1 })),
      writeFileAtomic(target, JSON.stringify({ n: 2 })),
      writeFileAtomic(target, JSON.stringify({ n: 3 })),
    ])

    const text = await readFile(target, 'utf8')
    // 内容必然是三者之一 —— 交替写不会写出半截 JSON
    assert.ok(['{"n":1}', '{"n":2}', '{"n":3}'].includes(text), `内容不该是拼接的半截：${text}`)
    JSON.parse(text)

    // 临时文件不能留在用户的配置目录里
    const leftovers = (await readdir(base)).filter((f) => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [], `不该留下临时文件：${leftovers.join(', ')}`)
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// ---------------------------------------------------------------------------
// webSearch
// ---------------------------------------------------------------------------

test('★★ webSearch：段名必须进 `known`，否则配置**被整个忽略**', () => {
  /*
   * ⚠️ 这条钉的是一个**已经犯过的错**。
   *
   * `normalizeConfig` 最后有一段逐字段检查：
   *
   *     const known = new Set(['version','profile','model',…])
   *     for (const key of Object.keys(input)) {
   *       if (!known.has(key)) warnings.push(`配置里有不认识的字段「${key}」，已忽略`)
   *     }
   *
   * 所以**解析逻辑写得再对，忘了往 `known` 里加名字就整个不生效** ——
   * 而现象是"我配了，为什么没用"，从那条「不认识的字段」警告里
   * 看不出是自己漏了一行。
   *
   * `localModel` 就这么漏过一次，`webSearch` 差点再漏一次。
   */
  const result = normalizeConfig({
    version: 1,
    webSearch: { provider: 'tavily', apiKey: 'sk-x' },
  })
  assert.deepEqual(
    result.warnings.filter((w) => w.includes('不认识的字段')),
    [],
    'webSearch 必须被认得 —— 报了这句就说明漏加了 known',
  )
  assert.equal(result.config.webSearch?.provider, 'tavily')
  assert.equal(result.config.webSearch?.apiKey, 'sk-x')
})

test('webSearch：没有 provider 的段整个不生效（半配好不如不配）', () => {
  /*
   * 有密钥没 provider 的话，`web_search` 会在**运行时**神秘失败 ——
   * 而那发生在模型已经决定要用它的时候。当成没配更好：至少错误是
   * 「没有配置搜索后端」这种一眼能懂的话。
   */
  const result = normalizeConfig({ version: 1, webSearch: { apiKey: 'sk-x' } })
  assert.equal(result.config.webSearch, undefined)
})

test('webSearch：不认识的后端名要警告并忽略整段', () => {
  const result = normalizeConfig({ version: 1, webSearch: { provider: 'google', apiKey: 'sk-x' } })
  assert.equal(result.config.webSearch, undefined)
  assert.ok(
    result.warnings.some((w) => w.includes('webSearch.provider')),
    '要说出来是 provider 不认',
  )
})

test('webSearch：maxResults 封顶到 20，和工具里的 clamp 对齐', () => {
  /*
   * 两处上限不一致的话，用户设了 100、界面也显示 100，
   * 而实际只回 20 —— 那是一种"界面在骗人"的小形态。
   */
  const clamped = normalizeConfig({
    version: 1,
    webSearch: { provider: 'tavily', apiKey: 'k', maxResults: 100 },
  })
  assert.equal(clamped.config.webSearch?.maxResults, 20)

  const bad = normalizeConfig({
    version: 1,
    webSearch: { provider: 'tavily', apiKey: 'k', maxResults: -5 },
  })
  assert.equal(bad.config.webSearch?.maxResults, undefined)
  assert.ok(bad.warnings.some((w) => w.includes('maxResults')))
})

test('★ webSearch：配了后端但没密钥 → **启动时就警告**，不等工具调用失败', () => {
  /*
   * 密钥缺失造成的失败会发生在**模型已经决定要用搜索**的时候 ——
   * 用户看到的是"工具报错"，而不是"我配置漏了一项"。
   * 启动时说出来，问题就在它变成故障之前。
   *
   * `searxng` 例外：自建实例通常不需要密钥，所以它不该被警告。
   */
  const tavily = resolveConfig({
    config: { version: 1, webSearch: { provider: 'tavily' } },
    overrides: {},
    env: {},
  })
  assert.ok(
    tavily.warnings.some((w) => w.includes('没有可用的密钥')),
    'tavily 缺密钥要警告',
  )

  const searxng = resolveConfig({
    config: { version: 1, webSearch: { provider: 'searxng', baseUrl: 'http://127.0.0.1:8888' } },
    overrides: {},
    env: {},
  })
  assert.ok(
    !searxng.warnings.some((w) => w.includes('没有可用的密钥')),
    'searxng 不需要密钥，不该警告',
  )
})

test('webSearch：密钥优先从 apiKeyEnv 指的变量读', () => {
  /*
   * 和模型那套是**同一个优先级**（环境变量 → 配置文件明文）。
   * 对用户来说"我的密钥从哪来"不该有两种答案。
   */
  const resolved = resolveConfig({
    config: { version: 1, webSearch: { provider: 'tavily', apiKey: 'from-file', apiKeyEnv: 'MY_SEARCH_KEY' } },
    overrides: {},
    env: { MY_SEARCH_KEY: 'from-env' },
  })
  assert.equal(resolved.webSearch?.apiKey, 'from-env')

  const fallback = resolveConfig({
    config: { version: 1, webSearch: { provider: 'tavily', apiKey: 'from-file', apiKeyEnv: 'MISSING' } },
    overrides: {},
    env: {},
  })
  assert.equal(fallback.webSearch?.apiKey, 'from-file', '环境变量没值就退回配置文件')
})

// ---------------------------------------------------------------------------
// 供应商库 + 可选模型
// ---------------------------------------------------------------------------

test('★★ providers：段名必须进 `known`，否则整个被忽略', () => {
  /*
   * 和 `webSearch` 那条同一个坑：解析写好了但没进 `known`，
   * 配置**被整个忽略**还每次启动报「不认识的字段」。
   */
  const result = normalizeConfig({
    version: 1,
    providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } },
  })
  assert.deepEqual(
    result.warnings.filter((w) => w.includes('不认识的字段')),
    [],
    'providers 必须被认得',
  )
  assert.equal(result.config.providers?.deepseek?.model, 'deepseek-chat')
})

test('★ providers：route 必须是合法标识符', () => {
  /*
   * route 会被用来派生凭据名。带斜杠或大写的 route 会让后面每一步都要重新校验 ——
   * 不如在入口拒掉。
   */
  const result = normalizeConfig({
    version: 1,
    providers: {
      GoodRoute: { baseUrl: 'http://x' },      // 大写开头 → 拒
      'has/slash': { baseUrl: 'http://x' },    // 有斜杠 → 拒
      goodroute: { baseUrl: 'http://x' },      // ✓
    },
  })
  assert.deepEqual(Object.keys(result.config.providers ?? {}), ['goodroute'])
  assert.equal(result.warnings.filter((w) => w.includes('route')).length, 2)
})

test('providers：models 去重、丢弃空串和非字符串', () => {
  const result = normalizeConfig({
    version: 1,
    providers: { a: { models: ['x', 'x', '', 'y', 42, null] } },
  })
  /*
   * 期望值是**存储形状**（`{ id, name?, contextWindow? }[]`）。
   *
   * 这里原来断言的是 `['x', 'y']` —— 那是 `models` 还是 `string[]` 时代的写法。
   * 形状改成 DSH 那套之后，字符串会被规范化成 `{ id }`，于是那条断言必然红。
   * 这条测试**要钉的东西没变**（去重、丢掉空串和没有 id 的垃圾），只是落点换了。
   */
  assert.deepEqual(result.config.providers?.a?.models, [{ id: 'x' }, { id: 'y' }])
})

test('★ activeProvider：悬空引用被丢弃（等价于用 model 段）', () => {
  /*
   * 留一个悬空引用会让每次启动都警告一次，而那个警告**永远修不掉** ——
   * 用户不知道要去哪改。悬空就直接当没设。
   */
  const dangling = normalizeConfig({ version: 1, activeProvider: 'nope' })
  assert.equal(dangling.config.activeProvider, undefined)
  assert.ok(dangling.warnings.some((w) => w.includes('activeProvider')))

  const real = normalizeConfig({
    version: 1,
    providers: { a: { model: 'm' } },
    activeProvider: 'a',
  })
  assert.equal(real.config.activeProvider, 'a')
})

test('★★ activeProvider：解析时真的会切到那个供应商', () => {
  /*
   * 这条钉的是"添加供应商"**有没有用**。写入通、列表通，
   * 但解析时还读 `model` 段的话，切过去就是没生效。
   */
  const resolved = resolveConfig({
    config: {
      version: 1,
      model: { baseUrl: 'http://local/v1', model: 'qwen3.6', apiKey: 'local-key' },
      providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } },
      activeProvider: 'deepseek',
    },
    overrides: {},
    env: {},
  })
  assert.equal(resolved.baseUrl, 'https://api.deepseek.com/v1')
  assert.equal(resolved.model, 'deepseek-chat')
  assert.equal(resolved.activeProvider, 'deepseek')
  /*
   * ⚠️ 合并不是替换：`model` 段里设了而供应商没设的字段要**留着**。
   * 替换的话那些设置在切供应商时会静默消失 —— 看起来像"界面把设置弄丢了"。
   */
  assert.equal(resolved.apiKey, 'local-key', 'model 段的 apiKey 没被覆盖就该留着')
})

test('★ models：当前选中的排第一，且老配置只有一个也不会空', () => {
  /*
   * 只看 `models` 不看 `model` 的话，老配置的模型选择器会**空掉** ——
   * 而那是"看起来坏了"里最糟的一种：模型明明在跑。
   */
  const onlyCurrent = resolveConfig({
    config: { version: 1, model: { model: 'qwen3.6' } },
    overrides: {},
    env: {},
  })
  assert.deepEqual(onlyCurrent.models, ['qwen3.6'])

  const withList = resolveConfig({
    config: {
      version: 1,
      /*
       * `models` 是**存储形状**（DSH 那套 `{ id, name?, contextWindow? }`），
       * 不是字符串数组 —— 字符串数组是改形状之前的写法。
       *
       * 重复项刻意**不是**当前模型（'a' 出现两次）：否则"过滤掉当前那个"
       * 就顺带把重去掉了，这条测试也就测不到它名字里承诺的去重。
       */
      model: { model: 'b', models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'a' }] },
    },
    overrides: {},
    env: {},
  })
  assert.deepEqual(withList.models, ['b', 'a', 'c'], '当前那个排第一，其余按原序去重')
})

test('activeProvider 没设时 activeProvider 回 "mvs"（不是 undefined）', () => {
  /* 界面要用它标出"哪个是选中的"，给 undefined 的话没有卡片会被标中 */
  const resolved = resolveConfig({ config: { version: 1 }, overrides: {}, env: {} })
  assert.equal(resolved.activeProvider, 'mvs')
})

// ---------------------------------------------------------------------------
// ★★ 硬规则：MVS Agent 的配置不得被隐式改写
//
// 用户原话：「MVS Agent 的配置又被改了，不能改，不能改」。
// 下面每条钉的都是**真实发生过**的一次改写（见 docs/现状-全貌.md 的「硬规则」一节）。
// ---------------------------------------------------------------------------

test('★★ 掩码不落盘：每个供应商的密钥都要还原（不能只还原 model 段）', async () => {
  /*
   * 这条钉的是一次**真实的数据销毁**：出站把密钥换成 `••••`，界面原样回传时，
   * 原来只有 `config.model.apiKey` 被还原 —— `providers.<route>.apiKey` 被
   * 4 个字符的掩码**覆盖销毁**（实测 35 → 4），真密钥不可恢复。
   */
  await withStore(async (store) => {
    await store.save({
      version: 1,
      model: { model: 'a', apiKey: 'sk-model-secret-123' },
      providers: { deepseek: { model: 'b', apiKey: 'sk-provider-secret-456' } },
    })

    /* 界面回传：两个位置都变成掩码 */
    const second = await store.save({
      version: 1,
      model: { model: 'a', apiKey: API_KEY_MASK },
      providers: { deepseek: { model: 'b', apiKey: API_KEY_MASK } },
    })

    assert.equal(second.config.model?.apiKey, 'sk-model-secret-123')
    assert.equal(
      second.config.providers?.deepseek?.apiKey,
      'sk-provider-secret-456',
      '供应商的密钥被掩码覆盖了 —— 这是不可恢复的数据销毁',
    )

    const written = JSON.parse(await readFile(store.configPath, 'utf8')) as {
      providers: { deepseek: { apiKey: string } }
    }
    assert.equal(written.providers.deepseek.apiKey, 'sk-provider-secret-456')
  })
})

test('★★ 掩码遇到「之前就没有密钥」：清掉，不能把掩码当成密钥留下', async () => {
  await withStore(async (store) => {
    await store.save({ version: 1, providers: { local: { model: 'qwen3.6' } } })
    const second = await store.save({
      version: 1,
      providers: { local: { model: 'qwen3.6', apiKey: API_KEY_MASK } },
    })
    const key = second.config.providers?.local?.apiKey
    assert.ok(
      key === undefined || key === '',
      `掩码不能留下（它会被当成真密钥发出去），实际是 ${JSON.stringify(key)}`,
    )
  })
})

test('★★ MVS Agent 是普通供应商：mvs 落成真实条目，且与 model 段互不影响', () => {
  /*
   * 用户要求：「MVS Agent 设为一个普通的提供商，而不是全局默认」。
   *
   * 所以：`mvs` 必须是 `providers` 里的**真实条目**（改它只改它自己），
   * 而 `model` 段继续作为"没有任何会话级选择时"的进程兜底。
   */
  const migrated = normalizeConfig({
    version: 1,
    model: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
  })
  assert.equal(migrated.config.providers?.mvs?.model, 'deepseek-flash')
  assert.equal(migrated.config.providers?.mvs?.displayName, 'MVS Agent')
  /* 有 mvs 了，`activeProvider` 就如实写上它（不再是"悬空引用被丢掉"） */
  assert.equal(migrated.config.activeProvider, 'mvs')

  /* **改 mvs 不动 model 段** —— 这就是"改一个，别的都变了"的解 */
  const edited = normalizeConfig({
    version: 1,
    model: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    providers: { mvs: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'qwen3.6' } },
    activeProvider: 'mvs',
  })
  assert.equal(edited.config.providers?.mvs?.model, 'qwen3.6')
  assert.equal(edited.config.model?.model, 'deepseek-flash', 'model 段被连带改了')
  assert.equal(edited.config.activeProvider, 'mvs')
})

test('★★ activeProvider 指向 mvs 必须留在盘上（不再被当悬空引用丢掉）', async () => {
  /*
   * 原来的症状：内存说 `mvs`、磁盘**没有这个键** —— 于是"配置怎么自己变了"。
   * 根因是 `mvs` 当时不在 `providers` 里，被规范化守卫当悬空引用丢掉。
   */
  await withStore(async (store) => {
    await store.save({
      version: 1,
      model: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
      providers: { mvs: { model: 'deepseek-flash' } },
      activeProvider: 'mvs',
    })
    const written = JSON.parse(await readFile(store.configPath, 'utf8')) as {
      activeProvider?: string
    }
    assert.equal(written.activeProvider, 'mvs')
  })
})
