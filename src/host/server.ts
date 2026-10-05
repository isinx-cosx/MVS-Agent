/**
 * 传输层：本地 HTTP + WebSocket。
 *
 * ## 这里新开了一个能执行命令的端口，所以四道防护一个都不能省
 *
 * 我们前面花了大量篇幅讨论「怎么让 agent 不越界」。如果在这里开一个
 * 谁都能连的端口，前面那些讨论就被一次性绕过了。所以：
 *
 * 1. **只绑 127.0.0.1** —— 绝不 `0.0.0.0`
 * 2. **必须带令牌** —— 启动时随机生成，比较用 `timingSafeEqual`
 * 3. **校验 `Host` 头必须是回环** —— 这是挡 **DNS rebinding** 的关键
 * 4. **校验 `Origin`** —— 挡恶意网页发起的跨站请求
 *
 * 第 3 条最容易被忽略：攻击者让自己的域名解析到 127.0.0.1，然后诱导用户的浏览器
 * 去访问它。此时请求确实打在回环地址上，但 `Host` 头是攻击者的域名。
 * 只检查「是不是来自本地」是不够的，必须检查 `Host` 本身。
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, mkdir, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { ClientCommand, Envelope, ServerFrame } from '../protocol/types.ts'
import { EPHEMERAL_EVENTS } from '../protocol/types.ts'

/**
 * 每条连接最多记多少个"关注中的会话"。
 *
 * `watch` 现在是**只增不减**（见那条命令的处理）—— 那是为了不让任何一个包误伤
 * 别的会话的增量订阅 ✓。代价是集合会一直长，所以给个上限，超了淘汰最早加的。
 */
const WATCH_LIMIT = 64
import type { Runtime } from './runtime.ts'
import { pickDirectory, type PickResult } from './directory-picker.ts'
import { devClientHtml } from './dev-client.ts'
import { WebSocketConnection, tryUpgrade } from './websocket.ts'
import { loadOrCreateToken, newToken } from './token.ts'
import { resolvePickerKind, type PickerCapability } from './picker.ts'
import { isBrowseFailure, listDirectory } from './directory-browse.ts'

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const MAX_BODY_BYTES = 1024 * 1024

/**
 * 会话 cookie 的有效期（秒）。7 天。
 *
 * 不加 `Max-Age` 它就是个**会话 cookie**，浏览器一关就丢 —— 那正是
 * 「每次打开都要重新带令牌」的一半原因（另一半是令牌本身每次重启会换）。
 *
 * 对齐 DSH 的做法：它的 cookie 载荷里带 `expiresAt`，有效期以天计。
 * 取值上取「久到感觉不到，又不至于变成一个永不过期的凭据」。
 */
const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

/**
 * **无需令牌**的静态页前缀。
 *
 * 现在只剩品牌对照页 —— 它是审 logo 用的工具页，纯静态、零 JS、不含秘密。
 *
 * ⚠️ 主页面（`/`）**不在**这里。它加载 glue.js、会调 `/state` 和 `/command` ——
 * 那是能执行命令的通道，必须有真凭据（令牌开着的时候）。
 */
const PUBLIC_STATIC_PREFIXES = ['/brand']

/**
 * 服务端发的东西在哪儿。
 *
 * ## ⚠️ 这里是**源码目录**，不是构建输出
 *
 * 主页面就是一个文件：`web/index.html`。**直接编辑它、刷新浏览器，就完了。**
 *
 * 我一度把它放在 `dist/web/dsh/` 当成构建产物，于是每改一行都要走一遍
 * 「构建 → 注入脚本 → 算内容哈希 → 重启」。那套东西**一行都不需要** ——
 * 它带来的全部是故障面（构建要 Edge、注入会插错位置、哈希算错就等于缓存没生效）。
 *
 * 它唯一「生成」的时刻是**首次从 DSH 抓那一份 DOM**，而那件事很少发生。
 * 抓完就提交，从此它是我们的文件，由我们手改。
 *
 * `web/app/` 和 `web/brand/` 仍然是工具生成的（一个是要跑 DSH 前端的实验，
 * 一个是 logo 对照页），它们有各自的前缀，互不影响。
 */
const UI_DIR = fileURLToPath(new URL('../../web/', import.meta.url))
/**
 * 根路径出哪一份文档。
 *
 * 就一个名字。原来这里有一串候选（可运行版 → 静态快照 → Vue），
 * 而那个「按文件在不在自动挑一份」的逻辑本身就是故障面：
 * **你改了 A，服务端出的是 B，而且不报错。**
 */
const ENTRY_DOCUMENT = 'index.html'

/**
 * 我们认识的扩展名 → MIME。
 *
 * ## ⚠️ 这张表**同时**决定「哪些路径交给静态处理」
 *
 * `looksLikeAsset()` 拿它当已知扩展名表用。两个概念（发什么 MIME / 路由到哪）
 * 被耦合在一张表上 —— 这不算好设计，但**漏了一项的后果是 404**，
 * 而且是安静的：前端每个页面都请求 `manifest.webmanifest`，
 * 缺了就每次刷新留一条 404，没人会注意到。
 *
 * 所以这张表必须覆盖**产物里真实存在的每一种扩展名**。
 * 实测 `web/` 里的分布（改这张表之前先重新数一遍）：
 *
 *     .js 132 · .woff2 22 · .ttf 20 · .woff 20 · .css 2 · .svg 2 · .html 2
 *     .txt 1 · .webmanifest 1
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

export interface HostServerOptions {
  runtime: Runtime
  /** 0 = 随机端口（默认） */
  port?: number
  /** 直接指定令牌（测试用）。**给了它就不再读文件** */
  token?: string
  /**
   * 令牌文件路径。给了它就会「读得到就复用、读不到就生成并写回」。
   *
   * 生产路径由 CLI 传 `defaultHomeDir()/host-token`；测试不传，
   * 于是仍然拿到一个内存里的随机令牌 —— **测试不会去碰真实的家目录**。
   */
  tokenFile?: string
  /** 是否提供内置开发页（默认 false）。它不是产品 UI，只是一张体检表 */
  serveDevClient?: boolean
  /** 前端构建产物目录。测试注入临时目录，默认 `dist/web` */
  uiDir?: string
  /**
   * 目录选择器。**测试注入假实现** —— 真的那个会弹出一个原生对话框，
   * 而一个需要人去点按钮的测试不是测试。
   */
  pickDirectory?: () => Promise<PickResult>
  /**
   * 是否**要求令牌**。
   *
   * ## 默认 false —— 开发阶段不需要
   *
   * 本机只有你一个人用，而唯一真正需要防的那个攻击者（**浏览器里的一个恶意页面**）
   * 由 Host / Origin / Sec-Fetch-Site 三道围栏挡住 —— 那些是免费的，一直开着。
   *
   * 令牌多挡的那一类是「**同一台机器上的另一个账户**」：回环端口不按用户隔离，
   * 另一个账户能连上它，而它发的是直接导航（不带 Origin），围栏拦不住。
   * 开发阶段没有这个场景。
   *
   * ## 什么时候该打开
   *
   *   · 这个服务要对**别人**可达时（共用机器、或者哪天支持非回环绑定）
   *   · 需要把「能连上端口」和「有权限」分成两件事时
   *
   * 打开方式是 CLI 的 `--require-token`。打开后行为回到原来那套：
   * `?token=` 一次性换 cookie，`/api` 和 `/` 都要凭据。
   *
   * ⚠️ 关掉它**不等于**关了围栏。Host / Origin / Sec-Fetch-Site 三道与令牌无关，
   * 一直生效 —— 它们挡的是 DNS rebinding 和跨站请求，那是另一个类别的问题。
   */
  requireToken?: boolean
}

export interface HostServerInfo {
  origin: string
  wsUrl: string
  token: string
  port: number
}

interface Denial {
  status: number
  message: string
}

/**
 * 静态资源该带什么 `cache-control`。
 *
 * 判据是**这个文件名会不会随着内容变**，不是扩展名。
 *
 * | 是什么 | 文件名 | 策略 |
 * |---|---|---|
 * | HTML 入口 | 固定 | `no-store` —— 连问都不问，直接用新的 |
 * | 构建产物 | 带内容哈希 | `immutable` —— 内容一变名字就变，缓存一年也不会错 |
 * | 其余（比如 `glue.js`） | 固定 | `no-cache` —— 每次回来问一句「变了没有」 |
 *
 * ⚠️ 中间那一档用错会**静默地把用户钉在一个旧版本上**。
 * `glue.js` 就是受害的那个：名字固定、内容一直在改，却被判成不可变 ——
 * 于是服务端改了七八版，浏览器一版都没取。而我这边所有验证（无头渲染、
 * 探针、DOM dump）**都不经过浏览器缓存，所以全都是对的**。
 *
 * 认不出哈希形状就走 `no-cache` —— 两种错法里，多一次往返远比「用户看到旧页面」
 * 便宜，而后者根本不会报错。
 */
function cachePolicyFor(filename: string, type: string): string {
  if (type.startsWith('text/html')) return 'no-store'
  // Vite 的产物形状：`app-a1B2c3D4.js`、`index-5SrrfWpU.css`
  const hashed = /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(filename)
  if (hashed) return 'public, max-age=31536000, immutable'
  /*
   * ★ **非哈希的 UI 源文件（`replica-shim.js`、页面脚本）走 `no-cache`。**
   *
   * 契约写在这里，测试也守着它（`test/server.test.ts` 的"名字固定的 JS 不能长缓存"）。
   * 含义是：**每次用之前都必须回源校验** —— 而这条策略不发 ETag / Last-Modified，
   * 于是校验退化成一次完整 GET ✓。对本地小文件来说这已经够强了。
   *
   * ⚠️ **不要改成 `no-store` 或 `immutable`。**
   * 前者是多此一举（`no-cache` 已经保证回源），后者是这里出过的事故：
   * 名字固定、内容一直在改的文件被判成不可变，于是**服务端改了七八版、浏览器一版
   * 都没取**，而开发侧的验证（无头渲染、探针、DOM dump）**全都不经过浏览器缓存**，
   * 所以看上去一切正常。真正根治这类问题的办法是**让文件名随内容变**（上面的
   * 带哈希那一档），而不是靠档位调参。
   */
  return 'no-cache'
}

export class HostServer {
  #runtime: Runtime
  #port: number
  #token: string
  #server: Server | null = null
  /**
   * 每条连接 + 它声明在看的会话集合。
   *
   * **索引类状态全部推，token 级增量只推正在看的** —— 没有这条，
   * 多会话下每开一个标签页都会收到其他会话的逐字流，纯属浪费。
   */
  #clients = new Map<WebSocketConnection, Set<string>>()
  #unsubscribe: (() => void) | null = null
  #serveDevClient: boolean
  #uiDir: string
  #pickDirectory: () => Promise<PickResult>
  /** `listen()` 之后才知道的真实端口。cookie 名要用它 */
  #actualPort = 0
  /** 令牌是怎么来的 —— 启动横幅要把它说出来 */
  #tokenSource: 'explicit' | 'created' | 'reused' | 'memory' = 'memory'
  /** 旧令牌文件内容不合法、被换掉时的原值（只用于提示） */
  #tokenFileNote: string | undefined
  /** 是否要求令牌。默认 false —— 见 `HostServerOptions.requireToken` */
  #requireToken: boolean
  /**
   * 目录选择用哪个后端。
   *
   * **在构造时算定一次，此后不变。** 这是照 DSH 的做法：能力在服务生命周期内
   * 稳定，消费者可以安全地缓存 `GET /picker` 的结果。
   * 每次请求都重算的话，同一台机器上两个浏览器会看到不同的形态。
   */
  #picker: PickerCapability

  /** 让 CLI 能说明「令牌是新建的还是会复用的」 */
  get tokenSource(): 'explicit' | 'created' | 'reused' | 'memory' {
    return this.#tokenSource
  }

  get tokenFileNote(): string | undefined {
    return this.#tokenFileNote
  }

  constructor(options: HostServerOptions) {
    this.#runtime = options.runtime
    this.#port = options.port ?? 0

    /*
     * 令牌：显式给了就用（测试），给了文件就**读得到就复用**，否则内存随机。
     *
     * 这三种来源的优先级是刻意的 —— 显式参数最高，因为测试要能完全控制它；
     * 文件其次，因为那是「链接能不失效」的唯一手段；都没有才退回随机，
     * 那时行为和不持久化时一样（测试走的就是这条）。
     */
    if (options.token !== undefined) {
      this.#token = options.token
      this.#tokenSource = 'explicit'
    } else if (options.tokenFile !== undefined) {
      const loaded = loadOrCreateToken(options.tokenFile)
      this.#token = loaded.token
      this.#tokenSource = loaded.created ? 'created' : 'reused'
      this.#tokenFileNote = loaded.replaced
    } else {
      this.#token = newToken()
      this.#tokenSource = 'memory'
    }

    this.#serveDevClient = options.serveDevClient ?? false
    this.#uiDir = options.uiDir ?? UI_DIR
    this.#pickDirectory = options.pickDirectory ?? pickDirectory
    this.#requireToken = options.requireToken ?? false
    this.#picker = resolvePickerKind()
  }

  /**
   * 目录选择的能力（`native` / `browse`）与判定理由。
   *
   * CLI 拿它决定横幅上说什么、以及要不要提示用户「原生框会开在服务器屏幕上」。
   */
  get picker(): PickerCapability {
    return this.#picker
  }

  /** 是否要求令牌。CLI 用它决定横幅上说什么 */
  get requireToken(): boolean {
    return this.#requireToken
  }

  async listen(): Promise<HostServerInfo> {
    const server = createServer((req, res) => {
      /**
       * ⚠️ **必须 catch。** 这个回调是 `void` 调用的，任何逸出的异常都会变成
       * unhandled rejection，而 Node 的默认行为是**让进程退出**。
       *
       * 这是用一个真崩溃换来的教训：界面选中会话时并发加载同一个会话，
       * 两次写检查点撞上同一个临时文件名，rename 抛 ENOENT —— 整个守护进程
       * 就这么没了。一个长期跑在本地的服务**不该被一个坏请求杀死**：用户看到的是
       * 「窗口突然全白了」，而且不知道为什么。
       *
       * 所以这里兜底成 500。错误本身仍然要可见（写进 stderr），不能静默 ——
       * 静默的 500 会让下一个 bug 更难查。
       */
      this.#handleRequest(req, res).catch((err: unknown) => {
        const message = messageOf(err)
        process.stderr.write(`  ⚠ 请求处理失败 ${req.method ?? ''} ${req.url ?? ''}：${message}\n`)
        if (res.headersSent) {
          // 已经开始写了，只能断开 —— 硬塞一个 500 会得到半个应答拼半个错误页
          res.destroy()
          return
        }
        try {
          sendJson(res, 500, { error: `服务端内部错误：${message}` })
        } catch {
          res.destroy()
        }
      })
    })
    server.on('upgrade', (req, socket, head) => {
      this.#handleUpgrade(req, socket as Duplex, head)
    })
    this.#server = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      // ★ 只绑回环。写成 0.0.0.0 就等于把这个能执行命令的端口暴露给整个局域网
      server.listen(this.#port, '127.0.0.1', () => resolve())
    })

    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : this.#port
    this.#actualPort = port

    this.#unsubscribe = this.#runtime.subscribe((frame) => {
      this.#broadcast(frame)
    })

    return { origin: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, token: this.#token, port }
  }

  async close(): Promise<void> {
    this.#unsubscribe?.()
    this.#unsubscribe = null
    for (const [client] of this.#clients) client.close(1001, 'server shutting down')
    this.#clients.clear()
    const server = this.#server
    this.#server = null
    if (server === null) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  // -------------------------------------------------------------------------
  // 鉴权
  // -------------------------------------------------------------------------

  #authorize(req: IncomingMessage, url: URL): Denial | null {
    // ① Host 必须是回环 —— 挡 DNS rebinding
    const host = req.headers.host
    if (typeof host !== 'string' || host === '') {
      return { status: 403, message: '缺少 Host 头' }
    }
    const hostname = stripPort(host).toLowerCase()
    if (!LOOPBACK_NAMES.has(hostname)) {
      return {
        status: 403,
        message: `Host「${hostname}」不是回环地址。这类请求可能来自 DNS rebinding，已拒绝。`,
      }
    }

    // ② Origin 若存在，必须是回环
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
      if (!isLoopbackOrigin(origin)) {
        return { status: 403, message: `Origin「${origin}」不被允许` }
      }
    }

    /*
     * ②b 浏览器自报的来源是「跨站」→ 拒。
     *
     * `Sec-Fetch-Site` 是**浏览器自己加的**、页面改不了的一条断言。
     * 它补的正是 ② 的缝：`<img src>` / `<script src>` / `<link>` 这类请求
     * **不带 Origin**，所以 ② 只能放行；但它们一定带 `Sec-Fetch-Site: cross-site`。
     *
     * 这条 DSH 有（`isTrustedApiRequest` 里那句 `=== "cross-site"`），我原来漏了。
     * 它比令牌更准：令牌是「谁拿到都能用」，而这是对**这一次请求的实际来源**的断言。
     * 所以哪怕关掉了令牌，这一条也留着。
     */
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      return { status: 403, message: '跨站请求不被允许' }
    }

    /*
     * ③ 无需令牌的页面。
     *
     * `/brand/` 和 `/dsh/` 是**单文件、内联 CSS、内联 SVG、零 JavaScript** 的静态页，
     * 不调用任何 API，也不含任何秘密。给它们加令牌只是让人多拿一次凭据，
     * **换不到任何安全** —— 因为这里没有需要保护的东西。
     *
     * 这也是 DSH 的做法：它的设计说明里写着「非 index 静态资产保持公开」。
     *
     * ⚠️ **绝不能把 `/api/` 加进来**。那是能执行命令的通道，
     * 而且 Host 是客户端自己填的 header —— 能连上 socket 就能声明自己是 localhost，
     * 所以「Host 是回环」不构成认证，那些路径必须有真凭据。
     *
     * ⚠️ ① ② 两道**仍然对公开页生效**。它们挡的是 DNS rebinding 和跨站请求，
     * 和「要不要令牌」是两件事，不该一起放掉。
     */
    if (this.#isPublicPage(url.pathname)) return null

    /*
     * ④ 令牌 —— **默认不要求**（见 `HostServerOptions.requireToken` 的说明）。
     *
     * 关掉时这里直接放行；① ② ②b 三道围栏在上面，与令牌无关，一直生效。
     */
    if (!this.#requireToken) return null

    if (!this.#tokenMatches(req, url)) {
      return { status: 401, message: '令牌缺失或不正确' }
    }

    return null
  }

  /**
   * 这条路径当前是不是「无需令牌」的。
   *
   * 判据是「**这份文档里有没有需要保护的东西**」：
   *
   *   · `/brand/` —— 审 logo 的对照页。纯静态、零 JS、不调任何 API → 公开
   *   · `/`       —— **主页面**。加载 glue.js，会调 `/state` 和 `/command` → 要令牌
   *
   * 原来这里还有一层「根路径跟着入口文档走」的判断，是为了兼容
   * 「`/` 时而出静态快照、时而出别的东西」。现在 `/` 永远是同一个文件，
   * 那层判断只会成为故障面 —— 删掉。
   */
  #isPublicPage(pathname: string): boolean {
    for (const prefix of PUBLIC_STATIC_PREFIXES) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true
    }
    return false
  }

  // -------------------------------------------------------------------------
  // 会话 cookie
  //
  // 令牌放 URL 里能跑，但它会进浏览器历史和书签 —— 对一个「本地能执行命令的
  // 服务」来说，那是一份不该长期留存的东西。所以换 httpOnly cookie。
  // -------------------------------------------------------------------------

  /**
   * cookie 名**必须带端口**。
   *
   * ⚠️ 这是个容易漏的坑：**cookie 的作用域是 host，不是 host:port。**
   * 于是两个 daemon 分别跑在 `127.0.0.1:3090` 和 `127.0.0.1:3091` 时会共用
   * 同一个 cookie 名，互相把对方的令牌覆盖掉 —— 表现是「打开第二个界面，
   * 第一个突然 401」。把端口写进名字就按服务分开了。
   *
   * 端口是 `listen()` 之后才知道的（默认用 0 取随机端口），所以名字得在那之后算。
   */
  get #cookieName(): string {
    return `mvs_s_${this.#actualPort}`
  }

  /**
   * 构造 Set-Cookie。
   *
   * ⚠️ **刻意没有 `Secure`。** 这个服务跑在 `http://127.0.0.1` 上 ——
   * 加 `Secure` 会让浏览器直接拒绝保存它，界面从此每个请求都 401，
   * 而原因很难从现象上看出来。回环地址上的明文 HTTP 是这个产品的既定形态
   * （不是临时妥协），所以这不是「为了开发方便而放松」，是它本来就不适用。
   *
   * `Max-Age` 是**必须的**：不加就是个会话 cookie，浏览器一关就丢，
   * 于是「每次打开都要重新带令牌」。DSH 那边 cookie 有效期以天计，
   * 这里对齐到 7 天 —— 足够久到感觉不到，又不至于变成一个永不过期的凭据。
   */
  #sessionCookie(): string {
    return (
      `${this.#cookieName}=${this.#token}; HttpOnly; SameSite=Strict; Path=/; ` +
      `Max-Age=${COOKIE_MAX_AGE_SECONDS}`
    )
  }

  #cookieMatches(req: IncomingMessage): boolean {
    const raw = req.headers.cookie
    if (typeof raw !== 'string' || raw === '') return false
    for (const part of raw.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      if (part.slice(0, eq).trim() !== this.#cookieName) continue
      return this.#constantTimeEquals(decodeURIComponent(part.slice(eq + 1).trim()))
    }
    return false
  }

  #tokenMatches(req: IncomingMessage, url: URL): boolean {
    const header = req.headers.authorization
    if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
      if (this.#constantTimeEquals(header.slice(7).trim())) return true
    }
    // 浏览器无法给 WebSocket 设置请求头，所以查询串这条路必须留
    const query = url.searchParams.get('token')
    if (query !== null && this.#constantTimeEquals(query)) return true
    // 换过 cookie 之后就走这条 —— 界面的日常请求全用它
    return this.#cookieMatches(req)
  }

  #constantTimeEquals(provided: string): boolean {
    const a = Buffer.from(provided, 'utf8')
    const b = Buffer.from(this.#token, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  async #handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    const denial = this.#authorize(req, url)
    if (denial !== null) {
      /*
       * 浏览器**直接导航**过来（地址栏敲 URL、点了个旧书签、点了个过期链接）时，
       * 给一张能看懂的页面，而不是丢一句 JSON。
       *
       * 起因：有人打开 `/brand/` 看到的是一整屏 `{"error":"令牌缺失或不正确"}`。
       * 那句 JSON 对 API 调用是对的，但对**人**来说等于什么都没说 ——
       * 它不告诉人「为什么」也不告诉人「怎么办」。
       *
       * 判据用 `Sec-Fetch-Mode: navigate`（现代浏览器导航时都会带），
       * 回退看 `Accept` 里有没有 text/html。这样 fetch/XHR 仍然拿到 JSON。
       */
      if (denial.status === 401 && req.method === 'GET' && isBrowserNavigation(req)) {
        sendHtml(res, 401, tokenHelpPage(url.pathname))
        return
      }
      sendJson(res, denial.status, { error: denial.message })
      return
    }

    /**
     * 凡是**靠查询串里的令牌**通过鉴权的请求，顺手把令牌换成 cookie。
     *
     * 这样后面所有静态资源请求都不必再带令牌，而客户端换完就能把地址栏里的
     * 令牌 `replaceState` 抹掉 —— 历史和书签里都不会留下它。
     *
     * 放在这里而不是某个专门的端点，是为了让「打开链接」这一个动作就够了：
     * HTML 和它引用的资源不会各自遇到一次 401。
     */
    const cookies: Record<string, string> = url.searchParams.has('token')
      ? { 'set-cookie': this.#sessionCookie() }
      : {}

    // 显式的换令牌端点。开发时前端由 Vite 开发服务器提供，HTML 不经过这里，
    // 所以那条路需要一个单独可代理的地址来完成同一件事。
    if (req.method === 'GET' && url.pathname === '/auth') {
      /*
       * 只接受站内绝对路径。
       *
       * ⚠️ 只判 `startsWith('/')` **不够**，有两种会被浏览器当成站外地址：
       *
       *   `//evil.com`   协议相对 URL —— 直接就是外部站点
       *   `/\evil.com`   反斜杠会被**规范化成斜杠**，于是等价于上面那种
       *
       * 第二种是我自己写的第一版漏掉的，是补回归测试时才发现的
       * （test/server.test.ts 里那三条 `next=` 用例）。
       */
      const next = url.searchParams.get('next')
      const looksInternal =
        next !== null && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
      if (looksInternal && next !== null) {
        res.writeHead(302, { location: next, 'cache-control': 'no-store', ...cookies })
        res.end()
        return
      }
      res.writeHead(204, { 'cache-control': 'no-store', ...cookies })
      res.end()
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      // `clients` 是刻意暴露的：它是从外面回答「界面到底连上了没有」的唯一办法。
      // 没有它，一个白屏的前端和一个正常的前端看起来完全一样 —— 都只是
      // 「没有请求」而已。
      sendJson(res, 200, {
        ok: true,
        sessions: this.#runtime.state().sessions.length,
        clients: this.#clients.size,
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/state') {
      sendJson(res, 200, { state: this.#runtime.state() })
      return
    }

    if (req.method === 'GET' && url.pathname === '/projection') {
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null) {
        sendJson(res, 400, { error: '缺少 sessionId' })
        return
      }
      const session = await this.#runtime.ensureSession(sessionId)
      if (session === undefined) {
        sendJson(res, 404, { error: `未知会话：${sessionId}` })
        return
      }
      sendJson(res, 200, { projection: session.projection() })
      return
    }

    // 可撤销事务列表。
    //
    // 单独一个端点而不是塞进投影：撤销记录属于**工作区**（工作区里有几千个文件、
    // 几百次工具调用），投影属于会话。而且它只在打开撤销菜单时才要看一眼，
    // 没必要让每次 watch 都背上它。
    if (req.method === 'GET' && url.pathname === '/transactions') {
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null) {
        sendJson(res, 400, { error: '缺少 sessionId' })
        return
      }
      const transactions = await this.#runtime.listTransactions(sessionId)
      if (transactions === undefined) {
        sendJson(res, 404, { error: `未知会话：${sessionId}` })
        return
      }
      sendJson(res, 200, { transactions })
      return
    }

    // 开发用页面。刻意走同一套鉴权 —— 它没有特权。
    //
    // 它现在在 `/dev` 而不是 `/`：`/` 归产品界面。这张体检表仍然有用
    // （能连上就说传输通了、能点「允许」就说审批通道通了），但它是给
    // 开发者的，不该占着产品入口。
    if (req.method === 'GET' && url.pathname === '/dev') {
      if (!this.#serveDevClient) {
        sendJson(res, 404, { error: '未启用内置开发页（加 --dev）' })
        return
      }
      const body = devClientHtml()
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
        ...cookies,
      })
      res.end(body)
      return
    }

    // 后台作业列表。
    //
    // 和 `/transactions` 同一个理由：作业属于**工作区**，而界面按会话操作，
    // 所以入口按会话进、执行时回到工作区。它也不是每次 watch 都需要的东西。
    if (req.method === 'GET' && url.pathname === '/jobs') {
      const sessionId = url.searchParams.get('sessionId')
      if (sessionId === null) {
        sendJson(res, 400, { error: '缺少 sessionId' })
        return
      }
      const jobs = this.#runtime.listJobs(sessionId)
      if (jobs === undefined) {
        sendJson(res, 404, { error: `未知会话：${sessionId}` })
        return
      }
      sendJson(res, 200, { jobs })
      return
    }

    // 打开一个原生目录选择框，把选中的**绝对路径**回给界面。
    //
    // 为什么需要守护进程来做：浏览器故意不提供绝对路径 ——
    // `showDirectoryPicker()` 给的是句柄，`<input webkitdirectory>` 给的是文件名。
    // 而工作区根必须是一个真实绝对路径。
    //
    // ⚠️ 它**只返回一个字符串，不授予任何访问权**。「打开工作区」仍是另一条
    // 独立命令，会写审计记录。所以「能弹出选择框」≠「能读那个目录」。
    if (req.method === 'POST' && url.pathname === '/pick-directory') {
      sendJson(res, 200, await this.#pickDirectory())
      return
    }

    /*
     * 目录选择**能力**。
     *
     * 界面先问这个，再决定「添加工作区」点了之后发生什么：
     *
     *   native —— 让服务端开系统对话框
     *   browse —— 界面自己画一个目录浏览器（走 `/picker/dirs`）
     *
     * 为什么要有这一步：系统对话框开在**守护进程那台机器的屏幕上**。
     * 通过 SSH 或从别的机器开界面时，操作者看不见它 —— 点了「添加工作区」
     * 什么都没发生，而服务端正开着框在等一个看不见的人点。
     * 那种情况下失败的不是机制，是**形态**。
     *
     * 值在启动时算定、此后不变（见 `picker.ts`），所以界面可以缓存它。
     */
    if (req.method === 'GET' && url.pathname === '/picker') {
      sendJson(res, 200, this.#picker)
      return
    }

    /*
     * 浏览后端：列一层目录。
     *
     * ⚠️ 它**接受任意绝对路径**，不限制在工作区内 —— 这是有意的：
     * 「选一个工作区」这个动作本来就发生在工作区之外，你要挑的就是一个新的根。
     *
     * 这不算越权：守护进程以当前用户身份运行，本来就能读那些目录；
     * 这条接口和其它所有接口一样在回环 + Host/Origin 围栏后面。
     * 它**只返回目录名**，不给文件内容、也不给文件名。
     */
    if (req.method === 'GET' && url.pathname === '/picker/dirs') {
      const raw = url.searchParams.get('path')
      /*
       * ⚠️ **不传 `path` = 「此电脑」那一层（所有盘），不是主目录。**
       *
       * DSH 的约定是「absent lists the home directory」，我照做了 ——
       * 然后实测发现**`D:\` 点不到**：那个浏览器的祖先链是从路径的根往上走的
       * （它自己的 `ancestryCrumbs`），Windows 上**没有盘符列表**，
       * 而 `D:\` 是 `C:\` 的**兄弟**、不是子目录。弹层里实测一个盘符入口都没有，
       * 而用户的模型和项目都在 D 盘。
       *
       * 换成「此电脑」之后第一次打开就能看到所有盘，而 `home` 仍然是真主目录
       * （所以「主目录」那个按钮照样能用）。细节见 `directory-browse.ts` 的 `listDrives`。
       */
      const target = raw === null ? '' : raw
      const listing = await listDirectory(target)
      if (isBrowseFailure(listing)) {
        /*
         * 失败给**真的 HTTP 状态码**，同时正文里也带 `code`。
         *
         * 两层都要：状态码让通用工具（curl、日志、代理）一眼看出结果，
         * 而 `code` 是给界面用的 —— 它要区分「没这个路径」和「没权限」，
         * 那两件事该给用户看不同的话。靠状态码分支就得写魔法数字，
         * 靠正文匹配字符串又会随着文案变。
         */
        const status =
          listing.code === 'not_found'
            ? 404
            : listing.code === 'denied'
              ? 403
              : listing.code === 'not_a_directory'
                ? 400
                : 500
        sendJson(res, status, listing)
        return
      }
      sendJson(res, 200, listing)
      return
    }

    /*
     * 建一个子目录 —— DSH 的 `directoryPicker.createDirectory` 需要它
     * （那个目录浏览器上有个「新建文件夹」）。
     *
     * ⚠️ 和 `/picker/dirs` 一样，**不限制在工作区内**：你正在挑一个新的根，
     * 那时的「工作区」还不存在。护栏和别的接口一样：回环 + Host/Origin 围栏。
     *
     * 名字的单段校验在**垫片那边**做（照抄 DSH 的 refine），这里只再挡一次
     * 分隔符和 `..` —— 两处都做是有意的：垫片是浏览器里的代码，不能当边界。
     */
    if (req.method === 'POST' && url.pathname === '/picker/mkdir') {
      let payload: unknown
      try {
        const raw = await readBody(req)
        if (raw === null) throw new Error('空请求体')
        payload = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { code: 'bad_request', message: '请求体不是合法 JSON' })
        return
      }
      const target = (payload as { path?: unknown } | null)?.path
      if (typeof target !== 'string' || target === '') {
        sendJson(res, 400, { code: 'bad_request', message: '缺少 path' })
        return
      }
      const resolved = path.resolve(target)
      const base = path.basename(resolved)
      if (base === '' || base === '.' || base === '..' || /[/\\]/.test(base)) {
        sendJson(res, 400, { code: 'bad_request', message: `不是合法的单段目录名：${base}` })
        return
      }
      try {
        await mkdir(resolved, { recursive: false })
        sendJson(res, 200, { ok: true, path: resolved })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'EEXIST') {
          sendJson(res, 409, { code: 'exists', message: `已经存在：${resolved}` })
          return
        }
        if (code === 'EACCES' || code === 'EPERM') {
          sendJson(res, 403, { code: 'denied', message: `没有权限建：${resolved}` })
          return
        }
        sendJson(res, 500, { code: 'unknown', message: `${code ?? '建目录失败'}：${resolved}` })
      }
      return
    }

    /*
     * ── 模型配置 ──────────────────────────────────────────────────────
     *
     * 界面在 DSH 的设置面板里加了一页（`settings.section`），它读写这两个。
     *
     * ⚠️ **写不能直接发 `set_config`。** 那条命令会把整个配置交给
     * `normalizeConfig`，而它对缺失字段**填默认值** —— 只传 `model` 进去，
     * 权限模式、上下文设置、端口会被一起重置。不报错，只是安静地改掉别的东西。
     * 所以合并放在服务端（`runtime.updateModel`），
     * 前端只送它想改的那几项。
     */
    if (req.method === 'GET' && url.pathname === '/model-config') {
      sendJson(res, 200, this.#runtime.modelConfigView())
      return
    }

    if (req.method === 'POST' && url.pathname === '/model-config') {
      let payload: unknown
      try {
        const raw = await readBody(req)
        if (raw === null) throw new Error('空请求体')
        payload = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
        return
      }
      const body = (payload ?? {}) as {
        profile?: unknown
        baseUrl?: unknown
        model?: unknown
        contextWindow?: unknown
        apiKey?: unknown
        models?: unknown
        providers?: unknown
        removeProviders?: unknown
        activeProvider?: unknown
        route?: unknown
        temperature?: unknown
        maxTokens?: unknown
      }
      const patch: {
        profile?: string
        baseUrl?: string
        model?: string
        contextWindow?: number | null
        apiKey?: string
        models?: string[]
        providers?: Record<string, Record<string, unknown>>
        removeProviders?: string[]
        activeProvider?: string
        route?: string
        temperature?: number | null
        maxTokens?: number | null
      } = {}
      if (typeof body.profile === 'string' && body.profile !== '') patch.profile = body.profile
      if (typeof body.baseUrl === 'string' && body.baseUrl !== '') patch.baseUrl = body.baseUrl
      if (typeof body.model === 'string' && body.model !== '') patch.model = body.model
      /*
       * 密钥：**空串是有意义的取值**（= 清掉），所以判据是 `typeof === 'string'`
       * 而不是 `!== ''`。和上面三个不一样 —— 那三个空串等于"没填"，密钥空串
       * 等于"不要密钥了"。混掉的话用户就清不掉已经存下的密钥。
       */
      if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey
      /*
       * 窗口：数字 = 显式声明；**null = 清掉、回到自动探测**；缺省 = 不动。
       * 三种要分得开 —— 全当成「不动」的话，用户就没法把手工填过的值退回去了。
       */
      if (body.contextWindow === null) patch.contextWindow = null
      else if (typeof body.contextWindow === 'number' && Number.isFinite(body.contextWindow)) {
        patch.contextWindow = Math.floor(body.contextWindow)
      }
      /*
       * 生成参数。⚠️ **`null` 必须能穿过去** —— 它是"显式地不要这个值了"，
       * 而 `undefined` 是"这次不改它"。混掉的话界面就没有办法把温度清回"由引擎决定"，
       * 只能改大改小 ✗。
       *
       * 越界的数**在这里不做判断**，交给 `updateModel` 统一拒（那里能回一句人话）；
       * 这里只保证"是有限数"而不是 `NaN`/字符串 ✓。
       */
      for (const key of ['temperature', 'maxTokens'] as const) {
        const value = body[key]
        if (value === null) patch[key] = null
        else if (typeof value === 'number' && Number.isFinite(value)) patch[key] = value
      }
      /*
       * 可选模型目录。**空数组是有意义的**（= 一个都不要），所以只看是不是数组，
       * 不看长度 —— 和 `apiKey` 同一个道理。
       */
      if (Array.isArray(body.models)) {
        patch.models = body.models.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
      }
      /*
       * 供应商库。**逐项只收对象**，非对象直接跳过而不是整体拒绝 ——
       * 界面一次可能发好几个 route，其中一个形状不对时不该把其余的也丢掉。
       */
      if (body.providers !== null && typeof body.providers === 'object' && !Array.isArray(body.providers)) {
        const providers: Record<string, Record<string, unknown>> = {}
        for (const [route, value] of Object.entries(body.providers as Record<string, unknown>)) {
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            providers[route] = value as Record<string, unknown>
          }
        }
        if (Object.keys(providers).length > 0) patch.providers = providers
      }
      if (Array.isArray(body.removeProviders)) {
        patch.removeProviders = body.removeProviders.filter(
          (entry): entry is string => typeof entry === 'string' && entry !== '',
        )
      }
      /*
       * 当前生效的 route。**空串 = 清掉**（回到 `model` 段），
       * 和 `apiKey` / `contextWindow` 同一个三态规矩。
       */
      if (typeof body.activeProvider === 'string') patch.activeProvider = body.activeProvider
      /*
       * `route`：**只定位要改哪个供应商，不切换当前用的**。
       *
       * 设置页做成卡片之后，"修改"一个没在用的供应商如果走 `activeProvider`，
       * 就会把它切成当前 ✗ —— 用户只想改个地址。这个字段让两件事分得开。
       */
      if (typeof body.route === 'string') patch.route = body.route

      const result = await this.#runtime.updateModel(patch)
      /*
       * `runtime.updateModel` 里已经重新探测过窗口了，所以这里回一份**新的视图** ——
       * 界面可以立刻显示「实际生效的窗口」，不用再问一次、也就不会显示旧值。
       */
      sendJson(res, result.ok ? 200 : 400, { ...result, view: this.#runtime.modelConfigView() })
      return
    }

    /*
     * ── 本地模型服务（llama-server）────────────────────────────────────
     *
     * 和 `/model-config` 分开是有意的，虽然界面把它们画在一起：
     * 那条路由管「用哪个模型」（改完立刻生效），这条管「那个进程在不在跑」
     * （起停一个 20 GB 的进程）。**两件事的代价差几个数量级**，
     * 合成一个接口会让界面很难把「保存」和「启动」的后果说清楚。
     */
    if (req.method === 'GET' && url.pathname === '/local-model') {
      sendJson(res, 200, await this.#runtime.localModelStatus())
      return
    }

    if (req.method === 'POST' && url.pathname === '/local-model') {
      let payload: unknown
      try {
        const raw = await readBody(req)
        if (raw === null) throw new Error('空请求体')
        payload = JSON.parse(raw)
      } catch {
        sendJson(res, 400, { ok: false, message: '请求体不是合法 JSON' })
        return
      }
      const action = (payload as { action?: unknown } | null)?.action
      if (action === 'start') {
        /*
         * **同步返回。** 载入 20 GB 要 45 秒到 5 分钟，`await` 在这里会让
         * 这个 HTTP 请求一直挂着 —— 浏览器那边表现为卡死，而用户完全不知道
         * 后面在载入模型。就绪由界面轮询 `GET /local-model` 得知。
         *
         * ⚠️ 这个行为我实测撞到过：注释写着「立刻返回」，实现却在等就绪。
         */
        sendJson(res, 200, { ok: true, status: this.#runtime.startLocalModel() })
        return
      }
      if (action === 'stop') {
        sendJson(res, 200, { ok: true, status: await this.#runtime.stopLocalModel() })
        return
      }
      sendJson(res, 400, { ok: false, message: `不认识的动作：${JSON.stringify(action)}（支持 start / stop）` })
      return
    }

    // ── 产品界面：dist/web 里的静态文件 ────────────────────────────────
    //
    // `/dsh` 和 `/brand` 是**目录型入口**，不是一个文件。`looksLikeAsset` 靠
    // 扩展名判断，认不出它们，所以这些前缀要单独列出来。
    //
    //   /        自己的界面（`web/` 下的静态文件，由 `ui/` 构建而来）
    //   /brand/  品牌对照页（见 tools/logo-sheet.mjs）
    //
    // 加新页面就在这里加一个前缀。
    /*
     * `/brand` 是**目录型入口**，不是一个文件 —— `looksLikeAsset`
     * 靠扩展名判断，认不出它，所以这种前缀要单独列出来。
     *
     *   /        主页面（`web/index.html`，由 `tools/build-ui.mjs` 从 `ui/` 产出）
     *   /brand/  品牌对照页（tools/logo-sheet.mjs 生成）
     *
     * ⚠️ 这里原来还有 `/app`（DSH 前端跑起来的实验版）。那套东西连同它的构建脚本
     * 已经归档到 `_attic/` 下（目录名是 dsh-era- 加时间戳），路径不再存在 ——
     * 留着它只会让下一个人以为那个页面还在。**能少一个假的入口就少一个。**
     */
    const uiPages = ['/brand']
    const isUiPage = uiPages.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`),
    )

    if (req.method === 'GET' && (url.pathname === '/' || isUiPage || looksLikeAsset(url.pathname))) {
      await this.#serveUi(res, url.pathname, cookies)
      return
    }

    if (req.method === 'POST' && url.pathname === '/command') {
      const body = await readBody(req)
      if (body === null) {
        sendJson(res, 413, { error: '请求体过大' })
        return
      }
      let command: ClientCommand
      try {
        command = JSON.parse(body) as ClientCommand
      } catch {
        sendJson(res, 400, { error: '命令不是合法 JSON' })
        return
      }
      sendJson(res, 200, await this.#applyCommand(command))
      return
    }

    sendJson(res, 404, { error: '未知路径' })
  }

  /**
   * 执行一条客户端命令。
   *
   * `sessionId` 目前只有 `create_session` 会填 —— 因为它创建出来的 id
   * **调用方拿不到别的途径**（列表要再拉一次才能发现，而且那中间有窗口）。
   *
   * 这是 DSH 的形状逼出来的：它的 `session/create` 返回 `{sessionId}`，
   * 客户端拿到后**立即**在侧栏插一行占位（不等列表刷新）。
   * 我们这边不透出来的话，那条路就走不通。
   */
  async #applyCommand(
    command: ClientCommand,
  ): Promise<{ ok: boolean; message?: string; sessionId?: string }> {
    switch (command.type) {
      // ── 会话级 ────────────────────────────────────────────────────────
      case 'user_message': {
        const session = await this.#runtime.ensureSession(command.sessionId)
        if (session === undefined) {
          return { ok: false, message: `未知会话：${command.sessionId}` }
        }
        /*
         * ★ **先查前置条件，别让它变成一条"发出去了却没反应"的消息。**
         *
         * 下面那句 `void session.sendUserMessage(...)` 是**刻意不等待**的，所以它
         * 的 throw 只能落到事件流里那条 error 上 —— 而命令本身会回 `ok:true`。
         * 实测的后果：会话卡在 `interrupted`（上次有个工具调用没结算）时，
         * 界面显示发送成功、然后什么都不发生，人在界面上找不到出口。
         *
         * 所以这里**同步**先问一句"现在能不能接"，不能就用 `{ok:false, message}`
         * 如实回答。判断与文案都来自 `session.blockReason()` 那一份，不各写一遍。
         */
        const blocked = session.blockReason()
        if (blocked !== null) return { ok: false, message: blocked }

        // ★ 刻意**不**等待。
        // 一轮可能跑几分钟，中途还会停下来等人审批 —— 让 HTTP 响应挂在那里
        // 会把客户端也一起挂住。进度全部走事件流，这里立刻返回。
        void session.sendUserMessage(command.text).catch((err: unknown) => {
          // 失败要能从事件流里看到，不能静默消失。
          //
          // ⚠️ 这条事件**没落盘**（能落盘的话 `sendUserMessage` 自己就落了），
          // 所以它借当前序号，而不是 0。
          //
          // 用 0 的问题是它落进了真实事件的序号空间里：客户端按 seq 排序时，
          // 它会排到整段历史的最前面 —— 一条「刚才那轮挂了」的错误显示在最顶端。
          // 借当前序号则是安全的：客户端的断档检测是 `seq > lastSeq + 1`，
          // 重复序号既不构成断档、也不会推进游标 —— 这正合适，因为这是一条
          // 旁路补充信息，不是历史的一部分。
          this.#broadcast({
            kind: 'event',
            envelope: {
              sessionId: command.sessionId,
              seq: session.currentSeq(),
              at: new Date().toISOString(),
              event: { type: 'error', message: messageOf(err) },
            },
          })
        })
        return { ok: true }
      }

      case 'approve': {
        // 审批只存在于内存里，所以必须已经加载。没加载就没人在等你批。
        const session = this.#runtime.getLoaded(command.sessionId)
        if (session === undefined) {
          return { ok: false, message: `会话未加载，没有待确认项：${command.sessionId}` }
        }
        return session.resolveApproval(command.approvalId, command.granted)
          ? { ok: true }
          : { ok: false, message: `未知的审批 id：${command.approvalId}` }
      }

      case 'abort': {
        const session = this.#runtime.getLoaded(command.sessionId)
        if (session === undefined) return { ok: false, message: '会话未加载' }
        return session.abort() ? { ok: true } : { ok: false, message: '当前没有在跑的一轮' }
      }

      case 'set_mode': {
        const session = await this.#runtime.ensureSession(command.sessionId)
        if (session === undefined) return { ok: false, message: '未知会话' }
        await session.setMode(command.mode)
        return { ok: true }
      }

      /*
       * ★ **那道门的开关。**
       *
       * `interrupted` 是一道正确的闸门（上次工具调用没结算，不许猜），但它必须
       * 有出口：没有这条命令时，卡住的会话**永久不可用**，而界面上看不到任何原因
       * —— 我们实测卡住过一个（`2828d5a6`）。
       *
       * 用 `ensureSession` 而不是 `getLoaded`：会话可能还没加载（重启之后没人打开过），
       * 而"人确认一下"这件事不该依赖于它是否已经被读进内存。
       */
      case 'acknowledge_interrupted': {
        const session = await this.#runtime.ensureSession(command.sessionId)
        if (session === undefined) return { ok: false, message: `未知会话：${command.sessionId}` }
        await session.acknowledgeInterrupted()
        /* 状态变了要广播：否则界面上那个阻断提示会一直留着 */
        this.#broadcast({ kind: 'state', state: this.#runtime.state() })
        return { ok: true }
      }

      case 'reset_fatigue': {
        // 审批同款的「只在内存里」约束：熔断状态跟着 Policy 对象，而 Policy
        // 跟着会话。没加载的会话没有熔断状态可言 —— 它连事件都还没跑过。
        const session = this.#runtime.getLoaded(command.sessionId)
        if (session === undefined) {
          return { ok: false, message: `会话未加载：${command.sessionId}` }
        }
        // 如实转达：本来就没命中时**不是**成功。报成功会让界面显示「已恢复」，
        // 而用户并不知道自己并没有被熔断过 —— 下一次真被熔断时就不信这个按钮了。
        return (await session.resetFatigue())
          ? { ok: true }
          : { ok: false, message: '当前没有处于熔断状态，不需要恢复' }
      }

      // ── 索引级 ────────────────────────────────────────────────────────
      case 'open_workspace':
        await this.#runtime.openWorkspace(command.path)
        return { ok: true }

      case 'close_workspace':
        await this.#runtime.closeWorkspace(command.path)
        return { ok: true }

      case 'create_session': {
        // 把新会话的 id 回给调用方 —— 见 `#applyCommand` 的说明
        const created = await this.#runtime.createSession(command.workspace, command.title)
        return { ok: true, sessionId: created.sessionId }
      }

      case 'rename_session':
        await this.#runtime.renameSession(command.sessionId, command.title)
        return { ok: true }

      case 'delete_session':
        await this.#runtime.deleteSession(command.sessionId)
        return { ok: true }

      case 'watch':
        // watch 声明的是**这条连接**在看哪个会话，所以它只对 WebSocket 有意义。
        // 一次性的 HTTP 请求没有可归属的连接，这里不能假装成功 —— 假装成功会让
        // 调用方以为「我已经在看它了」，然后在等一个永远不会来的投影。
        return {
          ok: false,
          message: 'watch 必须在 WebSocket 上声明：它描述的是「这条连接」在看哪个会话，HTTP 请求没有连接可以归属',
        }

      // ── 撤销 ──────────────────────────────────────────────────────────
      case 'revert': {
        const outcome = await this.#runtime.revert(
          command.sessionId,
          command.txnId,
          command.force === true,
        )
        if (outcome === undefined) {
          return { ok: false, message: `未知会话：${command.sessionId}` }
        }
        // ⚠️ 这里如实转达恢复层的结论，**不把 ok 当成命令是否成功**。
        // 「文件之后被改过所以我没动它」是一条正常结果：命令本身成功了，
        // 只是撤销被拒绝了。混在一起会让界面显示「撤销成功」而文件没变。
        return outcome.ok ? { ok: true } : { ok: false, message: outcome.message }
      }

      // ── 配置 ──────────────────────────────────────────────────────────
      case 'set_config': {
        const result = await this.#runtime.applyConfig(command.config)
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      }

      /**
       * **一个会话**选中一个模型 —— 与 `set_config` 是本质不同的两件事。
       *
       * `set_config` 改进程级配置（所有会话跟着变）；这条只改那一个会话。
       * DSH 的设计里模型选择就是会话级的（`modelSelection` 由会话自己的
       * `model/selection` 事件推导），所以这里不能复用它上面那条。
       */
      case 'select_model': {
        const ok = await this.#runtime.selectSessionModel(
          command.sessionId,
          command.provider,
          command.model,
        )
        return ok ? { ok: true } : { ok: false, message: `未知会话：${command.sessionId}` }
      }

      default:
        return { ok: false, message: '未知命令' }
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket
  // -------------------------------------------------------------------------

  #handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')

    // 升级请求同样要过完整的鉴权 —— 这是最容易被漏掉的一道门
    const denial = this.#authorize(req, url)
    if (denial !== null) {
      socket.write(
        `HTTP/1.1 ${denial.status} ${denial.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n` +
          'content-type: text/plain; charset=utf-8\r\n' +
          `content-length: ${Buffer.byteLength(denial.message)}\r\n` +
          'connection: close\r\n\r\n' +
          denial.message,
      )
      socket.destroy()
      return
    }

    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const accept = tryUpgrade(req)
    if (accept === null) {
      socket.write('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )

    // 升级请求可能和首帧一起到达，把这部分数据还回流里，交给连接自己去解析
    if (head.length > 0) socket.unshift(head)

    const client = new WebSocketConnection(socket, {
      onMessage: (text) => {
        void this.#handleClientMessage(client, text)
      },
      onClose: () => {
        this.#clients.delete(client)
      },
    })
    // 新连接默认「什么都不在看」 —— 它得显式 watch 才会收到 token 级增量
    this.#clients.set(client, new Set())

    // 迟到加入的客户端先拿整份索引 —— 侧栏靠它立刻画出工作区树和徽标，
    // 单个会话的投影等它 watch 时再给
    this.#send(client, { kind: 'state', state: this.#runtime.state() })
  }

  async #handleClientMessage(client: WebSocketConnection, text: string): Promise<void> {
    let command: ClientCommand
    try {
      command = JSON.parse(text) as ClientCommand
    } catch {
      return
    }

    /*
     * ★★ **给一个会话发消息，就自动关注它。**
     *
     * ## 为什么必须自动关注（这是「第一轮不流式、后面就流式」的根因）
     *
     * 逐 token 增量是**唯一**被 `watched.has(sessionId)` 过滤的事件：
     *
     *     if (EPHEMERAL_EVENTS.has(type) && !watched.has(sessionId)) continue
     *
     * 而订阅是客户端**另外**用 `watch` 命令声明的。两者是两条独立的时序：
     *
     *   1. 打开会话 → 发消息（`user_message`）
     *   2. 界面的订阅包（`watch`）什么时候到，取决于它自己的渲染与抖动
     *
     * 于是**第一轮几乎必然**发生在"这个会话还没进订阅集合"的窗口里 ✗ ——
     * 那一轮的增量被整段丢掉，界面只能等落盘消息**整段蹦出来** ✓；
     * 等第一轮之后订阅补上了 ✓，**后面几轮就正常流式**了 ✓✓
     *
     * 实测复现（用户）：本地模型每轮都不流 ✗；切到 API 后**第一轮不流、后面都流** ✓✗
     * —— 正是这个形状 ✓
     *
     * ## 为什么修在这里而不是界面
     *
     * "记得早点订阅"是**界面侧的时序约束** ✗，任何一次重渲染/抖动都可能破坏它 ✓。
     * 而"给谁发消息就是在关注谁"是**天然成立的事实** ✓ —— 由服务端直接落实，
     * 竞态从根上不存在 ✓。
     */
    const sessionIdOfCommand = (command as { sessionId?: unknown }).sessionId
    if (typeof sessionIdOfCommand === 'string' && sessionIdOfCommand !== '') {
      const interested: ReadonlyArray<ClientCommand['type']> = [
        'user_message',
        'abort',
        'approve',
        'rename_session',
        'delete_session',
      ]
      if (interested.includes(command.type)) {
        this.#clients.get(client)?.add(sessionIdOfCommand)
      }
    }

    // watch 是**每条连接各自**的状态，不能走共享的命令分发
    if (command.type === 'watch') {
      const watched = this.#clients.get(client)
      if (watched === undefined) return

      /*
       * ★★ **只增不减 —— 绝不整体替换。**
       *
       * ## 原来为什么是错的（这是「不流式」的最后一格）
       *
       * 这里原来是 `watched.clear()` 再把这次的会话加进去 —— 也就是**整体替换**。
       * 而 `watched` 是**逐 token 增量唯一的放行条件**：
       *
       *     if (EPHEMERAL_EVENTS.has(type) && !watched.has(sessionId)) continue
       *
       * 于是只要有一个 `watch` 包没带某个会话（界面里这很常见：侧栏每个会话的
       * 预览都会加/减订阅 ✓），**那个会话的增量就被整段过滤掉** ✗ ——
       * 现象是「普通事件照常、逐 token 一条都没有、生成完整段蹦出来」✓
       *
       * 实测证据：修好广播那处之后，`turn_started`/`step_started` 到了 ✓，
       * 但 `model_reasoning_delta` / `model_text_delta` **一条都没到** ✗
       * —— 因为它们是被这道过滤挡住的 ✓
       *
       * ## 现在
       *
       * 只加不减：包里的会话照加，**没带的不动** ✓。任何一个包都不可能再误伤
       * 别的会话 ✓。
       *
       * ⚠️ 代价与边界：客户端不再显式退订，所以这个集合会一直长 ✗。
       * 本地应用里可接受，但仍然**给个上限**（`WATCH_LIMIT`），超了淘汰最早加的
       * —— 否则长时间开着、点过几百个会话之后，每个 token 都会推给一堆没人看的会话 ✗。
       */
      for (const sessionId of command.sessionIds) {
        if (watched.has(sessionId)) continue
        watched.add(sessionId)
        // 刚被关注上的会话立刻推一份投影 —— 这就是「迟到加入」的完整流程
        const session = await this.#runtime.ensureSession(sessionId)
        if (session !== undefined) {
          this.#send(client, { kind: 'projection', sessionId, projection: session.projection() })
        }
      }
      while (watched.size > WATCH_LIMIT) {
        const oldest = watched.values().next().value
        if (oldest === undefined) break
        watched.delete(oldest)
      }
      return
    }

    const result = await this.#applyCommand(command)

    /*
     * ★ **回执。** 命令走 WS 的代价是客户端拿不到 HTTP 的响应体 —— 没有这一帧，
     * "这条命令成了没有"就只能靠超时去猜（客户端会白等一轮再回落 HTTP）。
     *
     * `id` 是客户端带的（它自己生成，用来配对）。没带 id 的调用方（比如手写的
     * 调试脚本）就不发回执 —— 它没在等。
     */
    const commandId = (command as { id?: unknown }).id
    if (typeof commandId === 'string' && commandId !== '') {
      this.#send(client, {
        kind: 'commandResult',
        id: commandId,
        ok: result.ok,
        ...(result.message === undefined ? {} : { message: result.message }),
        ...('sessionId' in command ? { sessionId: String(command.sessionId) } : {}),
      })
    }

    if (result.ok) return

    const sessionId = 'sessionId' in command ? String(command.sessionId) : ''
    this.#send(client, {
      kind: 'event',
      envelope: {
        sessionId,
        seq: 0,
        at: new Date().toISOString(),
        event: { type: 'notice', code: 'command_rejected', message: result.message ?? '命令被拒绝' },
      },
    })
  }

  /**
   * 广播。
   *
   * **索引始终推，token 级增量只推给正在看它的连接。** 没有这条过滤，
   * 多会话下每开一个标签页都会收到其他会话的逐字流。
   */
  #broadcast(frame: ServerFrame): void {
    const text = JSON.stringify(frame)
    for (const [client, watched] of this.#clients) {
      /*
       * ★★ **逐 token 增量只推给"声明在看的"连接。**
       *
       * ## 这条闸门守的是什么
       *
       * 没有它，多会话/多标签/多用户下，**别人的逐字流会推到你这条连接上**。
       * 本机单用户时那只是浪费带宽，**远程多用户部署时它是数据泄漏** ——
       * 不是性能问题。所以它必须留着。
       *
       * ## 但它有一个前提，缺了就会变成"一整类没有流式"
       *
       * 订阅是客户端**另外**发 `watch` 声明的，而发消息走的是 `POST /command`
       * —— 两条路径**没有任何绑定关系**。于是可能出现：
       *
       *   · 界面打开会话、发消息，但 `watch` 还没送到 → 增量到达时被滤掉 ✗
       *   · 表现很具体：**某一轮整段不流式**，下一轮又好了（订阅补上了）
       *
       * 实测形状就是"本地模型每轮都不流 / 切到 API 后第一轮不流、后面就流"。
       *
       * ## 正确的前提（我们的界面就是这么做的）
       *
       * **打开会话、或 WebSocket 一连上，就立刻 `watch`**，之后才允许发消息。
       * 见 `ui/client.ts` 的 `connectSession()`：`open` 事件里第一件事就是发 watch，
       * 所以不存在"先发消息、订阅还在路上"的窗口。
       *
       * ## 根治办法（还没做）
       *
       * 让**动作与流走同一条通道**：把 `user_message` 也放到 WebSocket 上，
       * 服务端就能顺手把该会话登记进这条连接的订阅里 —— 竞争窗口从构造上消失，
       * 这条闸门也就不再依赖调用方的自觉。
       */
      if (frame.kind === 'event' && EPHEMERAL_EVENTS.has(frame.envelope.event.type)) {
        if (!watched.has(frame.envelope.sessionId)) continue
      }
      /*
       * ★★ **一个坏掉的连接不能饿死后面所有人。**
       *
       * `client.send()` 在**已关闭**的 socket 上会抛异常 ✗ —— 而这里原来没有
       * try/catch，于是那个异常从 `#broadcast` 里冒出去，**整个循环当场中断** ✗，
       * 排在它后面的客户端**一条都收不到** ✓
       *
       * 实测证据：修好之前 WS 上**一条 `event` 都没有** ✗（只有 `state` 和
       * `projection` ✓ —— 而 `projection` 是 watch 处理里**直接** `#send` 的，
       * 根本不走广播 ✓）。修好之后 `turn_started` / `step_started` 立刻到了 ✓。
       *
       * 所以：**捕住异常并把这个客户端摘掉** ✓（连接已经坏了，留着只会一直饿死别人）。
       */
      try {
        client.send(text)
      } catch {
        this.#clients.delete(client)
      }
    }
  }

  /**
   * 把 `dist/web` 里的文件吐出去。
   *
   * ⚠️ **路径围栏必须有，而且它挡的是特定的一种形态。**（实测结论，别凭直觉改）
   *
   * - `/../package.json`、`/assets/%2e%2e/x` —— `new URL()` **已经把它们规范化掉了**，
   *   喂到这里时 `..` 早就不存在，所以这类请求够不到外面。
   * - `/C:/Windows/win.ini` —— 盘符绝对路径**原样保留**，`path.resolve` 之后是
   *   `C:\Windows\win.ini`，**真的会越出根目录**。
   *
   * 也就是说 URL 解析帮我们挡掉了 `..`，却挡不住盘符绝对路径 —— 而后者在 Windows 上
   * 是真实可达的。一个只依赖「URL 会规范化」的静态服务就是这么漏的。围栏要防的正是
   * 这一种，顺带覆盖将来万一改成读原始 `req.url` 的情况。
   */
  /**
   * 根路径 `/` 出哪一份文档。
   *
   * **就一个文件，写死。**
   *
   * 这里原来是一串候选（可运行版 → 静态快照 → Vue），按「文件在不在」自动挑。
   * 那个「自动」是纯粹的故障面：**你改了 A，服务端出的是 B，而且不报错。**
   * 这一轮它真的造成了「改了但看不到」——我改的文件和服务端发的文件不是同一个。
   *
   * 现在主页面是 `web/index.html`，一个普通文件，直接编辑、刷新即可。
   */
  #entryDocument(): string {
    return ENTRY_DOCUMENT
  }

  async #serveUi(
    res: ServerResponse,
    pathname: string,
    cookies: Record<string, string>,
  ): Promise<void> {
    // 目录型路径要落到它的 index.html：`/dsh` 和 `/dsh/` 都指 `dsh/index.html`。
    // 判据是「最后一段没有扩展名」——那不可能是一个文件。
    const raw = pathname === '/' ? this.#entryDocument() : pathname.replace(/^\/+/, '')
    const relative = raw === 'index.html' || /\.[a-z0-9]+$/i.test(raw) ? raw : `${raw.replace(/\/+$/, '')}/index.html`
    const root = path.resolve(this.#uiDir)
    const target = path.resolve(root, relative)

    if (target !== root && !target.startsWith(root + path.sep)) {
      sendJson(res, 403, { error: '路径越界' })
      return
    }

    let body: Buffer
    try {
      const info = await stat(target)
      if (!info.isFile()) throw new Error('not a file')
      body = await readFile(target)
    } catch {
      if (relative === 'index.html') {
        /*
         * 主页面不在。
         *
         * **状态码必须是 404，不能是 200。**
         *
         * 正文那段说明是有用的（它告诉人该跑什么），但配上 200 就成了一个谎：
         * 任何通用工具（curl、日志、监控、我自己写的 check-served）
         * 看到的都是「成功」，于是「页面根本没生成」这件事被静默掉了。
         *
         * 这一轮我吃过这个形态的亏 —— 服务端成功返回了 200，
         * 而我以为它发的是我改的那份。**有用的正文 + 正确的状态码**，
         * 两件事不冲突。
         */
        const hint =
          '<!doctype html><meta charset="utf-8"><title>MVS Agent</title>' +
          '<body style="font:14px/1.7 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;padding:40px;max-width:640px">' +
          '<h2>主页面还没有</h2>' +
          '<p>守护进程在找 <code>' +
          escapeHtml(root) +
          '</code>，但没有找到 <code>index.html</code>。</p>' +
          '<p>主页面是<strong>手改的文件</strong>，不是构建产物 —— 正常情况它应当在仓库里。</p>' +
          '<p>如果这是全新的检出，跑一次抓取（需要 Edge，会覆盖同名文件）：</p>' +
          '<pre style="background:#f5f5f5;padding:10px;border-radius:4px">npm run web:capture</pre>' +
          '</body>'
        res.writeHead(404, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(hint),
          'cache-control': 'no-store',
          ...cookies,
        })
        res.end(hint)
        return
      }
      sendJson(res, 404, { error: '未知路径' })
      return
    }

    const type = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      /*
       * 缓存策略。三种，判据不是扩展名而是**这个文件名会不会变**。
       *
       *   HTML                          → no-store
       *   文件名带内容哈希的产物          → immutable（长缓存）
       *   其余（名字固定、内容会变的）     → no-cache（每次回来问一句）
       *
       * ⚠️ **`immutable` 只能给「内容变了文件名也变」的东西。**
       * 我原来写的是「不是 HTML 就 immutable」—— 于是 `dsh/glue.js` 被当成
       * 不可变资源**缓存一年**。它是我们自己的逻辑层、名字固定、改一次内容变一次，
       * 结果就是：**我在服务端改了七八版，用户的浏览器一版都没取过。**
       * 他看到的永远是第一次那一版，然后来问「为什么底部没有那个东西」——
       * 而我这边无论怎么验证（无头渲染、探针、DOM dump）**都是对的**，
       * 因为那些都不经过浏览器缓存。
       *
       * 那是最难查的一类不一致：**结论两边都是真的**。
       *
       * 哈希的判据用常见的构建产物形状（`name-<8位以上 base64url>.<ext>`），
       * Vite 的就是这个形状。认不出来就走 no-cache —— 保守的那一边。
       */
      'cache-control': cachePolicyFor(path.basename(target), type),
      ...cookies,
    })
    res.end(body)
  }

  #send(client: WebSocketConnection, frame: ServerFrame): void {
    client.send(JSON.stringify(frame))
  }

  get clientCount(): number {
    return this.#clients.size
  }
}

// ---------------------------------------------------------------------------

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(0, end + 1)
  }
  const colon = host.lastIndexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin)
    return LOOPBACK_NAMES.has(parsed.hostname.toLowerCase())
  } catch {
    return false
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // 本地 UI 不需要被任何代理缓存
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 这是一次**浏览器导航**，还是程序发起的请求？ */
function isBrowserNavigation(req: IncomingMessage): boolean {
  // 现代浏览器导航时都会带这个，而且它没法被 fetch 伪装成「非导航」
  if (req.headers['sec-fetch-mode'] === 'navigate') return true
  const accept = req.headers.accept
  return typeof accept === 'string' && accept.includes('text/html')
}

/**
 * 401 时给人看的说明页。
 *
 * 刻意**不放令牌**：那等于把凭据写进一张任何人打开书签就能看到的页面。
 * 这里只解释「为什么」和「去哪儿拿」。
 */
function tokenHelpPage(pathname: string): string {
  return (
    '<!doctype html><meta charset="utf-8"><title>需要令牌</title>' +
    '<body style="font:14px/1.8 -apple-system,Segoe UI,Microsoft YaHei,sans-serif;' +
    'padding:40px;max-width:640px;color:#0f1115">' +
    '<h2 style="margin:0 0 4px">需要令牌</h2>' +
    `<p style="color:#7f8287;margin:0 0 24px"><code>${escapeHtml(pathname)}</code></p>` +
    '<p>这个服务只绑在 <code>127.0.0.1</code>，但<strong>任何</strong>本机程序都能访问这个端口 —— ' +
    '所以每个请求都要带令牌。</p>' +
    '<p><strong>怎么打开：</strong>启动守护进程的那个终端窗口里印了带令牌的地址，' +
    '复制那一整条（它长这样）：</p>' +
    '<pre style="background:#f5f5f5;padding:12px;border-radius:6px;overflow-x:auto">' +
    'http://127.0.0.1:&lt;端口&gt;/auth?token=&lt;令牌&gt;&amp;next=/brand/</pre>' +
    '<p><strong>为什么旧链接会失效：</strong>每次重启守护进程都会换一个新令牌，' +
    '上一条消息里的链接就作废了。</p>' +
    '<p style="color:#7f8287">已经打开的界面窗口不必再点链接 —— 它换过 cookie，' +
    '直接在里面点导航就行。</p>' +
    '</body>'
  )
}

/**
 * 这个路径是不是「前端产物里的一个文件」。
 *
 * 刻意不用「全部交给前端」的兜底：**这个界面没有客户端路由**，所以不需要
 * SPA fallback，而有了它之后，任何拼错的地址都会返回 200 + 一份 HTML ——
 * 那会让「未知路径 404」这条测试（以及它对 API 拼写错误的保护）失效。
 */
function looksLikeAsset(pathname: string): boolean {
  if (pathname.startsWith('/assets/')) return true
  const dot = pathname.lastIndexOf('.')
  if (dot === -1) return false
  return pathname.slice(dot).toLowerCase() in CONTENT_TYPES
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;',
  )
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > MAX_BODY_BYTES) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type { Envelope }
