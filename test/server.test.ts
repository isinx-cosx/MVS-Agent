/**
 * 传输层测试。
 *
 * 重点不是「能连上」，而是**每一条防护都能单独证伪**：
 * 少任何一道，这个能执行命令的端口就等于把前面几层的设计全部绕过。
 *
 * 用原始 http.request 而不是 fetch —— 因为我们必须能**伪造 Host 头**，
 * 而 fetch 不允许改它。伪造 Host 正是 DNS rebinding 攻击的核心。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, mkdir, rm, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { HostServer, Runtime } from '../src/host/index.ts'
import type { PickResult } from '../src/host/index.ts'
import { ConfigStore } from '../src/config/index.ts'
import { StateStore } from '../src/config/state.ts'
import type { ModelClient, ModelEvent } from '../src/model/types.ts'
import type { ServerFrame } from '../src/protocol/types.ts'
import type { PermissionMode } from '../src/policy/types.ts'
import os from 'node:os'


// ---------------------------------------------------------------------------

function scriptedModel(turns: ModelEvent[][]): ModelClient {
  let index = 0
  return {
    stream(): AsyncIterable<ModelEvent> {
      const events: ModelEvent[] = turns[index] ?? [{ type: 'done', reason: 'stop' }]
      index += 1
      return (async function* generate() {
        for (const event of events) yield event
      })()
    },
  }
}

const say = (text: string): ModelEvent[] => [
  { type: 'text_delta', text },
  { type: 'done', reason: 'stop' },
]

const call = (id: string, name: string, args: unknown): ModelEvent[] => [
  { type: 'tool_call_delta', index: 0, id, name, argsJsonDelta: JSON.stringify(args) },
  { type: 'done', reason: 'tool_calls' },
]

interface ServerHarness {
  origin: string
  port: number
  token: string
  close: () => Promise<void>
  runtime: Runtime
  sessionId: string
  workspace: string
  /** 前端产物目录。测试里是一个临时目录，里面放一份假的 index.html */
  uiDir: string
}

async function withServer(
  model: ModelClient,
  fn: (h: ServerHarness) => Promise<void>,
  options: {
    mode?: PermissionMode
    buildUi?: boolean
    pick?: () => Promise<PickResult>
    /**
     * 在构建 Runtime **之前**写进配置文件的东西。
     *
     * 加这个参数是为了能测「明文密钥不会出边界」—— 那需要配置里真的有一把明文密钥。
     * 没有它的话，那条测试只能断言 `apiKey` 字段**存在**，而字段存在和字段被打码
     * 是两回事：真泄漏了明文，`apiKey":` 照样出现在 JSON 里，测试照样通过。
     */
    configPatch?: unknown
    /**
     * 要不要令牌。
     *
     * ⚠️ **测试默认 true，生产的默认是 false** —— 这个不一致是**有意的**：
     * 这些用例是在验令牌那套机制（换 cookie、401 长什么样、说明页内容），
     * 关掉它就测不到东西了。生产默认关着，因为开发阶段本机只有一个人用 ——
     * 见 `HostServerOptions.requireToken`。
     *
     * 不传 token 相关用例的组用 `requireToken: false` 显式关掉。
     */
    requireToken?: boolean
  } = {},
): Promise<void> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mvs-test-'))
  const root = path.join(base, 'workspace')
  await mkdir(root, { recursive: true })

  // 前端产物放临时目录，**刻意不指向真实的 dist/web**：
  // 那样测试就会依赖「有没有跑过 npm run web:build」，而这跟被测行为无关。
  const uiDir = path.join(base, 'web')
  await mkdir(path.join(uiDir, 'assets'), { recursive: true })
  if (options.buildUi !== false) {
    await writeFile(
      path.join(uiDir, 'index.html'),
      '<!doctype html><title>MVS Agent 界面</title><div id="app"></div>',
      'utf8',
    )
    await writeFile(path.join(uiDir, 'assets', 'app.js'), 'console.log(1)', 'utf8')

    /*
     * 主页面 + 品牌页的替身。
     *
     * 真实的 `web/index.html` 是 570 KB 的复刻页，测试刻意不依赖它
     * （那会引入「有没有抓过快照」这个无关变量）。这里只放最小占位。
     *
     * ⚠️ 现在**只有一个根**：`uiDir` 下 `index.html` 就是主页面。
     * 原来还有一层 `dsh/`，那是把主页面当构建产物时的遗留 —— 已经去掉了。
     */
    await writeFile(path.join(uiDir, 'glue.js'), '/* glue */', 'utf8')

    await mkdir(path.join(uiDir, 'brand'), { recursive: true })
    await writeFile(
      path.join(uiDir, 'brand', 'index.html'),
      '<!doctype html><title>brand</title><p>brand placeholder</p>',
      'utf8',
    )

    // 带内容哈希的产物（Vite 的形状）。这个**才**该长缓存
    await writeFile(path.join(uiDir, 'assets', 'app-a1B2c3D4.js'), 'console.log(2)', 'utf8')
  }

  // 配置与索引放独立的目录，别碰用户真实的 ~/.mvs-agent
  const configStore = new ConfigStore(path.join(base, 'home'))
  const stateStore = new StateStore(path.join(base, 'home'))
  await configStore.load()
  if (options.configPatch !== undefined) await configStore.save(options.configPatch)

  const runtime = new Runtime({
    config: configStore,
    state: stateStore,
    probe: false,
    // 注入脚本化的假模型 —— 会话不关心模型从哪来
    modelFactory: () => model,
    overrides: { defaultMode: options.mode ?? 'full-access' },
  })
  await runtime.init()
  await runtime.openWorkspace(root)
  const summary = await runtime.createSession(root, '测试会话')

  const server = new HostServer({
    runtime,
    port: 0,
    serveDevClient: true,
    uiDir,
    /*
     * 测试默认**要求**令牌（见 `withServer` 里 `requireToken` 的说明）。
     * 生产的默认是 false —— 这个不一致是有意的：这些用例就是来验令牌那套机制的。
     */
    requireToken: options.requireToken ?? true,
    ...(options.pick === undefined ? {} : { pickDirectory: options.pick }),
  })
  const info = await server.listen()

  try {
    await fn({
      origin: info.origin,
      port: info.port,
      token: info.token,
      close: () => server.close(),
      runtime,
      sessionId: summary.sessionId,
      workspace: root,
      uiDir,
    })
  } finally {
    await server.close()
    await runtime.dispose()
    // 重试是必要的：Windows 上子进程刚退出时句柄可能还没释放完。
    // 但这只是缓冲，不是兜底 —— 真有长命子进程占着目录，重试再多次也没用，
    // 那说明用例本身跑起了不该跑的命令（见审批用例里那段注释）。
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

interface RawResponse {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}

/** 用原始 http 请求，因为要能伪造 Host 头、并且要能看到 Set-Cookie */
function raw(
  port: number,
  options: {
    method?: string
    path?: string
    host?: string
    origin?: string
    token?: string
    /** 只带 cookie、不带令牌 —— 用来验证「换过 cookie 之后就不用再带令牌了」 */
    cookie?: string
    /**
     * 原样附加的请求头。
     *
     * 用来区分**浏览器导航**和**程序调用** —— 服务端靠 `Accept` 里有没有
     * `text/html` 来判断该回说明页还是回 JSON。
     */
    headers?: Record<string, string>
    body?: unknown
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
    const headers: Record<string, string> = {}
    if (options.host !== undefined) headers.host = options.host
    if (options.origin !== undefined) headers.origin = options.origin
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`
    if (options.cookie !== undefined) headers.cookie = options.cookie
    if (options.headers !== undefined) Object.assign(headers, options.headers)
    if (payload !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(payload))
    }

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/health',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        )
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// 四道防护
// ---------------------------------------------------------------------------

test('只绑回环：打印出来的地址必须是 127.0.0.1', async () => {
  await withServer(scriptedModel([say('x')]), async ({ origin }) => {
    assert.equal(origin.startsWith('http://127.0.0.1:'), true, `实际绑定在 ${origin}`)
  })
})

test('防护①：Host 不是回环 → 403（挡 DNS rebinding）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    // 攻击场景：恶意域名解析到 127.0.0.1，浏览器带着攻击者的域名发请求。
    // 请求确实落在回环上，但 Host 头是攻击者的域名。
    const denied = await raw(port, { host: 'evil.example.com', token })
    assert.equal(denied.status, 403, `实际 ${denied.status}：${denied.body}`)
    assert.match(denied.body, /DNS rebinding|回环/)

    // 同样的请求，Host 换成回环就放行 —— 证明拦的是 Host，不是别的
    const allowed = await raw(port, { host: `127.0.0.1:${port}`, token })
    assert.equal(allowed.status, 200)
  })
})

test('防护②：Origin 不是回环 → 403', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const denied = await raw(port, {
      host: `127.0.0.1:${port}`,
      origin: 'https://evil.example.com',
      token,
    })
    assert.equal(denied.status, 403, `实际 ${denied.status}：${denied.body}`)

    const allowed = await raw(port, {
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      token,
    })
    assert.equal(allowed.status, 200)

    // 没有 Origin（非浏览器客户端）也可以
    const noOrigin = await raw(port, { host: `127.0.0.1:${port}`, token })
    assert.equal(noOrigin.status, 200)
  })
})

test('防护③：没有令牌 → 401', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port }) => {
    const denied = await raw(port, { host: `127.0.0.1:${port}` })
    assert.equal(denied.status, 401, `实际 ${denied.status}：${denied.body}`)
  })
})

test('防护③：令牌错误 → 401，长度不同也不会崩', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port }) => {
    const wrong = await raw(port, { host: `127.0.0.1:${port}`, token: 'wrong-token' })
    assert.equal(wrong.status, 401)

    // timingSafeEqual 要求等长，长度不同必须先返回而不是抛异常
    const wrongLength = await raw(port, { host: `127.0.0.1:${port}`, token: 'x' })
    assert.equal(wrongLength.status, 401)
  })
})

test('防护③：查询串里的令牌也接受（浏览器无法给 WS 设请求头）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const res = await raw(port, { host: `127.0.0.1:${port}`, path: `/health?token=${token}` })
    assert.equal(res.status, 200)
  })
})

// ---------------------------------------------------------------------------
// /auth 的 next 跳转
//
// 为什么需要它：主页面（`/`）要令牌，而令牌在 URL 里只能进一次 ——
// 必须把「换 cookie」和「跳过去」合成一次导航，因为浏览器点一个链接只能导航一次。
// 没有 next 的话那一页实际上打不开。
// ---------------------------------------------------------------------------

test('/auth?next= 一次导航完成换令牌与跳转', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const res = await raw(port, { path: `/auth?token=${token}&next=/brand/` })
    assert.equal(res.status, 302, `实际 ${res.status}：${res.body}`)
    assert.equal(res.headers.location, '/brand/')
    // 换令牌和跳转必须在同一个响应里，否则 cookie 落不下来
    assert.match(String(res.headers['set-cookie']), /mvs_s_/)
  })
})

test('/auth?next= 拒绝站外地址（否则就是开放重定向）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    /*
     * `//evil.example.com` 是**协议相对 URL** —— 浏览器会把它当成外部站点。
     * 只判 `startsWith('/')` 会放它过去，所以必须连这个也挡掉。
     */
    for (const bad of ['//evil.example.com', 'https://evil.example.com', '/\\evil.example.com']) {
      const res = await raw(port, { path: `/auth?token=${token}&next=${encodeURIComponent(bad)}` })
      assert.equal(res.status, 204, `next=${bad} 不该跳转，实际 ${res.status}`)
      assert.equal(res.headers.location, undefined, `next=${bad} 不该给 Location`)
    }
  })
})

test('不带 next 的 /auth 仍然是 204（老行为不能变）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const res = await raw(port, { path: `/auth?token=${token}` })
    assert.equal(res.status, 204)
    assert.equal(res.headers.location, undefined)
  })
})

// ---------------------------------------------------------------------------
// 401 的两种回法
//
// 起因：有人打开一个要令牌的页面，看到的是一整屏 `{"error":"令牌缺失或不正确"}`。
// 那句话对**程序**是对的，对**人**等于什么都没说 —— 不解释为什么，也不说怎么办。
//
// 所以按请求来源分：浏览器导航给说明页，其余给 JSON。
//
// ⚠️ 样本路径要选**仍然需要令牌**的。`/brand/`、`/dsh/` 是公开静态页；
// `/` 也跟着入口文档走（复刻页当入口时它也是公开的）。这里用 `/dev` ——
// 它是一张要鉴权的 HTML 页，正好用来验「浏览器导航时的 401 长什么样」。
// ---------------------------------------------------------------------------

test('浏览器导航遇 401 → 给人看的说明页，而不是一句 JSON', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const browse = await raw(port, {
      path: '/dev',
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
    assert.equal(browse.status, 401)
    assert.match(String(browse.headers['content-type']), /text\/html/)
    assert.match(browse.body, /需要令牌/, '要说明发生了什么')
    assert.match(browse.body, /怎么打开/, '要说明怎么办')

    /*
     * ⚠️ **不能把令牌写进这个页面。**
     *
     * 它是一张未鉴权就能打开的页面 —— 把令牌放进去，等于把凭据挂在
     * 任何人敲一下地址就能看到的地方。这是这一条测试真正在守的东西。
     */
    assert.ok(!browse.body.includes(token), '说明页里不能出现令牌')
  })
})

test('API 调用遇 401 仍然是 JSON', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port }) => {
    const api = await raw(port, { path: '/state', headers: { accept: 'application/json' } })
    assert.equal(api.status, 401)
    assert.match(String(api.headers['content-type']), /application\/json/)
    assert.equal((JSON.parse(api.body) as { error: string }).error, '令牌缺失或不正确')
  })
})

test('没有 Accept 头时按 API 处理（不能默认给 HTML）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port }) => {
    const bare = await raw(port, { path: '/state' })
    assert.equal(bare.status, 401)
    assert.match(String(bare.headers['content-type']), /application\/json/)
  })
})

// ---------------------------------------------------------------------------
// 公开静态页：**现在一个都没有**
//
// 这一组原来是给 `/brand/`（审 logo 的对照页）写的：单文件、内联 CSS/SVG、
// 零 JavaScript，不调任何 API，所以给它加令牌换不到任何安全。
//
// 那两个页面（`/brand/` 与 DSH 复刻页 `/app/`）都是别人东西的复制品，
// 已经连同生成器一起删掉了。于是这条白名单空了 —— 而**空着的白名单必须被测到**：
// 否则某天有人把 `/brand` 加回去，这个页面就会以「公开」的身份重新出现。
//
// ⚠️ 围栏那两条（Host / Origin）仍然保留，只是样本路径换成 `/`：
// 它们验的是"公开不公开都要过围栏"，和具体页面无关。
// ---------------------------------------------------------------------------

test('★ 白名单是空的：/brand/ 与 /app/ 在要求令牌时都是 401', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port }) => {
    for (const path of ['/brand/', '/app/']) {
      const res = await raw(port, { path, headers: { accept: 'text/html' } })
      assert.equal(res.status, 401, `${path} 不该再被免鉴权放行，实际 ${res.status}`)
    }
  })
})

test('★ 主页面仍然过 Host 围栏（公开 ≠ 放开鉴权，没公开也一样）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port }) => {
    // 伪造 Host 是 DNS rebinding 的特征
    const rebound = await raw(port, { path: '/', host: 'evil.example.com' })
    assert.equal(rebound.status, 403, 'Host 不是回环时必须拒绝')
  })
})

test('★ 主页面仍然过 Origin 围栏', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port }) => {
    const crossSite = await raw(port, {
      path: '/',
      host: `127.0.0.1:${port}`,
      origin: 'https://evil.example.com',
    })
    assert.equal(crossSite.status, 403, '跨站 Origin 访问也要拒绝')
  })
})

test('★ 没有任何路径免鉴权（白名单空着，谁都不例外）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port }) => {
    for (const path of ['/state', '/dev', '/transactions', '/jobs', '/', '/brand/', '/app/']) {
      const res = await raw(port, { path })
      assert.equal(res.status, 401, `${path} 不该免鉴权，实际 ${res.status}`)
    }
  })
})

// ---------------------------------------------------------------------------
// 不要令牌时（**生产默认**）围栏还在不在
//
// 关掉令牌不等于关掉鉴权。真正要防的那个攻击者是**浏览器里的一个恶意页面** ——
// 它由三道围栏挡住，而那三道和令牌无关：
//
//   ① Host 必须是回环            ← 挡 DNS rebinding
//   ② Origin 若存在必须是回环    ← 挡跨站 fetch / 表单
//   ②b Sec-Fetch-Site 不是 cross-site ← 挡 `<img src>` 那类**不带 Origin**的请求
//
// ②b 是这一轮补的：它正是 ② 的缝 —— `<img>`/`<script>`/`<link>` 不带 Origin，
// ② 只能放行，但它们一定带 `Sec-Fetch-Site: cross-site`。
// 这条 DSH 有，我原来漏了。
// ---------------------------------------------------------------------------

test('★ 不要令牌：页面和 API 都能直接访问', async () => {
  await withServer(
    scriptedModel([say('x')]),
    async ({ port }) => {
      for (const path of ['/', '/state', '/dev', '/glue.js']) {
        const res = await raw(port, { path, host: `127.0.0.1:${port}` })
        assert.equal(res.status, 200, `${path} 在不要令牌时应当可访问，实际 ${res.status}`)
      }
    },
    { requireToken: false },
  )
})

test('★ 不要令牌：伪造 Host 仍然 403（DNS rebinding）', async () => {
  await withServer(
    scriptedModel([say('x')]),
    async ({ port }) => {
      const res = await raw(port, { path: '/state', host: 'evil.example.com' })
      assert.equal(res.status, 403, '关令牌不能连 Host 围栏一起关')
    },
    { requireToken: false },
  )
})

/**
 * ★ 阻断的会话必须有出口：命令存在、幂等、未知会话如实失败。
 *
 * `interrupted` 是一道**正确的**闸门（上次工具调用没结算、结果未知，不许猜），
 * 但它必须有一道门：没有门时这个会话**永久不可用**，而界面上看到的只是
 * "发消息返回成功、却毫无反应" —— 我们实测卡住过一个（工具是 `run_command`）。
 *
 * 深度语义（确认之后真的能继续）在 `session.test.ts` 里已经验过；
 * 这里守的是**接线**：命令进了分发、幂等不报错、未知会话不假装成功。
 */
test('★ acknowledge_interrupted：命令存在、幂等、未知会话如实失败', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token, sessionId }) => {
    const ok = await raw(port, {
      method: 'POST',
      path: '/command',
      host: `127.0.0.1:${port}`,
      token,
      body: { type: 'acknowledge_interrupted', sessionId },
    })
    assert.equal(ok.status, 200)
    assert.equal(
      (JSON.parse(ok.body) as { ok: boolean }).ok,
      true,
      '没被阻断的会话上调用也应当成功（幂等），而不是报错',
    )

    const missing = await raw(port, {
      method: 'POST',
      path: '/command',
      host: `127.0.0.1:${port}`,
      token,
      body: { type: 'acknowledge_interrupted', sessionId: 'ses-nope' },
    })
    assert.equal(
      (JSON.parse(missing.body) as { ok: boolean }).ok,
      false,
      '未知会话不能假装成功',
    )
  })
})

test('★ 不要令牌：跨站 Origin 仍然 403', async () => {
  await withServer(
    scriptedModel([say('x')]),
    async ({ port, sessionId }) => {
      const res = await raw(port, {
        path: '/command',
        method: 'POST',
        host: `127.0.0.1:${port}`,
        origin: 'https://evil.example.com',
        body: { type: 'user_message', sessionId, text: 'hi' },
      })
      assert.equal(res.status, 403, '关令牌不能连 Origin 围栏一起关')
    },
    { requireToken: false },
  )
})

test('★ 不要令牌：Sec-Fetch-Site=cross-site 仍然 403（这条是 Origin 的缝）', async () => {
  await withServer(
    scriptedModel([say('x')]),
    async ({ port, sessionId }) => {
      /*
       * 关键：**不带 Origin，只带 Sec-Fetch-Site**。
       *
       * 这正是 `<img src="http://127.0.0.1:3092/...">` 的形状 —— 浏览器不加
       * Origin，所以 ② 放行；但它一定加 `Sec-Fetch-Site: cross-site`。
       * 光靠 Origin 拦不住这一类。
       */
      const res = await raw(port, {
        path: '/command',
        method: 'POST',
        host: `127.0.0.1:${port}`,
        headers: { 'sec-fetch-site': 'cross-site' },
        body: { type: 'user_message', sessionId, text: 'hi' },
      })
      assert.equal(res.status, 403, '不带 Origin 的跨站请求也必须被拒')
    },
    { requireToken: false },
  )
})

test('★ 不要令牌：同源请求正常放行（围栏不能误伤）', async () => {
  await withServer(
    scriptedModel([say('x')]),
    async ({ port }) => {
      const res = await raw(port, {
        path: '/state',
        host: `127.0.0.1:${port}`,
        headers: { 'sec-fetch-site': 'same-origin' },
      })
      assert.equal(res.status, 200, '同源请求不该被围栏挡住')
    },
    { requireToken: false },
  )
})

test('★ 要令牌时 Sec-Fetch-Site 那道同样生效（不是只在关令牌时才管用）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const res = await raw(port, {
      path: '/state',
      host: `127.0.0.1:${port}`,
      token,
      headers: { 'sec-fetch-site': 'cross-site' },
    })
    assert.equal(res.status, 403, '带着有效令牌也不该放过跨站请求')
  })
})

//
// 根路径 `/` 的定级
//
// 它现在是 `web/index.html` —— 加载 `glue.js`，会调 `/state` 和 `/command`。
// 那是能执行命令的通道，所以令牌开着时必须有真凭据。
//
// 这里原来有两三条关于「入口是快照 / 入口回落到 Vue」的用例，规则是
// 「`/` 公开与否跟着入口文档走」。那套规则的前提是「同一份内容在 `/dsh/`
// 也能拿到」—— 而 `/dsh/` 已经不存在了（主页面就是 `/`），前提不成立，规则也没了。
// ---------------------------------------------------------------------------

test('★ 根路径 / 必须带令牌 —— 它是加载了逻辑层的主页面', async () => {
  /*
   * 这里原来测的是「入口是静态快照时 `/` 不要令牌」。
   * 那条规则存在的前提是「同一份内容在另一个 URL 上也能拿到」——
   * 那个 URL（`/dsh/`）已经没有了，前提也就不成立。
   */
  await withServer(scriptedModel([say('x')]), async ({ port }) => {
    const res = await raw(port, { path: '/', headers: { accept: 'text/html' } })
    assert.equal(res.status, 401, `主页面会调 API，必须带令牌。实际 ${res.status}`)
  })
})

test('主页面带令牌时正常打开（它就是 index.html）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const res = await raw(port, { path: '/', host: `127.0.0.1:${port}`, token })
    assert.equal(res.status, 200)
    assert.match(res.body, /MVS Agent 界面/)
  })
})

test('防护①：WebSocket 升级请求同样过鉴权', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    // 这是最容易漏的一道门：很多人只给 HTTP 路由加了鉴权，忘了 upgrade
    const denied = await raw(port, {
      method: 'GET',
      path: `/ws?token=${token}`,
      host: 'evil.example.com',
    })
    assert.equal(denied.status, 403)
  })
})

// ---------------------------------------------------------------------------
// 端点行为
// ---------------------------------------------------------------------------

test('索引与投影端点都可用，且投影要求指明是哪个会话', async () => {
  await withServer(scriptedModel([say('你好')]), async ({ port, token, sessionId }) => {
    const state = await raw(port, { path: '/state', host: `127.0.0.1:${port}`, token })
    assert.equal(state.status, 200)
    const parsedState = JSON.parse(state.body) as {
      state: { workspaces: unknown[]; sessions: Array<{ sessionId: string }> }
    }
    assert.equal(parsedState.state.workspaces.length, 1)
    assert.equal(parsedState.state.sessions[0]?.sessionId, sessionId)

    // 不指 sessionId 就无法回答「你要哪个会话的投影」—— 多会话下这是歧义的
    const missing = await raw(port, { path: '/projection', host: `127.0.0.1:${port}`, token })
    assert.equal(missing.status, 400)

    const projection = await raw(port, {
      path: `/projection?sessionId=${sessionId}`,
      host: `127.0.0.1:${port}`,
      token,
    })
    assert.equal(projection.status, 200)
    const parsed = JSON.parse(projection.body) as { projection: { status: string; mode: string } }
    assert.equal(parsed.projection.status, 'idle')
    assert.equal(parsed.projection.mode, 'full-access')
  })
})

test('user_message 立刻返回，不等待整轮跑完', async () => {
  // 这一轮会先给一个很长的回复，如果 POST 等它跑完，这个断言就会超时
  const long: ModelEvent[] = []
  for (let i = 0; i < 50; i += 1) long.push({ type: 'text_delta', text: `第${i}段` })
  long.push({ type: 'done', reason: 'stop' })

  await withServer(scriptedModel([long]), async ({ port, token, sessionId }) => {
    const started = Date.now()
    const res = await raw(port, {
      method: 'POST',
      path: '/command',
      host: `127.0.0.1:${port}`,
      token,
      body: { type: 'user_message', sessionId, text: '说很多' },
    })
    const elapsed = Date.now() - started
    assert.equal(res.status, 200)
    assert.ok(elapsed < 200, `POST 不该阻塞整轮，实际用了 ${elapsed}ms`)
  })
})

/*
 * `create_session` 必须把新会话的 id 回给调用方。
 *
 * 这条不是「顺手加的断言」—— DSH 的 `session/create` 契约就是返回
 * `{sessionId}`，客户端拿到后**立即**在侧栏插一行，不等列表刷新。
 * 我们只回 `{ok:true}` 的话那条路走不通，而失败现象是「点了新建没反应」，
 * 离病因很远。
 */
test('★ create_session 回传新会话的 id，且它真的进了状态', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token, sessionId }) => {
    const before = await raw(port, { path: '/state', host: `127.0.0.1:${port}`, token })
    const countBefore = (JSON.parse(before.body) as { state: { sessions: unknown[] } }).state.sessions.length

    const created = await raw(port, {
      method: 'POST',
      path: '/command',
      host: `127.0.0.1:${port}`,
      token,
      // 工作区用夹具里那个已打开的（`sessionId` 所属的会话的工作区）
      body: { type: 'create_session', workspace: (JSON.parse(before.body) as { state: { workspaces: { path: string }[] } }).state.workspaces[0]?.path },
    })
    assert.equal(created.status, 200)

    const payload = JSON.parse(created.body) as { ok: boolean; sessionId?: string }
    assert.equal(payload.ok, true)
    assert.equal(typeof payload.sessionId, 'string', '必须回 id —— 客户端靠它立刻插一行')
    assert.ok(payload.sessionId !== '', 'id 不能是空串')
    assert.notEqual(payload.sessionId, sessionId, '应当是个新会话')

    const after = await raw(port, { path: '/state', host: `127.0.0.1:${port}`, token })
    const sessions = (JSON.parse(after.body) as { state: { sessions: { sessionId: string }[] } }).state.sessions
    assert.equal(sessions.length, countBefore + 1, '状态里应当多一个会话')
    assert.ok(
      sessions.some((s) => s.sessionId === payload.sessionId),
      '回传的 id 必须真的存在于状态里，不能是编的',
    )
  })
})

// ---------------------------------------------------------------------------
// 静态资源的缓存策略
//
// 判据是「**这个文件名会不会随着内容变**」，不是扩展名。
//
// ⚠️ 这里守的是一个**不会报错的** bug：给名字固定的文件发 `immutable`，
// 浏览器就再也不来取了。服务端改多少版都没用，而开发者这边所有验证
// （无头渲染、探针、DOM dump）都**不经过浏览器缓存**，所以全都是对的。
// 两边都是真的 —— 这种不一致只能靠测试挡。
//
// 实际发生过：`dsh/glue.js` 被判成不可变、缓存一年，于是「底部没有添加工作区」——
// 因为用户浏览器里那一份是最早的版本，还没有那一行。
// ---------------------------------------------------------------------------

test('★ 名字固定的 JS 不能长缓存（否则用户永远停在旧版本）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const res = await raw(port, { path: '/glue.js', host: `127.0.0.1:${port}`, token })
    assert.equal(res.status, 200)
    const cc = String(res.headers['cache-control'])
    assert.ok(
      !/immutable/.test(cc),
      `名字固定、内容会变的文件不能发 immutable —— 浏览器从此不再来取。实际：${cc}`,
    )
    assert.match(cc, /no-cache/, `应当每次都回来问一句。实际：${cc}`)
  })
})

test('带内容哈希的产物可以长缓存（内容一变名字就变，缓存不会错）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const res = await raw(port, {
      path: '/assets/app-a1B2c3D4.js',
      host: `127.0.0.1:${port}`,
      token,
    })
    assert.equal(res.status, 200)
    assert.match(String(res.headers['cache-control']), /immutable/)
  })
})

test('HTML 一律不缓存（连问都不问）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    for (const path of ['/']) {
      const res = await raw(port, { path, host: `127.0.0.1:${port}`, token })
      assert.equal(res.status, 200)
      assert.equal(res.headers['cache-control'], 'no-store', `${path} 应当是 no-store`)
    }
  })
})

test('未知路径 404；未知审批 id 明确失败而不是静默成功', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token, sessionId }) => {
    const notFound = await raw(port, { path: '/nope', host: `127.0.0.1:${port}`, token })
    assert.equal(notFound.status, 404)

    // 先把会话加载进来 —— 审批只存在于内存里，没加载就谈不上「待确认项」
    await raw(port, { path: `/projection?sessionId=${sessionId}`, host: `127.0.0.1:${port}`, token })

    const approve = await raw(port, {
      method: 'POST',
      path: '/command',
      host: `127.0.0.1:${port}`,
      token,
      body: { type: 'approve', sessionId, approvalId: 'apr-nope', granted: true },
    })
    assert.equal(approve.status, 200)
    const parsed = JSON.parse(approve.body) as { ok: boolean; message?: string }
    assert.equal(parsed.ok, false)
    assert.match(parsed.message ?? '', /未知的审批 id/)
  })
})

test('开发页在 /dev，且走同一套鉴权', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const noToken = await raw(port, { path: '/dev', host: `127.0.0.1:${port}` })
    assert.equal(noToken.status, 401, '开发页没有特权')

    const ok = await raw(port, { path: '/dev', host: `127.0.0.1:${port}`, token })
    assert.equal(ok.status, 200)
    assert.match(ok.body, /MVS Agent/)
  })
})

// ---------------------------------------------------------------------------
// 产品界面：静态服务 + 令牌换 cookie
// ---------------------------------------------------------------------------

const setCookieOf = (res: RawResponse): string => {
  const raw = res.headers['set-cookie']
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '')
}

test('界面：/ 出的是**入口文档**，资源带正确类型', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const index = await raw(port, { path: '/', host: `127.0.0.1:${port}`, token })
    assert.equal(index.status, 200)
    assert.match(String(index.headers['content-type']), /text\/html/)
    assert.equal(index.headers['cache-control'], 'no-store', '入口文档不能缓存')

    const asset = await raw(port, {
      path: '/assets/app.js',
      host: `127.0.0.1:${port}`,
      token,
    })
    assert.equal(asset.status, 200)
    assert.match(String(asset.headers['content-type']), /javascript/)
    /*
     * ⚠️ 这里原来断言的是 `immutable`。改成断言「不是 immutable」是因为
     * 规则本身变了：`app.js` **没有内容哈希**，名字不会随内容变，
     * 所以它属于「每次回来问一句」那一档。长缓存只给带哈希的产物 ——
     * 详细理由见下面「静态资源的缓存策略」那一组。
     */
    assert.ok(
      !/immutable/.test(String(asset.headers['cache-control'])),
      '没有哈希的文件名不能长缓存',
    )
  })
})

// ---------------------------------------------------------------------------
// 入口文档：`/` 现在出**复刻页**（占位主界面）
//
// 主页面是 `web/index.html` —— **一个手改的文件**，不是构建产物。
//
// 这里原来有一组「有复刻页就出复刻页、没有就回落到 Vue」的用例，
// 判据是「文件在不在」。那层自动挑选本身就是故障面：
// **你改了 A，服务端出的是 B，而且不报错。** 现在入口写死，没有可挑的。
// ---------------------------------------------------------------------------

test('★ 入口写死：/ 就是 index.html，不做任何回落', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    const index = await raw(port, { path: '/', host: `127.0.0.1:${port}`, token })
    assert.equal(index.status, 200)
    assert.match(index.body, /MVS Agent 界面/, '夹具里的 index.html')
  })
})

test('主页面缺了就是 404，不会悄悄换一份别的出来', async () => {
  /*
   * ⚠️ 这条守的是**「报错」而不是「回落」**。
   *
   * 回落到另一份文档看起来更友好，实际是把一个明确的错误变成一次沉默的降级：
   * 你改的那份没生效，服务端没吭声，浏览器里是另一个东西。
   * 这一轮「改了但看不到」就是这么来的。
   */
  await withServer(
    scriptedModel([say('x')]),
    async ({ port, token, uiDir }) => {
      await rm(path.join(uiDir, 'index.html'), { force: true })
      const index = await raw(port, { path: '/', host: `127.0.0.1:${port}`, token })
      assert.equal(index.status, 404, '缺了就说缺了，别拿别的东西顶上')
    },
    { buildUi: true },
  )
})

test('★ 界面：换到 cookie 之后，地址栏里不必再留令牌', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    // 带着真令牌访问 —— 响应里应当带上 Set-Cookie
    const opened = await raw(port, {
      path: `/?token=${encodeURIComponent(token)}`,
      host: `127.0.0.1:${port}`,
    })
    assert.equal(opened.status, 200)

    const cookie = setCookieOf(opened)
    assert.match(cookie, /HttpOnly/, '不能给 JS 读')
    assert.match(cookie, /SameSite=Strict/, '不允许跨站带上')
    assert.equal(
      /;\s*Secure/i.test(cookie),
      false,
      'http://127.0.0.1 上加了 Secure 浏览器会直接丢弃这个 cookie，界面从此每个请求都 401',
    )
    // cookie 名必须带端口 —— cookie 作用域是 host 不是 host:port，
    // 两个 daemon 跑在不同端口时会互相覆盖令牌
    assert.match(cookie, new RegExp(`^mvs_s_${port}=`), `cookie 名应带端口：${cookie}`)

    /*
     * 必须有 Max-Age / Expires。
     *
     * 没有它就是个**会话 cookie**，浏览器一关就丢 —— 那正是「每次打开都要
     * 重新带令牌」的一半原因（另一半是令牌本身每次重启会换）。DSH 那边
     * cookie 有效期以天计，所以日常感觉不到令牌存在。
     */
    assert.match(
      cookie,
      /Max-Age=\d+/,
      `cookie 必须带有效期，否则浏览器一关就丢：${cookie}`,
    )
    const maxAge = Number.parseInt(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? '0', 10)
    assert.ok(maxAge >= 24 * 60 * 60, `有效期至少一天才有意义，实际 ${maxAge} 秒`)
    assert.ok(maxAge <= 90 * 24 * 60 * 60, `也不该长到接近永不过期，实际 ${maxAge} 秒`)

    // 之后只带 cookie，不带令牌 —— 这正是界面日常请求的样子
    const value = cookie.slice(0, cookie.indexOf(';'))
    const after = await raw(port, {
      path: '/state',
      host: `127.0.0.1:${port}`,
      cookie: value,
    })
    assert.equal(after.status, 200, '换成 cookie 之后就不该再要求令牌')
    assert.match(after.body, /"state"/)
  })
})

test('★ 界面：静态服务的路径围栏（Windows 盘符绝对路径是真实向量）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token, uiDir }) => {
    // 造一个**在 uiDir 之外**的文件。围栏要是失效，它就会被吐出去。
    const outside = path.join(path.dirname(uiDir), 'secret.png')
    await writeFile(outside, '不该被读到的内容', 'utf8')

    // ⚠️ 这个形态是实测出来的，不是想当然：
    //   `/../package.json`          → `new URL()` 已经规范化成 `/package.json`，够不到外面
    //   `/C:/Users/.../secret.png`  → **原样保留**，`path.resolve` 之后是 `C:\Users\...`，真的越界
    // URL 解析帮我们挡掉了 `..`，但挡不住盘符绝对路径 —— 而后者在 Windows 上是真实
    // 可达的。围栏要防的正是这一种。
    //
    // `encodeURI` 是必需的：临时目录路径里有中文，而 Node 的 http 客户端拒绝发送
    // 未转义的字符。转义只影响文件名部分，盘符前缀 `C:` 原样保留，所以越界性质不变。
    const driveAbsolute = encodeURI('/' + outside.replace(/\\/g, '/'))
    const escaped = await raw(port, { path: driveAbsolute, host: `127.0.0.1:${port}`, token })
    assert.equal(escaped.status, 403, `盘符绝对路径必须被围栏挡住：${driveAbsolute}`)
    assert.equal(escaped.body.includes('不该被读到'), false, '一个字节都不能漏')

    // `..` 那两种形态本来就到不了外面（URL 已经规范化），但同样不能泄露内容
    for (const form of ['/../secret.png', '/%2e%2e/secret.png', '/..%2fsecret.png']) {
      const res = await raw(port, { path: form, host: `127.0.0.1:${port}`, token })
      assert.notEqual(res.status, 200, `${form} 不该成功`)
      assert.equal(res.body.includes('不该被读到'), false, `${form} 泄露了内容`)
    }
  })
})

test('界面：主页面不在时说清楚该怎么办 —— 而且状态码是 404', async () => {
  /*
   * 正文要有用（告诉人跑什么），**状态码要是真的**。
   *
   * 原来这里是 200 —— 那是个谎：curl、日志、监控、以及我自己写的
   * `check-served.mjs` 看到的都是「成功」，于是「页面根本没生成」被静默掉了。
   * 有用的正文和正确的状态码不冲突，两个都要。
   */
  await withServer(
    scriptedModel([say('x')]),
    async ({ port, token }) => {
      const res = await raw(port, { path: '/', host: `127.0.0.1:${port}`, token })
      assert.equal(res.status, 404, '缺文件就是 404，不能报 200')
      assert.match(res.body, /web:capture/, '要告诉人抓一份快照的命令')
    },
    { buildUi: false },
  )
})

test('界面：未知路径仍然 404（没有 SPA 兜底）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token }) => {
    // 这个界面没有客户端路由，所以不该有「什么都返回 index.html」的兜底 ——
    // 有的话，任何拼错的 API 地址都会拿到 200 + 一份 HTML，问题会被藏起来
    const res = await raw(port, { path: '/nope', host: `127.0.0.1:${port}`, token })
    assert.equal(res.status, 404)
  })
})

// ---------------------------------------------------------------------------
// 观看声明的裁剪语义
// ---------------------------------------------------------------------------

/**
 * ★ 没声明 watch 的连接**收不到**流式增量，而声明之后就收得到。
 *
 * 这条钉的是服务端的裁剪语义，也是客户端那条「重连之后必须重发 watch」的**依据**。
 * 没有它，客户端那个修复看起来像是多此一举 —— 而一旦有人「顺手」把重发去掉，
 * 症状是模型生成时界面一片空白、最后整条消息才突然出现，看起来像模型慢。
 */
test('★ watch 决定流式增量推给谁：没声明就收不到，声明了就收到', async () => {
  await withServer(
    // 两段文本，中间留出时间让我们观察增量
    scriptedModel([
      [
        { type: 'text_delta', text: '第一段' },
        { type: 'text_delta', text: '第二段' },
        { type: 'done', reason: 'stop' },
      ],
    ]),
    async ({ port, token, sessionId }) => {
      // 连上但**不**声明在看
      const silentFrames: ServerFrame[] = []
      const silent = await connect(port, token, silentFrames)
      await until(() => silentFrames.find((f) => f.kind === 'state'), '整份索引')

      await raw(port, {
        method: 'POST',
        path: '/command',
        host: `127.0.0.1:${port}`,
        token,
        body: { type: 'user_message', sessionId, text: '说两句' },
      })
      await until(
        () => silentFrames.find((f) => f.kind === 'event' && f.envelope.event.type === 'turn_finished'),
        '这一轮跑完',
        () => silentFrames.map((f) => f.kind),
      )

      const silentDeltas = silentFrames.filter(
        (f) => f.kind === 'event' && f.envelope.event.type === 'model_text_delta',
      )
      assert.equal(silentDeltas.length, 0, '没声明在看就不该收到逐字流')
      assert.ok(
        silentFrames.some(
          (f) => f.kind === 'event' && f.envelope.event.type === 'assistant_message',
        ),
        '但最终消息必须收到 —— 否则连结果都看不到',
      )

      silent.close()
    },
  )
})

test('声明 watch 之后流式增量立刻开始到达', async () => {
  await withServer(
    scriptedModel([
      [
        { type: 'text_delta', text: '甲' },
        { type: 'text_delta', text: '乙' },
        { type: 'done', reason: 'stop' },
      ],
    ]),
    async ({ port, token, sessionId }) => {
      const frames: ServerFrame[] = []
      const ws = await connect(port, token, frames)
      await watchAndWaitProjection(ws, sessionId, frames)

      await raw(port, {
        method: 'POST',
        path: '/command',
        host: `127.0.0.1:${port}`,
        token,
        body: { type: 'user_message', sessionId, text: '说两句' },
      })
      await until(
        () => frames.find((f) => f.kind === 'event' && f.envelope.event.type === 'turn_finished'),
        '这一轮跑完',
        () => frames.map((f) => f.kind),
      )

      const deltas = frames
        .filter(
          (f): f is Extract<ServerFrame, { kind: 'event' }> =>
            f.kind === 'event' && f.envelope.event.type === 'model_text_delta',
        )
        .map((f) => (f.envelope.event.type === 'model_text_delta' ? f.envelope.event.text : ''))
      assert.deepEqual(deltas, ['甲', '乙'], '声明在看之后逐字流要按序到达')

      ws.close()
    },
  )
})

// ---------------------------------------------------------------------------
// 目录选择器
// ---------------------------------------------------------------------------
/** 假的目录选择器。真的那个会弹原生对话框 —— 需要人去点按钮的东西没法自动化 */
const fakePicker = (result: PickResult) => (): Promise<PickResult> => Promise.resolve(result)

test('★ 目录选择器：需要鉴权（它会让桌面弹出一个窗口）', async () => {
  await withServer(
    scriptedModel([say('x')]),
    async ({ port, token }) => {
      const denied = await raw(port, {
        method: 'POST',
        path: '/pick-directory',
        host: `127.0.0.1:${port}`,
      })
      assert.equal(denied.status, 401, '不能让人随便弹桌面窗口')

      const ok = await raw(port, {
        method: 'POST',
        path: '/pick-directory',
        host: `127.0.0.1:${port}`,
        token,
      })
      assert.equal(ok.status, 200)
      assert.deepEqual(JSON.parse(ok.body), { path: 'D:\\选中的目录', cancelled: false })
    },
    { pick: fakePicker({ path: 'D:\\选中的目录', cancelled: false }) },
  )
})

test('目录选择器：取消要如实返回 cancelled，而不是当成错误', async () => {
  await withServer(
    scriptedModel([say('x')]),
    async ({ port, token }) => {
      const res = await raw(port, {
        method: 'POST',
        path: '/pick-directory',
        host: `127.0.0.1:${port}`,
        token,
      })
      assert.deepEqual(
        JSON.parse(res.body),
        { path: null, cancelled: true },
        '用户按取消不是失败 —— 界面不该弹一条错误',
      )
    },
    { pick: fakePicker({ path: null, cancelled: true }) },
  )
})

/**
 * ★ 并发加载同一个会话不能把服务打死。
 *
 * 这条复现的是**一次真崩溃**，而且触发它的是一条完全正常的路径：界面选中会话时
 * 两条路是同一瞬间发出的 ——
 *   - WS 上声明 `watch`（服务端 `ensureSession`）
 *   - HTTP 拉 `/projection`（服务端也要 `ensureSession`）
 *
 * 没有单飞保护，同一个会话会被构造两次、`init()` 两次，于是两次并发写同一个
 * 检查点；而临时文件名当时只带 pid，两次用的是同一个临时路径 —— 一个 rename
 * 移走它，另一个 ENOENT。那个异常又没有被 HTTP 处理器接住，**整个守护进程退出**。
 *
 * 所以在 `--test-isolation=none` 下，这条测试失败的样子不是"断言不过"，
 * 而是整个测试进程消失。它同时钉住三件事：单飞、临时名唯一、处理器兜底。
 */
test('★ 并发加载同一个会话不会崩（watch 与 projection 是同时发出的）', async () => {
  await withServer(scriptedModel([say('x')]), async ({ port, token, sessionId }) => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        raw(port, {
          path: `/projection?sessionId=${encodeURIComponent(sessionId)}`,
          host: `127.0.0.1:${port}`,
          token,
        }),
      ),
    )

    for (const res of results) assert.equal(res.status, 200, res.body)

    // 每一次拿到的都必须是同一份、可解析的投影
    const ids = new Set(
      results.map((r) => (JSON.parse(r.body) as { projection: { sessionId: string } }).projection.sessionId),
    )
    assert.deepEqual([...ids], [sessionId])

    // 服务还得活着
    const health = await raw(port, { path: '/health', host: `127.0.0.1:${port}`, token })
    assert.equal(health.status, 200)
    assert.equal((JSON.parse(health.body) as { ok: boolean }).ok, true)
  })
})

test('★ ensureSession 是单飞的：并发请求同一个会话只构造一个实例', async () => {  // 上一条测的是「不崩」，这一条直接测**机制**：单飞的意思是同一个会话只会被
  // 构造一次。没有它，会话会被 init 两次、事件日志里会出现两条 session_started,
  // 而两条各自持有的内存状态会开始分叉 —— 谁最后写进去谁赢，另一个成了幽灵。
  await withServer(scriptedModel([say('x')]), async ({ runtime, sessionId }) => {
    const [a, b, c] = await Promise.all([
      runtime.ensureSession(sessionId),
      runtime.ensureSession(sessionId),
      runtime.ensureSession(sessionId),
    ])

    assert.ok(a !== undefined)
    assert.equal(a, b, '并发请求必须拿到同一个实例')
    assert.equal(b, c, '并发请求必须拿到同一个实例')
    assert.equal(runtime.getLoaded(sessionId), a, '索引里记下的也必须是那一个')
  })
})

/**
 * ★ 请求处理器抛错时，服务必须继续活着。
 *
 * 这条兜底是**用一个真崩溃换来的**：并发写检查点抛出的 ENOENT 从
 * `#handleRequest` 逸了出去，而那个回调是 `void` 调用的 —— 于是变成
 * unhandled rejection，Node 默认让**进程退出**。用户看到的是窗口突然全白，
 * 而且完全不知道为什么。
 *
 * 那条具体的崩溃已经被单飞和临时名唯一两道防线堵住了；这一条测的是**最后一道**：
 * 无论前面哪一层漏了，服务都不该被一个坏请求杀死。
 */
test('★ 请求处理器抛错时返回 500，而不是让进程退出', async () => {
  await withServer(
    scriptedModel([say('x')]),
    async ({ port, token }) => {
      const res = await raw(port, {
        method: 'POST',
        path: '/pick-directory',
        host: `127.0.0.1:${port}`,
        token,
      })
      assert.equal(res.status, 500, '要兜成一个 500')
      assert.match(res.body, /boom/, '错误内容要可见，不能静默成一句"内部错误"')

      // 关键：后面的请求还得正常 —— 这才是"没退出"的证据
      const health = await raw(port, { path: '/health', host: `127.0.0.1:${port}`, token })
      assert.equal(health.status, 200, '服务必须还活着')
    },
    {
      pick: () => Promise.reject(new Error('boom')),
    },
  )
})

// ---------------------------------------------------------------------------
// WebSocket 端到端
// ---------------------------------------------------------------------------

/**
 * 连上并收集帧。
 *
 * ⚠️ **监听必须在 `await open` 之前挂上。** 服务端握手一完成就推索引，
 * 等 open 事件回来再挂 listener 就来不及了 —— WebSocket 的 message 事件
 * 没有监听器时是**直接丢掉**的，那一帧永远看不到了。
 */
function connect(port: number, token: string, frames: ServerFrame[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`)
    ws.addEventListener('message', (event: MessageEvent) => {
      frames.push(JSON.parse(String(event.data)) as ServerFrame)
    })

    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(ws)
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket 连接失败'))
    })
  })
}

/**
 * 轮询等待一个条件成立。
 *
 * `describe` 和 `saw` 不是装饰：等超时时只说「等待超时」，会把「什么都没到」
 * 和「到的东西不对」这两种完全不同的故障压成同一个错误，让人只能靠猜。
 */
async function until<T>(
  check: () => T | undefined,
  describe = '条件',
  saw?: () => unknown,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value !== undefined) return value
    if (Date.now() > deadline) {
      const observed = saw === undefined ? '' : `；实际收到：${JSON.stringify(saw())}`
      throw new Error(`等待超时：等 ${describe} 没等到${observed}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * 连接起来并 watch 一个会话，等它的投影到手。
 *
 * 现在的流程是：**连上先拿整份索引（`state`），再显式 watch 才拿到会话投影。**
 * 这个两段式是刻意的 —— 侧栏靠索引立刻画出工作区树，而单个会话的完整消息
 * 只在真的要看时才拉。
 *
 * watch 必须发在 WebSocket 上：它声明的是「这条连接在看哪个会话」，一次性的
 * HTTP 请求没有可归属的连接（服务器会明确拒绝这种用法，而不是假装成功）。
 */
async function watchAndWaitProjection(
  ws: WebSocket,
  sessionId: string,
  frames: ServerFrame[],
): Promise<void> {
  await until(
    () => frames.find((f) => f.kind === 'state'),
    '连上时的整份索引（state）',
    () => frames.map((f) => f.kind),
  )
  ws.send(JSON.stringify({ type: 'watch', sessionIds: [sessionId] }))
  await until(
    () => frames.find((f) => f.kind === 'projection'),
    `watch ${sessionId} 之后的会话投影（projection）`,
    () => frames.map((f) => f.kind),
  )
}

test('WebSocket：连上先收到整份索引，watch 之后才拿到会话投影', async () => {
  await withServer(scriptedModel([say('你好')]), async ({ port, token, sessionId }) => {
      const frames: ServerFrame[] = []
      const ws = await connect(port, token, frames)

    const first = await until(
      () => frames[0],
      '连上后的第一帧',
      () => frames.length,
    )
    assert.equal(
      first.kind,
      'state',
      '第一帧必须是索引 —— 侧栏靠它立刻画出工作区树和「谁在等我」的徽标',
    )

    if (first.kind === 'state') {
      assert.equal(first.state.workspaces.length, 1)
      assert.equal(first.state.sessions.length, 1)
      assert.equal(first.state.sessions[0]?.sessionId, sessionId)
      // 索引里的配置必须是打码的 —— 明文密钥不能出这个边界
      assert.equal(
        JSON.stringify(first.state).includes('apiKey":'),
        true,
        '配置应该在索引里（UI 要显示它）',
      )
    }

    // 还没 watch 之前，不该有会话投影
    assert.equal(
      frames.some((f) => f.kind === 'projection'),
      false,
      '没声明在看哪个会话之前，不该推它的消息',
    )

    await watchAndWaitProjection(ws, sessionId, frames)
    const projection = frames.find((f) => f.kind === 'projection')
    assert.ok(projection !== undefined)

    ws.close()
  })
})

test('WebSocket：端到端跑一轮，事件按序到达', async () => {
  await withServer(
    scriptedModel([call('c1', 'write_file', { path: 'a.txt', content: 'hi' }), say('写好了')]),
    async ({ port, token, sessionId }) => {
      const frames: ServerFrame[] = []
      const ws = await connect(port, token, frames)

      await watchAndWaitProjection(ws, sessionId, frames)

      // 通过 HTTP 发命令（浏览器也可以用 WS 发）
      const res = await raw(port, {
        method: 'POST',
        path: '/command',
        host: `127.0.0.1:${port}`,
        token,
        body: { type: 'user_message', sessionId, text: '写文件' },
      })
      assert.equal(res.status, 200)

      const finished = await until(() =>
        frames.find((f) => f.kind === 'event' && f.envelope.event.type === 'turn_finished'),
      )
      assert.ok(finished)

      const types = frames
        .filter((f): f is Extract<ServerFrame, { kind: 'event' }> => f.kind === 'event')
        .map((f) => f.envelope.event.type)

      // 顺序敏感：意图必须在结算之前
      assert.ok(types.indexOf('tool_intent') >= 0)
      assert.ok(
        types.indexOf('tool_intent') < types.indexOf('tool_settled'),
        `事件顺序不对：${types.join(',')}`,
      )
      assert.ok(types.includes('policy_decision'))

      ws.close()
    },
  )
})

test('★★ 明文密钥绝不出边界 —— 索引里的配置必须是打码的', async () => {
  // 协议里写着「明文密钥永不出这个边界」。注释不是保证，这条测试才是。
  //
  // ⚠️ 原来那条断言是 `JSON.stringify(state).includes('apiKey":')` —— 它只证明
  // 这个**字段存在**。真泄漏了明文，那个检查照样通过。所以这里换成一个能失败的
  // 断言：把明文当**子串**在整个索引里找。
  const SECRET = 'sk-supersecret-abcdef1234567890'
  await withServer(
    scriptedModel([say('x')]),
    async ({ port, token }) => {
      const response = await raw(port, { token, path: '/state' })
      assert.equal(response.status, 200, response.body)

      assert.equal(
        response.body.includes(SECRET),
        false,
        '明文密钥出现在推给客户端的索引里 —— 这是最严重的一类泄漏',
      )
      // 不是「因为没配密钥所以看不到」—— 必须真有密钥、且被打码
      assert.ok(
        response.body.includes('sk-…7890'),
        `应当给出打码形式（前 3 后 4），实际：${response.body.slice(0, 400)}`,
      )
      assert.ok(response.body.includes('apiKeyIsPlaintext'), '要告诉界面它是不是明文存的')
    },
    { configPatch: { version: 1, model: { apiKey: SECRET, model: 'x' } } },
  )
})

test('WebSocket：审批请求能推到客户端，客户端也能回答案', async () => {  await withServer(
    // ⚠️ 这条命令必须**不是可证明只读的**，否则它会被只读分类器自动放行，
    // 于是根本没有审批可推 —— 这个用例会以「等超时」的形式失败，而原因
    // 看起来和审批毫无关系。（实测踩过：原来写的是 `echo approved-run`，
    // 而 `echo` 在只读表里。）
    //
    // `node -e process.exit(0)` 满足两点：不在只读表里（`node` 只放行
    // --version），而且执行起来是瞬时的、无副作用的。
    //
    // 也不要用 `npm test`：临时工作区里 npm 会向上找到仓库根的 package.json，
    // 于是**递归跑整个测试套件**，子进程一直占着工作区目录，拆场 rmdir 报 EBUSY。
    scriptedModel([
      call('c1', 'run_command', { command: 'node', args: ['-e', 'process.exit(0)'] }),
      say('跑完了'),
    ]),
    async ({ port, token, sessionId }) => {
      const frames: ServerFrame[] = []
      const ws = await connect(port, token, frames)

      await watchAndWaitProjection(ws, sessionId, frames)

      await raw(port, {
        method: 'POST',
        path: '/command',
        host: `127.0.0.1:${port}`,
        token,
        body: { type: 'user_message', sessionId, text: '跑测试' },
      })

      const requested = await until(() =>
        frames.find(
          (f): f is Extract<ServerFrame, { kind: 'event' }> =>
            f.kind === 'event' && f.envelope.event.type === 'approval_requested',
        ),
      )
      const approvalId = requested.envelope.event.type === 'approval_requested'
        ? requested.envelope.event.approvalId
        : ''
      assert.ok(approvalId.startsWith('apr-'))

      // 客户端回答案 —— 这条路径通了，才叫「人在回路里」
      const answered = await raw(port, {
        method: 'POST',
        path: '/command',
        host: `127.0.0.1:${port}`,
        token,
        body: { type: 'approve', sessionId, approvalId, granted: true },
      })
      const parsed = JSON.parse(answered.body) as { ok: boolean }
      assert.equal(parsed.ok, true, '应答通道必须先于广播就绪，否则这里会拿到未知 id')

      await until(() =>
        frames.find((f) => f.kind === 'event' && f.envelope.event.type === 'turn_finished'),
      )

      ws.close()
    },
    { mode: 'workspace-write' },
  )
})

// ---------------------------------------------------------------------------
// 撤销
// ---------------------------------------------------------------------------

/** 取会话的完整投影（模拟界面刷新时的迟到加入） */
async function getProjection(
  port: number,
  token: string,
  sessionId: string,
): Promise<{
  status: string
  toolCalls: Array<{
    callId: string
    tool: string
    ok: boolean
    summary: string
    undoTxnId: string | null
    reverted: boolean
  }>
}> {
  const res = await raw(port, {
    method: 'GET',
    path: `/projection?sessionId=${encodeURIComponent(sessionId)}`,
    host: `127.0.0.1:${port}`,
    token,
  })
  assert.equal(res.status, 200)
  const parsed = JSON.parse(res.body) as {
    projection: {
      status: string
      toolCalls: Array<{
        callId: string
        tool: string
        ok: boolean
        summary: string
        undoTxnId: string | null
        reverted: boolean
      }>
    }
  }
  return parsed.projection
}

const exists = async (p: string): Promise<boolean> =>
  stat(p).then(
    () => true,
    () => false,
  )

/**
 * 撤销的完整来回。
 *
 * 这是整个 UI 里唯一一个**会改磁盘**的按钮，所以它必须证明三件事，缺一件都会
 * 让用户按下去之后不知道发生了什么：
 *   1. 文件真的回去了（不是只改了个标记）
 *   2. 撤销本身可撤销（重做是撤销那个撤销事务）
 *   3. 刷新之后按钮状态还在 —— 靠投影里的 toolCalls，不是靠这个标签页的记忆
 */
test('撤销：文件改动能撤掉、能重做，且刷新后状态仍在投影里', async () => {
  await withServer(
    scriptedModel([
      call('c1', 'write_file', { path: 'a.txt', content: 'hi' }),
      say('写好了'),
    ]),
    async ({ port, token, sessionId, workspace }) => {
      const frames: ServerFrame[] = []
      const ws = await connect(port, token, frames)
      await watchAndWaitProjection(ws, sessionId, frames)

      await raw(port, {
        method: 'POST',
        path: '/command',
        host: `127.0.0.1:${port}`,
        token,
        body: { type: 'user_message', sessionId, text: '写文件' },
      })
      await until(
        () => frames.find((f) => f.kind === 'event' && f.envelope.event.type === 'turn_finished'),
        '一轮跑完',
        () => frames.map((f) => f.kind),
      )

      const target = path.join(workspace, 'a.txt')
      assert.equal(await readFile(target, 'utf8'), 'hi', '先确认文件真的写出来了')

      // ① 投影里带着这次调用的撤销引用 —— 界面靠它在刷新后重建按钮
      const before = await getProjection(port, token, sessionId)
      const ref = before.toolCalls.find((t) => t.callId === 'c1')
      assert.ok(ref !== undefined, '一次改动文件的工具调用必须留下撤销引用')
      assert.equal(ref.tool, 'write_file')
      assert.equal(ref.reverted, false)
      const undoTxnId = ref.undoTxnId
      assert.ok(undoTxnId !== null, '撤销引用必须指向一个可用的事务')

      // ② 撤销 —— 文件回到「没写过」的样子
      const undone = await raw(port, {
        method: 'POST',
        path: '/command',
        host: `127.0.0.1:${port}`,
        token,
        body: { type: 'revert', sessionId, txnId: undoTxnId },
      })
      assert.equal(
        (JSON.parse(undone.body) as { ok: boolean }).ok,
        true,
        `撤销应该成功：${undone.body}`,
      )
      assert.equal(await exists(target), false, '新增的文件被撤掉之后应该不存在了')

      // ③ 刷新后的投影说「已撤销」，并且给出重做要撤哪个事务
      const after = await getProjection(port, token, sessionId)
      const ref2 = after.toolCalls.find((t) => t.callId === 'c1')
      assert.ok(ref2 !== undefined)
      assert.equal(ref2.reverted, true, '撤销之后状态必须翻转')
      assert.ok(
        ref2.undoTxnId !== null && ref2.undoTxnId !== undoTxnId,
        '重做不是重复撤销同一个事务 —— 应该是撤销「撤销动作自身」产生的新事务',
      )

      const redone = await raw(port, {
        method: 'POST',
        path: '/command',
        host: `127.0.0.1:${port}`,
        token,
        body: { type: 'revert', sessionId, txnId: ref2.undoTxnId },
      })
      assert.equal((JSON.parse(redone.body) as { ok: boolean }).ok, true, '重做应该成功')
      assert.equal(await readFile(target, 'utf8'), 'hi', '重做之后文件内容回到改完的样子')

      const final = await getProjection(port, token, sessionId)
      assert.equal(
        final.toolCalls.find((t) => t.callId === 'c1')?.reverted,
        false,
        '重做之后又回到「未撤销」这一边',
      )

      // 撤销事件必须落盘 —— 否则刷新之后没人知道发生过
      const reverted = frames.filter(
        (f) => f.kind === 'event' && f.envelope.event.type === 'revert_settled',
      )
      assert.equal(reverted.length, 2, '两次撤销动作都应该是可见事件')

      ws.close()
    },
  )
})

test('撤销：未知会话明确失败，而不是静默成功', async () => {
  await withServer(scriptedModel([say('嗯')]), async ({ port, token }) => {
    const res = await raw(port, {
      method: 'POST',
      path: '/command',
      host: `127.0.0.1:${port}`,
      token,
      body: { type: 'revert', sessionId: 'nosuch', txnId: 'txn-1' },
    })
    const parsed = JSON.parse(res.body) as { ok: boolean; message: string }
    assert.equal(parsed.ok, false)
    assert.match(parsed.message, /未知会话/)
  })
})

// ---------------------------------------------------------------------------
// POST /model-config
// ---------------------------------------------------------------------------
/**
 * 这一组是补上来的 —— 这条路由**原来一条测试都没有**，而它的请求体形状
 * 有个很安静的陷阱：
 *
 *     const body = payload as { profile?, baseUrl?, model?, contextWindow? }
 *     if (typeof body.model === 'string') patch.model = body.model
 *
 * `model` 是**字符串**（模型名）。发 `{ model: { baseUrl: '…' } }` 的话
 * `typeof` 判断失败 → **一个字段都不改**，却照样回 200 `{ok:true}`。
 *
 * 设置面板就栽在这上面：点保存不报错、值也不变。所以下面有一条**专门钉住
 * 这个形状**的用例 —— 光测"能改"是不够的，得把"错形状会静默失败"也钉死。
 */

/** 从一次响应里拿模型配置视图 */
const modelView = async (port: number, token: string) => {
  const res = await raw(port, { path: '/model-config', host: `127.0.0.1:${port}`, token })
  return JSON.parse(res.body) as {
    profile: string
    model: { baseUrl: string; model: string; contextWindow?: number }
  }
}

test('★ POST /model-config：`baseUrl` 是**扁平**字段，改了要生效', async () => {
  await withServer(scriptedModel([say('嗯')]), async ({ port, token }) => {
    const before = await modelView(port, token)
    const next = before.model.baseUrl.replace(':11434', ':19999')

    const res = await raw(port, {
      method: 'POST',
      path: '/model-config',
      host: `127.0.0.1:${port}`,
      token,
      body: { baseUrl: next },
    })
    assert.equal(res.status, 200)

    const after = await modelView(port, token)
    assert.equal(after.model.baseUrl, next, 'baseUrl 必须真的改了')
  })
})

test('★★ POST /model-config：`model` 给成对象会被**静默忽略** —— 这正是设置面板那个 bug', async () => {
  /*
   * 这条钉的不是"功能"而是"坑的形状"。
   *
   * 如果哪天有人把服务端改得"宽容"了（接受对象形式的 model），这条会失败 ——
   * 那时候**应该**失败，因为垫片当初就是按对象形状发的，而那样发是错的。
   * 与其让错误形状重新变得可用，不如让它明确地无效。
   */
  await withServer(scriptedModel([say('嗯')]), async ({ port, token }) => {
    const before = await modelView(port, token)

    const res = await raw(port, {
      method: 'POST',
      path: '/model-config',
      host: `127.0.0.1:${port}`,
      token,
      body: { model: { baseUrl: 'http://127.0.0.1:19998/v1' } },
    })
    assert.equal(res.status, 200, '它照样回 200 —— 这才是危险的地方')
    assert.equal(JSON.parse(res.body).ok, true)

    const after = await modelView(port, token)
    assert.equal(
      after.model.baseUrl,
      before.model.baseUrl,
      '对象形状的 model 不该改到任何东西（它被 typeof 判断挡掉了）',
    )
  })
})

test('★ POST /model-config：`apiKey` 写得进，而且**明文不出边界**', async () => {
  /*
   * `apiKey` 这一项在 `updateModel` 的 patch 类型里**缺了很久** ——
   * 后果不是报错，是"设置页里那个密钥框改了存不进去"。
   *
   * 这里同时验两件事：
   *   · 写得进（回读到的打码值变了）
   *   · 读出来的是**打码**的，不是明文
   *
   * 只验前者的话，"把明文原样回给前端"也能通过 —— 那是更严重的错。
   */
  await withServer(scriptedModel([say('嗯')]), async ({ port, token }) => {
    const secret = 'sk-selftest-0000deadbeef'
    const res = await raw(port, {
      method: 'POST',
      path: '/model-config',
      host: `127.0.0.1:${port}`,
      token,
      body: { apiKey: secret },
    })
    assert.equal(res.status, 200)

    const state = await raw(port, { path: '/state', host: `127.0.0.1:${port}`, token })
    const body = state.body
    assert.ok(!body.includes(secret), '**明文密钥不能出现在 /state 的响应里**')
    assert.ok(body.includes('sk-'), '应该有一个打码后的值，好让界面显示"已配置"')
  })
})

test('★ POST /model-config：`apiKey: ""` 是「清掉」，不是「没填」', async () => {
  /*
   * 空串和缺省必须分得开：
   *   · 缺省 = 这次不改它
   *   · 空串 = 显式地不要密钥了
   *
   * 混掉的话用户就**清不掉**已经存下的密钥 —— 而"我换了端点，旧密钥得删掉"
   * 是很常见的一步。
   */
  await withServer(
    scriptedModel([say('嗯')]),
    async ({ port, token }) => {
      const cleared = await raw(port, {
        method: 'POST',
        path: '/model-config',
        host: `127.0.0.1:${port}`,
        token,
        body: { apiKey: '' },
      })
      assert.equal(cleared.status, 200)

      const state = await raw(port, { path: '/state', host: `127.0.0.1:${port}`, token })
      /* ⚠️ `/state` 的响应**包了一层**：`{ state: { config: … } }` */
      const parsed = JSON.parse(state.body) as {
        state: { config: { model: { apiKey: string } } }
      }
      assert.equal(parsed.state.config.model.apiKey, '', '空串必须真的把密钥清掉')
    },
    /* 配置里先放一把明文密钥，否则"清掉"和"本来就没有"分不出来 */
    { configPatch: { version: 1, model: { apiKey: 'sk-preexisting-secret' } } },
  )
})

// ---------------------------------------------------------------------------
// 供应商库 / 可选模型
// ---------------------------------------------------------------------------

test('★★ POST /model-config：`providers` 写得进，而且**从 /state 读得回来**', async () => {
  /*
   * ⚠️ **这条钉的是"添加供应商看不见"那个 bug 的两半。**
   *
   * 那次的现象是：对话框关了、没报错、供应商不见了。查出来是**两处**：
   *   ① 垫片对不认识的路径静默跳过，然后照样回 `ok`
   *   ② `/state` 只暴露当前生效那一份 —— **写入通，但读的这条路少了一段**
   *
   * 只修 ① 的话，文件里会有而界面上没有（"保存成功但看不到"），
   * 所以这半条断言（读得回来）和写进去一样重要。
   */
  await withServer(
    scriptedModel([say('嗯')]),
    async ({ port, token }) => {
      const wrote = await raw(port, {
        method: 'POST',
        path: '/model-config',
        host: `127.0.0.1:${port}`,
        token,
        body: {
          providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } },
        },
      })
      assert.equal(wrote.status, 200)

      const state = await raw(port, { path: '/state', host: `127.0.0.1:${port}`, token })
      const parsed = JSON.parse(state.body) as {
        state: {
          config: {
            providers: Record<string, { model?: string; baseUrl?: string }>
            activeProvider: string
          }
        }
      }
      assert.equal(parsed.state.config.providers.deepseek?.model, 'deepseek-chat')
      assert.equal(parsed.state.config.activeProvider, 'mvs', '没设 activeProvider 时回 mvs')
    },
    { configPatch: { version: 1 } },
  )
})

test('★★ providers：写进去的密钥**在 /state 里必须是打码的**', async () => {
  /*
   * `providers` 这一项是新加的出口，**明文密钥永不出这个边界**的规矩
   * 必须同样适用于它。漏掉一个的话，那个供应商的明文密钥会随 `/state`
   * 发给页面 —— 而这正是这条边界存在的唯一理由。
   */
  await withServer(
    scriptedModel([say('嗯')]),
    async ({ port, token }) => {
      await raw(port, {
        method: 'POST',
        path: '/model-config',
        host: `127.0.0.1:${port}`,
        token,
        body: {
          providers: {
            risky: { baseUrl: 'https://x/v1', model: 'm', apiKey: 'sk-plaintext-must-not-leak' },
          },
        },
      })
      const state = await raw(port, { path: '/state', host: `127.0.0.1:${port}`, token })
      assert.ok(
        !state.body.includes('sk-plaintext-must-not-leak'),
        '明文密钥**绝不能**出现在 /state 里',
      )
      const parsed = JSON.parse(state.body) as {
        state: { config: { providers: Record<string, { apiKey?: string }> } }
      }
      assert.notEqual(parsed.state.config.providers.risky?.apiKey, 'sk-plaintext-must-not-leak')
      assert.ok(
        String(parsed.state.config.providers.risky?.apiKey).includes('…'),
        '给的是打码形式（sk-…xxxx）',
      )
    },
    { configPatch: { version: 1 } },
  )
})

test('★ POST /model-config：`models` 是可选模型目录，空数组是有意义的', async () => {
  /*
   * 「添加模型」要能存下**第二个**模型名。原实现是取列表第一个，
   * 于是加第二个时补丁是空的 —— 回了 `ok` 却什么都没存。
   */
  await withServer(
    scriptedModel([say('嗯')]),
    async ({ port, token }) => {
      const two = await raw(port, {
        method: 'POST',
        path: '/model-config',
        host: `127.0.0.1:${port}`,
        token,
        body: { model: 'qwen3.6', models: ['qwen3.6', 'deepseek-chat'] },
      })
      assert.equal(two.status, 200)

      const state = await raw(port, { path: '/state', host: `127.0.0.1:${port}`, token })
      const parsed = JSON.parse(state.body) as {
        state: { config: { model: { model: string; models?: string[] } } }
      }
      assert.equal(parsed.state.config.model.model, 'qwen3.6', '当前选中的那个没被列表带跑')
      assert.deepEqual(parsed.state.config.model.models, ['qwen3.6', 'deepseek-chat'])
    },
    { configPatch: { version: 1, model: { model: 'qwen3.6' } } },
  )
})

test('POST /model-config：`removeProviders` 删得掉，且不碰别的', async () => {
  await withServer(
    scriptedModel([say('嗯')]),
    async ({ port, token }) => {
      await raw(port, {
        method: 'POST',
        path: '/model-config',
        host: `127.0.0.1:${port}`,
        token,
        body: {
          providers: { keep: { model: 'a' }, drop: { model: 'b' } },
        },
      })
      await raw(port, {
        method: 'POST',
        path: '/model-config',
        host: `127.0.0.1:${port}`,
        token,
        body: { removeProviders: ['drop'] },
      })

      const state = await raw(port, { path: '/state', host: `127.0.0.1:${port}`, token })
      const parsed = JSON.parse(state.body) as {
        state: { config: { providers: Record<string, unknown> } }
      }
      assert.deepEqual(Object.keys(parsed.state.config.providers), ['keep'], '只删指定的那个')
    },
    { configPatch: { version: 1 } },
  )
})

/*
 * ---------------------------------------------------------------------------
 * 作业：人能停掉模型起的后台进程
 * ---------------------------------------------------------------------------
 */

/**
 * `kill_job` 一直是**工具**（模型能调），而人没有入口：模型起了一个
 * `npm run dev` 之后，用户要么让它去停，要么重启守护进程 —— 可
 * `JobRegistry.kill()` 早就写好了（连进程树一起杀）。
 *
 * 这条命令把它接出来。三种结果必须分开说，不能混成一句「失败了」：
 *   会话不存在 / 作业不存在 / 作业已经结束了
 */
test('kill_job 命令：能停掉模型起的后台作业，重复停会说明原因', async () => {
  await withServer(
    scriptedModel([
      call('c1', 'run_command', {
        command: 'node',
        args: ['-e', 'setTimeout(() => {}, 120000)'],
        background: true,
      }),
      say('在后台跑着'),
    ]),
    async ({ port, token, sessionId }) => {
      const host = `127.0.0.1:${port}`
      const sent = await raw(port, {
        method: 'POST',
        path: '/command',
        host,
        token,
        body: { type: 'user_message', sessionId, text: '起个后台作业' },
      })
      assert.equal(sent.status, 200, `发消息失败：${sent.body}`)

      const runningJobId = async (): Promise<string | undefined> => {
        for (let i = 0; i < 100; i += 1) {
          const res = await raw(port, {
            path: `/jobs?sessionId=${encodeURIComponent(sessionId)}`,
            host,
            token,
          })
          if (res.status === 200) {
            const parsed = JSON.parse(res.body) as { jobs: Array<{ id: string; running: boolean }> }
            const running = parsed.jobs.find((job) => job.running)
            if (running !== undefined) return running.id
          }
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return undefined
      }

      const jobId = await runningJobId()
      assert.ok(jobId !== undefined, '应当看到一个运行中的作业（模型刚起的那个）')

      const killed = await raw(port, {
        method: 'POST',
        path: '/command',
        host,
        token,
        body: { type: 'kill_job', sessionId, jobId },
      })
      assert.equal(killed.status, 200)
      assert.ok(killed.body.includes('"ok":true'), `kill_job 应当成功，实际：${killed.body}`)

      let stopped = false
      for (let i = 0; i < 100; i += 1) {
        const res = await raw(port, {
          path: `/jobs?sessionId=${encodeURIComponent(sessionId)}`,
          host,
          token,
        })
        const parsed = JSON.parse(res.body) as { jobs: Array<{ id: string; running: boolean }> }
        if (parsed.jobs.some((job) => job.id === jobId && !job.running)) {
          stopped = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(stopped, '停掉之后作业应当被标记为已结束')

      /* 再停一次：必须说清「已经结束了」，而不是假装成功 */
      const again = await raw(port, {
        method: 'POST',
        path: '/command',
        host,
        token,
        body: { type: 'kill_job', sessionId, jobId },
      })
      assert.ok(again.body.includes('已经结束'), `重复停要说清原因，实际：${again.body}`)

      /* 不存在的作业：也说清楚，而不是 ok */
      const missing = await raw(port, {
        method: 'POST',
        path: '/command',
        host,
        token,
        body: { type: 'kill_job', sessionId, jobId: 'job-doesnotexist' },
      })
      assert.ok(missing.body.includes('没有作业'), `未知作业要说清楚，实际：${missing.body}`)

      /* 未知会话：另一种失败，不能和上面两种混在一起 */
      const unknownSession = await raw(port, {
        method: 'POST',
        path: '/command',
        host,
        token,
        body: { type: 'kill_job', sessionId: 'no-such-session', jobId },
      })
      assert.ok(unknownSession.body.includes('未知会话'), `未知会话要说清楚，实际：${unknownSession.body}`)
    },
    { mode: 'full-access' },
  )
})

/*
 * ---------------------------------------------------------------------------
 * 成本：用量 × 单价，且"不知道"时不给假数
 * ---------------------------------------------------------------------------
 */

test('投影里的 cost：配了单价才算，算出来要能对上', async () => {
  await withServer(
    scriptedModel([
      [
        { type: 'text_delta', text: '好' },
        { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 500_000 } },
        { type: 'done', reason: 'stop' },
      ],
    ]),
    async ({ port, token, sessionId }) => {
      await raw(port, {
        method: 'POST',
        path: '/command',
        host: `127.0.0.1:${port}`,
        token,
        body: { type: 'user_message', sessionId, text: '随便说点什么' },
      })

      let cost: { input: number; output: number; total: number; currency: string } | undefined
      for (let i = 0; i < 100; i += 1) {
        const res = await raw(port, {
          path: `/projection?sessionId=${encodeURIComponent(sessionId)}`,
          host: `127.0.0.1:${port}`,
          token,
        })
        if (res.status === 200) {
          const parsed = JSON.parse(res.body) as {
            projection: { cost?: { input: number; output: number; total: number; currency: string } }
          }
          if (parsed.projection.cost !== undefined) {
            cost = parsed.projection.cost
            break
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      assert.ok(cost !== undefined, '配了单价就该算出成本')
      assert.equal(cost.input, 3, `输入 100 万 token × $3，实际 ${cost.input}`)
      assert.equal(cost.output, 6, `输出 50 万 token × $12，实际 ${cost.output}`)
      assert.equal(cost.total, 9)
      assert.equal(cost.currency, 'USD')
    },
    { configPatch: { version: 1, model: { model: 'x', pricing: { inputPerMTok: 3, outputPerMTok: 12 } } } },
  )
})

test('投影里的 cost：没配单价 → 字段不出现（不是 0）', async () => {
  await withServer(
    scriptedModel([
      [
        { type: 'text_delta', text: '好' },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
        { type: 'done', reason: 'stop' },
      ],
    ]),
    async ({ port, token, sessionId }) => {
      await raw(port, {
        method: 'POST',
        path: '/command',
        host: `127.0.0.1:${port}`,
        token,
        body: { type: 'user_message', sessionId, text: '随便说点什么' },
      })

      let seen = false
      for (let i = 0; i < 100; i += 1) {
        const res = await raw(port, {
          path: `/projection?sessionId=${encodeURIComponent(sessionId)}`,
          host: `127.0.0.1:${port}`,
          token,
        })
        if (res.status === 200) {
          const parsed = JSON.parse(res.body) as {
            projection: { totalUsage?: unknown; cost?: unknown }
          }
          /* 等到用量有了，再确认成本**没有** */
          if (parsed.projection.totalUsage !== undefined) {
            assert.equal(
              'cost' in parsed.projection,
              false,
              `没有单价时不该出现 cost：${JSON.stringify(parsed.projection.cost)}`,
            )
            seen = true
            break
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(seen, '应当先看到用量')
    },
  )
})

/*
 * ---------------------------------------------------------------------------
 * 逐行差异与会话搜索
 * ---------------------------------------------------------------------------
 */

test('/diff：先给文件清单，点名文件再给 hunks', async () => {
  await withServer(
    scriptedModel([
      call('c1', 'write_file', { path: 'hello.txt', content: '第一行\n第二行\n' }),
      say('写好了'),
    ]),
    async ({ port, token, sessionId }) => {
      const host = `127.0.0.1:${port}`
      await raw(port, {
        method: 'POST',
        path: '/command',
        host,
        token,
        body: { type: 'user_message', sessionId, text: '写个文件' },
      })

      /* 等事务出现 —— 事务是"真的产生了变化"的证据 */
      let txnId: string | undefined
      for (let i = 0; i < 100 && txnId === undefined; i += 1) {
        const res = await raw(port, { path: `/transactions?sessionId=${encodeURIComponent(sessionId)}`, host, token })
        if (res.status === 200) {
          const parsed = JSON.parse(res.body) as { transactions: Array<{ id: string }> }
          txnId = parsed.transactions[0]?.id
        }
        if (txnId === undefined) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(txnId !== undefined, '应当产生一个事务')

      const listed = await raw(port, {
        path: `/diff?sessionId=${encodeURIComponent(sessionId)}&txnId=${encodeURIComponent(txnId)}`,
        host,
        token,
      })
      assert.equal(listed.status, 200, listed.body)
      const files = JSON.parse(listed.body) as {
        files: Array<{ path: string; change: string; newSize?: number }>
      }
      const hello = files.files.find((file) => file.path === 'hello.txt')
      assert.ok(hello !== undefined, `清单里应当有 hello.txt：${listed.body}`)
      assert.equal(hello.change, 'added')

      const detailed = await raw(port, {
        path: `/diff?sessionId=${encodeURIComponent(sessionId)}&txnId=${encodeURIComponent(txnId)}&path=hello.txt`,
        host,
        token,
      })
      assert.equal(detailed.status, 200, detailed.body)
      const file = JSON.parse(detailed.body) as {
        file: { change: string; added: number; hunks: Array<{ lines: Array<{ kind: string; text: string }> }> }
      }
      assert.equal(file.file.added, 2, `两行都是新增：${detailed.body}`)
      const kinds = file.file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.kind))
      assert.ok(kinds.every((kind) => kind === 'add'), `应当全是 add：${kinds.join(',')}`)
      const texts = file.file.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))
      assert.deepEqual(texts, ['第一行', '第二行'])
    },
  )
})

test('/diff：这条事务里没有的文件 → 404，而不是空结果', async () => {
  await withServer(
    scriptedModel([
      call('c1', 'write_file', { path: 'only.txt', content: 'x\n' }),
      say('好了'),
    ]),
    async ({ port, token, sessionId }) => {
      const host = `127.0.0.1:${port}`
      await raw(port, {
        method: 'POST',
        path: '/command',
        host,
        token,
        body: { type: 'user_message', sessionId, text: '写' },
      })

      let txnId: string | undefined
      for (let i = 0; i < 100 && txnId === undefined; i += 1) {
        const res = await raw(port, { path: `/transactions?sessionId=${encodeURIComponent(sessionId)}`, host, token })
        if (res.status === 200) {
          const parsed = JSON.parse(res.body) as { transactions: Array<{ id: string }> }
          txnId = parsed.transactions[0]?.id
        }
        if (txnId === undefined) await new Promise((resolve) => setTimeout(resolve, 100))
      }
      assert.ok(txnId !== undefined)

      const missing = await raw(port, {
        path: `/diff?sessionId=${encodeURIComponent(sessionId)}&txnId=${encodeURIComponent(txnId)}&path=${encodeURIComponent('不在这条事务里.txt')}`,
        host,
        token,
      })
      assert.equal(missing.status, 404, '不在这条事务里的文件不该给 200')

      const noParams = await raw(port, { path: '/diff', host, token })
      assert.equal(noParams.status, 400, '缺参数是用法错误')
    },
  )
})

test('/search：能搜到刚才说过的内容，并报出扫了多少', async () => {
  await withServer(
    scriptedModel([say('好的')]),
    async ({ port, token, sessionId }) => {
      const host = `127.0.0.1:${port}`
      await raw(port, {
        method: 'POST',
        path: '/command',
        host,
        token,
        body: { type: 'user_message', sessionId, text: '这里有个特别的词 蓝鲸号 ' },
      })
      /* 等事件落盘（搜索读的是磁盘上的日志，不是内存里的会话） */
      await new Promise((resolve) => setTimeout(resolve, 300))

      const found = await raw(port, { path: `/search?q=${encodeURIComponent('蓝鲸号')}`, host, token })
      assert.equal(found.status, 200, found.body)
      const result = JSON.parse(found.body) as {
        matches: Array<{ sessionId: string; role: string; snippet: string }>
        stats: { sessions: number; events: number; truncated?: string }
      }
      assert.equal(result.matches.length >= 1, true, `应当命中：${found.body}`)
      assert.equal(result.matches[0]!.sessionId, sessionId)
      assert.match(result.matches[0]!.snippet, /蓝鲸号/)
      assert.ok(result.stats.sessions >= 1)
      assert.ok(result.stats.events >= 1)
      /* 完全搜完时不该有截断说明 —— 这是"没有"与"没搜完"的分界 */
      assert.equal(result.stats.truncated, undefined)

      const none = await raw(port, { path: `/search?q=${encodeURIComponent('完全没有的词xyz')}`, host, token })
      assert.equal(none.status, 200, none.body)
      const empty = JSON.parse(none.body) as { matches: unknown[]; stats: { sessions: number } }
      assert.equal(empty.matches.length, 0)
      assert.ok(empty.stats.sessions >= 1, '搜不到也要说明扫了多少')

      const bad = await raw(port, { path: `/search?q=${encodeURIComponent('([')}&regex=1`, host, token })
      assert.equal(bad.status, 400, `正则写错应当是 400：${bad.body}`)
      assert.match(bad.body, /正则/)

      const blank = await raw(port, { path: '/search', host, token })
      assert.equal(blank.status, 400, '缺 q 是用法错误')
    },
  )
})
