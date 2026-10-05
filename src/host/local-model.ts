/**
 * 本地模型服务（llama.cpp 的 `llama-server`）的监管器。
 *
 * ## 它解决什么
 *
 * 20 GB 的模型不可能每次手打一长串参数去起，而那些参数里
 * `--ctx-size` 和 KV 量化**直接决定内存够不够** —— 打错了不是报错，
 * 是**换页变慢**，很难归因。所以参数收进配置、进程由守护进程管。
 *
 * ## 三条自我约束
 *
 * 1. **没配 `modelPath` 就什么都不做。** 一个 20 GB 的进程不该在没有明确
 *    指示的情况下被拉起来。
 * 2. **端口上已经有人了就不抢。** 你自己起的实例，这里只报告、不接管
 *    （状态 `external`）。抢的后果是「我明明起了一个，它又起一个」而两个
 *    在抢同一块内存。
 * 3. **启动是后台的。** `start()` 立刻返回「启动中」，就绪由轮询 `/health`
 *    判定。阻塞式等待会让守护进程的引导卡住几十秒，而那时界面还没起来。
 *
 * ## 状态机
 *
 *     stopped ──start()──> starting ──/health 200──> ready
 *        ^                    │                        │
 *        │                    └──超时/退出──> failed    │
 *        └────────────────stop()───────────────────────┘
 *
 *     external  端口上有一个不是我们起的实例（只读状态，不提供 stop）
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { LocalModelConfig } from '../config/types.ts'

export type LocalModelState = 'stopped' | 'starting' | 'ready' | 'failed' | 'external'

export interface LocalModelStatus {
  state: LocalModelState
  /** 我们起的进程的 pid；外部实例或未运行时为 undefined */
  pid?: number
  /** 就绪之后从 `/props` 读到的窗口；没读到时为 undefined */
  ctxSize?: number
  /** 人话说明。**要能直接给用户看** */
  detail: string
  /** 起不来的原因 / 最近一次的错误。**取前几行，不是后几行** */
  error?: string
}

/** 载入 20 GB 要一会儿。给足时间，但别无限等 */
const READY_TIMEOUT_MS = 5 * 60 * 1000

/** `/health` 的轮询间隔。llama-server 加载期间回 503，就绪后 200 */
const HEALTH_POLL_MS = 1500

/**
 * 常见位置里的 `llama-server`。
 *
 * ## 顺序是有讲究的
 *
 * 1. **显式配置的**（`serverPath`）—— 用户说了算
 * 2. **`Venture-main/_repos/llamacpp/`** —— 用户实测调参用的那个构建（b11323 CUDA）。
 *    `-ncmoe` / `-cram` 这些旗标是**较新的**，Ollama 内置的那份未必认；
 *    而且调参数据全是在这个构建上扫出来的，**用它才可复现**。
 * 3. Ollama 自带的那份 —— 装了 Ollama 就有，是个方便的兜底
 * 4. PATH 上的 —— 最不确定，放最后免得盖掉上面的确定答案
 */
function findServer(explicit: string | undefined): string | null {
  if (explicit !== undefined && explicit !== '') {
    return existsSync(explicit) ? explicit : null
  }

  const candidates: string[] = []
  const userProfile = process.env['USERPROFILE'] ?? ''
  const local = process.env['LOCALAPPDATA'] ?? ''
  const home = process.env['USERPROFILE'] ?? ''

  // 2. 用户自己那套（实测用的构建）
  for (const base of [home, userProfile]) {
    if (base === '') continue
    const repos = path.join(base, 'Downloads', 'Venture-main', '_repos', 'llamacpp')
    if (existsSync(repos)) {
      try {
        for (const entry of readdirSync(repos)) {
          const exe = path.join(repos, entry, 'llama-server.exe')
          if (existsSync(exe)) candidates.push(exe)
        }
      } catch {
        /* 读不了就跳过 */
      }
    }
  }

  // 3. Ollama 自带的
  if (local !== '') {
    candidates.push(path.join(local, 'Programs', 'Ollama', 'lib', 'ollama', 'llama-server.exe'))
    candidates.push(path.join(local, 'Programs', 'llama.cpp', 'llama-server.exe'))
  }
  if (userProfile !== '') candidates.push(path.join(userProfile, 'llama.cpp', 'llama-server.exe'))
  candidates.push('C:\\Program Files\\llama.cpp\\llama-server.exe')

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  // 最后才靠 PATH
  return 'llama-server.exe'
}

/** 「配置够不够起」——不够就如实说缺什么，而不是起一个注定失败的进程 */
export function missingConfig(config: LocalModelConfig | undefined): string[] {
  const missing: string[] = []
  if (config === undefined || config.modelPath === undefined || config.modelPath === '') {
    missing.push('modelPath（GGUF 模型的绝对路径）')
  } else if (!existsSync(config.modelPath)) {
    missing.push(`modelPath 指向的文件不存在：${config.modelPath}`)
  }
  if (config?.serverPath !== undefined && config.serverPath !== '' && !existsSync(config.serverPath)) {
    missing.push(`serverPath 指向的文件不存在：${config.serverPath}`)
  }
  return missing
}

/**
 * 拼命令行。
 *
 * ## 这套旗标是**实测调出来的**，不是猜的
 *
 * 来自 `Venture-main/run-35b.ps1` 和 `README-30B-MoE.md`（用户自己扫参的记录）。
 * 核心结论一句话：
 *
 *     MoE 模型的性能几乎完全由「专家层放在哪」决定，显存塞得越满越慢。
 *
 * 所以形状是：**attention 全部上 GPU（`-ngl 999`），专家层按显存余量分档
 * （`-ncmoe N`）**，找到刚好不溢出的那个点。
 *
 * ⚠️ 我第一版写的是 `-ngl 0` —— **零层上 GPU**。理由是「显存留给小模型」，
 * 那是我自己编的约束，代价是一点 GPU 都没用上：载入 155 秒、12 GB 显存空着。
 * 这条被用户直接指出来了（「光占内存不占显存」）。
 *
 * ## 两个会静默出错的细节
 *
 * 1. **`-fa` 要带值。** 这个构建把它当 `--flash-attn` 的取值形式，裸 `-fa`
 *    会把**下一个参数**当成值吃掉，报出来的是
 *    「unknown value for --flash-attn: '-ngl'」—— 看起来像 `-ngl` 有问题。
 * 2. **`--parallel 1` 不能省。** 默认多 slot 会把显存切成几份，而显存在这里
 *    是最稀缺的资源。
 */
export function buildArgs(config: LocalModelConfig, modelPath: string): string[] {
  const args = ['-m', modelPath]

  /*
   * -ngl 默认 999（全上 GPU）。**不是 0。**
   *
   * 这里管的是非专家部分（attention、嵌入、norm）—— 很小但算得最频繁，
   * 放 GPU 是纯赚。占地方的专家张量由 -ncmoe 单独控。
   */
  args.push('-ngl', String(config.gpuLayers ?? 999))

  if (config.cpuMoeLayers !== undefined) args.push('-ncmoe', String(config.cpuMoeLayers))
  if (config.ctxSize !== undefined) args.push('-c', String(config.ctxSize))
  args.push('-fa', config.flashAttention === false ? 'off' : 'on')
  if (config.cacheTypeK !== undefined) args.push('-ctk', config.cacheTypeK)
  if (config.cacheTypeV !== undefined) args.push('-ctv', config.cacheTypeV)
  if (config.cacheRam !== undefined) args.push('-cram', String(config.cacheRam))
  args.push('--parallel', String(config.parallel ?? 1))

  /*
   * ── 思考：默认 `on`（明确开着）──────────────────────────────────────
   *
   * ## 实测的三种取值（同一个问题、同一个 900 token 上限）
   *
   *     off    1.6s  finish=stop    思考 0 字符     正文 5 字符（"23 12"，答对）
   *     auto  17.5s  finish=length  思考 2552 字符  正文 0 字符
   *     on    17.3s  finish=length  思考 2510 字符  正文 0 字符
   *
   * 所以 `off` 是**完全不思考**（`reasoning_content` 字段根本不出现），
   * `auto` / `on` 才把思考放进 `reasoning_content`。
   *
   * ## 为什么默认写 `on` 而不是 `auto`
   *
   * 两者的实测差别**小到可以忽略**（2552 vs 2510 字符，耗时几乎一样）。
   * 写 `on` 是因为用户明确要「默认开启」——`auto` 的语义是「让模型/服务端决定」，
   * 那和「默认开启」不是一回事：一个明确的默认值不该把决定权再交出去。
   *
   * 要关掉就显式写 `"reasoning": "off"`。
   *
   * ## ⚠️ 开思考就要给够输出预算
   *
   * 上表里 `auto` / `on` 那两行**都没有正文** —— 不是坏了，是 900 token
   * 的上限**被思考吃光了**（`finish_reason: length`）。
   * `src/host/session.ts` 里专门有一条分支处理「只产出了思考、没有正文」的回合，
   * 并把原因说出来 —— 所以它不会静默变成一条空消息。
   *
   * ## 我第一次改错了
   *
   * 我一度把默认设成 `off`，依据是「`on` 会把服务打崩」——
   * 那是我反复 `taskkill` 留下的**半死进程**造成的假象。
   * 复测用 `tools/probe-reasoning-sweep.mjs`（起 → 探 → 关，每个取值一个干净进程），
   * 三种取值都稳。**在脏环境里测出来的因果关系不算数。**
   */
  args.push('--reasoning-format', config.reasoningFormat ?? 'deepseek')
  args.push('--reasoning', config.reasoning ?? 'on')
  if (config.reasoningBudget !== undefined && config.reasoningBudget >= 0) {
    args.push('--reasoning-budget', String(config.reasoningBudget))
  }

  if (config.alias !== undefined) args.push('--alias', config.alias)
  args.push('--host', '127.0.0.1')
  if (config.port !== undefined) args.push('--port', String(config.port))
  if (config.extraArgs !== undefined) args.push(...config.extraArgs)
  return args
}

/** 端口上有没有人在听（不管是不是我们起的） */
async function probeHealth(port: number, timeoutMs = 3000): Promise<{ ok: boolean; props?: unknown }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal })
      if (!res.ok) return { ok: false }
      // 就绪了就顺手问一下窗口 —— 界面要显示「实际生效的窗口」
      try {
        const props = await (await fetch(`http://127.0.0.1:${port}/props`, { signal: controller.signal })).json()
        return { ok: true, props }
      } catch {
        return { ok: true }
      }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return { ok: false }
  }
}

/** 端口上是不是有人（哪怕它不是一个 llama-server） */
async function portInUse(port: number): Promise<boolean> {
  const net = await import('node:net')
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    const done = (value: boolean): void => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(1200)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

export class LocalModelSupervisor {
  #config: LocalModelConfig | undefined
  #child: ChildProcess | null = null
  #state: LocalModelState = 'stopped'
  #detail = '还没启动'
  #error: string | undefined
  #ctxSize: number | undefined
  #starting: Promise<LocalModelStatus> | null = null

  constructor(config: LocalModelConfig | undefined) {
    this.#config = config
  }

  /** 配置变了（界面改过）之后换一份。**不会因此重启进程** */
  update(config: LocalModelConfig | undefined): void {
    this.#config = config
  }

  get port(): number {
    return this.#config?.port ?? 8080
  }

  status(): LocalModelStatus {
    return {
      state: this.#state,
      ...(this.#child?.pid === undefined ? {} : { pid: this.#child.pid }),
      ...(this.#ctxSize === undefined ? {} : { ctxSize: this.#ctxSize }),
      detail: this.#detail,
      ...(this.#error === undefined ? {} : { error: this.#error }),
    }
  }

  /**
   * 看现在到底是个什么状况 —— **不改任何状态**。
   *
   * 界面每次打开都会调它。之所以要「不改状态」：如果它会顺手把
   * 「我们以为在跑但已经死了」的进程标成 stopped，那它就不是一个只读操作了，
   * 而界面刷新不该有副作用。状态修正放在 `start()` / `stop()` 里做。
   */
  async inspect(): Promise<LocalModelStatus> {
    const health = await probeHealth(this.port)

    if (this.#state === 'external') {
      // 外部实例可能被用户关掉了
      if (!health.ok) {
        this.#state = 'stopped'
        this.#detail = '之前那个外部实例已经不在了'
      }
      return this.status()
    }

    if (this.#state === 'ready') {
      if (!health.ok) {
        this.#state = 'stopped'
        this.#detail = '服务不响应了（进程可能已经退出）'
      } else if (this.#ctxSize === undefined && health.props !== undefined) {
        this.#ctxSize = readCtx(health.props)
      }
      return this.status()
    }

    /*
     * 我们在「已停止」的状态，但端口上有人 —— 那是**别人起的**。
     * 标成 `external`：报告出来，但不接管、不提供停止。
     * 抢的后果是「我明明起了一个，它又起一个」而两个在抢同一块内存。
     */
    if (this.#state === 'stopped' && (await portInUse(this.port))) {
      this.#state = 'external'
      this.#ctxSize = health.ok ? readCtx(health.props) : undefined
      this.#detail =
        `端口 ${this.port} 上已经有一个实例（不是这次启动的）—— ` +
        `只报告，不接管；要停请停你自己的那个`
      return this.status()
    }

    return this.status()
  }

  /**
   * 启动。**调用方要当作「发起」而不是「等待完成」** ——
   * 就绪要几十秒到几分钟，期间状态由 `status()` / `inspect()` 反映。
   *
   * ⚠️ 第一版这里是「等就绪再 resolve」，而路由又 `await` 它 ——
   * 于是 `POST /local-model {action:'start'}` 会**挂 45 秒到 5 分钟**才回响应。
   * 实测撞出来的：注释写着「立刻返回」，行为和它相反。浏览器那边表现为请求卡死，
   * 而用户完全不知道后面在载入 20 GB。
   *
   * 现在**同步**把状态置成 `starting` 再返回，让调用方（和界面）立刻看得到进展。
   *
   * 重复调用会**共用同一次启动** —— 界面上连点两下不该起两个进程。
   */
  start(): LocalModelStatus {
    if (this.#state === 'starting' || (this.#state === 'ready' && this.#child !== null)) {
      return this.status()
    }

    /*
     * ★ 先同步落状态，再异步干活。
     *
     * 顺序很重要：`#doStart` 里第一个 await 之前都不碰 `#state`，
     * 所以如果只调 `void this.#doStart()`，调用方紧接着读状态会看到**旧值**
     * （`stopped`），于是界面显示「未运行」而实际上正在启动 —— 一次静默的谎报。
     */
    const missing = missingConfig(this.#config)
    if (missing.length > 0) {
      this.#state = 'failed'
      this.#error = `配置不完整：${missing.join('；')}`
      this.#detail = '没有配置本地模型，无法启动'
      return this.status()
    }
    this.#state = 'starting'
    this.#error = undefined
    this.#detail = '正在启动，载入模型可能要一会儿'

    if (this.#starting === null) {
      const run = this.#doStart()
      this.#starting = run
      void run.finally(() => {
        this.#starting = null
      })
    }
    return this.status()
  }

  async #doStart(): Promise<LocalModelStatus> {
    if (this.#state === 'ready' && this.#child !== null) {
      return this.status()
    }

    const missing = missingConfig(this.#config)
    if (missing.length > 0) {
      this.#state = 'failed'
      this.#error = `配置不完整：${missing.join('；')}`
      this.#detail = '没有配置本地模型，无法启动'
      return this.status()
    }

    if (await portInUse(this.port)) {
      const health = await probeHealth(this.port)
      this.#state = 'external'
      this.#ctxSize = health.ok ? readCtx(health.props) : undefined
      this.#detail = `端口 ${this.port} 上已经有一个实例，不重复启动`
      this.#error = undefined
      return this.status()
    }

    const config = this.#config!
    const server = findServer(config.serverPath)
    if (server === null) {
      this.#state = 'failed'
      this.#error = `找不到 llama-server（配置里的 serverPath 指向不存在的文件：${String(config.serverPath)}）`
      this.#detail = '没找到本地模型的可执行文件'
      return this.status()
    }

    const args = buildArgs(config, config.modelPath!)
    const logDir = path.join(tmpdir(), 'mvs-local-model')
    mkdirSync(logDir, { recursive: true })
    const outPath = path.join(logDir, 'llama-server.log')
    const errPath = path.join(logDir, 'llama-server.err.log')

    /*
     * ⚠️ 日志走**文件描述符**，不走管道。
     *
     * 本环境里管道会同步抛 EPERM（见项目里那条记录），而且管道还有第二个坑：
     * 没人读的话缓冲区满会把子进程写阻塞住 —— 一个 20 GB 的模型加载时
     * 会刷很多行，正好撞上。
     */
    const outFd = openSync(outPath, 'w')
    const errFd = openSync(errPath, 'w')

    let child: ChildProcess
    try {
      child = spawn(server, args, {
        // detached：守护进程退出不该带走它；用户可能想让它继续跑
        detached: true,
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
      })
    } finally {
      closeSync(outFd)
      closeSync(errFd)
    }

    this.#child = child
    this.#state = 'starting'
    this.#error = undefined
    this.#detail = `正在启动（pid ${String(child.pid)}），载入模型可能要一会儿`

    /*
     * 子进程自己的退出要**记下来** —— 否则加载失败时状态会永远停在
     * 「启动中」，而用户看到的是一个转不完的圈。
     */
    let exited: { code: number | null } | null = null
    child.on('exit', (code) => {
      exited = { code }
    })
    child.on('error', (err) => {
      exited = { code: null }
      this.#error = `启动失败：${err.message}`
    })

    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      const health = await probeHealth(this.port)
      if (health.ok) {
        this.#state = 'ready'
        this.#ctxSize = readCtx(health.props)
        this.#detail =
          this.#ctxSize === undefined
            ? `已就绪（pid ${String(child.pid)}）`
            : `已就绪（pid ${String(child.pid)}，窗口 ${String(this.#ctxSize)}）`
        return this.status()
      }

      /*
       * ⚠️ 这里要读一份快照再判空。直接 `if (exited !== null)` 的话 TypeScript
       * 的控制流分析会把 `exited` 收窄成 `never`（它认为闭包里不会再赋值），
       * 于是 `exited.code` 报「属性不存在」。
       */
      const exitedNow = exited as { code: number | null } | null
      if (exitedNow !== null) {
        this.#state = 'failed'
        this.#detail = '进程退出了'
        this.#error =
          this.#error ??
          (await readErrorTail(errPath)) ??
          `进程退出（码 ${String(exitedNow.code)}），日志：${errPath}`
        this.#child = null
        return this.status()
      }

      if (Date.now() > deadline) {
        this.#state = 'failed'
        this.#detail = `超过 ${READY_TIMEOUT_MS / 1000} 秒还没就绪`
        this.#error = (await readErrorTail(errPath)) ?? `日志：${errPath}`
        return this.status()
      }

      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS))
    }
  }

  /** 停掉**我们起的**那个。外部实例不动 —— 它不是我们的 */
  async stop(): Promise<LocalModelStatus> {
    if (this.#state === 'external') {
      this.#detail = '这是外部实例，不归这里管 —— 请停你自己起的那个'
      return this.status()
    }
    const child = this.#child
    if (child?.pid !== undefined) {
      try {
        // 负 pid = 整个进程组。detached 起的就是一个组长
        process.kill(-child.pid)
      } catch {
        try {
          child.kill()
        } catch {
          /* 已经退出了 */
        }
      }
    }
    this.#child = null
    this.#state = 'stopped'
    this.#ctxSize = undefined
    this.#error = undefined
    this.#detail = '已停止'
    return this.status()
  }

  /**
   * 守护进程引导时调用。
   *
   * `start()` 现在**同步返回**（只落状态、后台干活），所以这里不需要 await，
   * 也不需要接 catch —— 失败会被写进状态，由 `/local-model` 报出去。
   */
  autoStart(): void {
    if (this.#config?.autoStart !== true) return
    if (missingConfig(this.#config).length > 0) return
    this.start()
  }
}

/** 从 `/props` 里读窗口。字段名在不同构建上见过两种 */
function readCtx(props: unknown): number | undefined {
  if (props === null || typeof props !== 'object') return undefined
  const record = props as Record<string, unknown>
  const direct = record['default_generation_settings']
  if (direct !== null && typeof direct === 'object') {
    const nCtx = (direct as Record<string, unknown>)['n_ctx']
    if (typeof nCtx === 'number' && nCtx > 0) return nCtx
  }
  const nCtx = record['n_ctx']
  return typeof nCtx === 'number' && nCtx > 0 ? nCtx : undefined
}

/**
 * 读错误日志的**开头几行**。
 *
 * ⚠️ 不是尾部。llama.cpp 的报错在启动早期就打出来了，后面全是加载进度；
 * 取尾部会拿到一堆进度条而丢掉真正的 `error:` 那行。
 * 这个错我在这个项目里犯过两次（PowerShell 的 stderr、Node 的 EADDRINUSE）。
 */
async function readErrorTail(errPath: string): Promise<string | undefined> {
  try {
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(errPath, 'utf8')
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
    const at = lines.findIndex((line) => /error|failed|unknown argument|invalid/i.test(line))
    const picked = at >= 0 ? lines.slice(at, at + 3) : lines.slice(0, 3)
    const joined = picked.map((line) => line.trim()).join(' / ')
    return joined === '' ? undefined : joined
  } catch {
    return undefined
  }
}
