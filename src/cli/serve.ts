/**
 * 启动运行时并对外提供本地 HTTP + WebSocket。
 *
 * 用法：
 *   node src/cli/serve.ts --profile ollama --dev
 *   node src/cli/serve.ts --base-url http://127.0.0.1:8787/v1 --model fake --port 3080 --dev
 *
 * 启动后会打印一个带令牌的地址，用浏览器打开即可。
 *
 * ⚠️ 安全前提（见 src/host/server.ts 顶部）：
 *   只绑 127.0.0.1 · 必须带令牌 · 校验 Host 头 · 校验 Origin。
 *   这四道都是默认开的，不要为了「方便」关掉任何一道。
 */

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import process from 'node:process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostServer, Runtime } from '../host/index.ts'
import { ConfigStore, defaultHomeDir, type ConfigOverrides } from '../config/index.ts'
import { DEFAULT_COMPACTION, usableBudget } from '../context/types.ts'
import { dim } from './style.ts'

/** 命令行参数。**只装覆盖值** —— 常态配置在 config.json 里 */
interface CliArgs {
  overrides: ConfigOverrides
  workspace: string
  dev: boolean
  /** 用 Edge 应用窗口打开界面 */
  app: boolean
  /**
   * 要不要令牌。
   *
   * **默认不要** —— 开发阶段本机只有你一个人用，而唯一真正需要防的
   * （浏览器里的恶意页面）由 Host / Origin / Sec-Fetch-Site 三道围栏挡住。
   * 见 `HostServerOptions.requireToken`。
   */
  requireToken: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const overrides: ConfigOverrides = {}
  let workspace = process.cwd()
  let dev = false
  let app = false
  let requireToken = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = (): string => {
      i += 1
      return argv[i] ?? ''
    }
    switch (arg) {
      case '--profile': overrides.profile = next(); break
      case '--base-url': overrides.baseUrl = next(); break
      case '--model': overrides.model = next(); break
      case '--api-key': overrides.apiKey = next(); break
      case '--context-window': overrides.contextWindow = Number(next()) || undefined; break
      case '--port': overrides.port = Number(next()) || undefined; break
      case '--workspace': workspace = next(); break
      case '--dev': dev = true; break
      case '--app': app = true; break
      case '--no-app': app = false; break
      case '--require-token': requireToken = true; break
      case '--no-token': requireToken = false; break
      case '--mode': {
        const value = next()
        if (value === 'read-only' || value === 'workspace-write' || value === 'full-access') {
          overrides.defaultMode = value
        }
        break
      }
      default:
        break
    }
  }

  return { overrides, workspace, dev, app, requireToken }
}

const args = parseArgs(process.argv.slice(2))

const workspace = path.resolve(args.workspace)

// ── 运行时：配置、工作区、会话都在它里面 ────────────────────────────────────
//
// 配置解析和窗口探测**只在这里做一次** —— 之前 serve.ts 和 Runtime 各解析一遍，
// 那是两份可能漂移的事实。命令行覆盖值传进去，Runtime 是唯一的事实来源。
const configStore = new ConfigStore()
const runtime = new Runtime({
  config: configStore,
  overrides: args.overrides,
})
await runtime.init()

// 命令行指定的工作区直接开；已经在索引里的就不重复留审计
await runtime.openWorkspace(workspace)

const resolved = runtime.resolved
const window = runtime.windowInfo()

/*
 * 令牌落在一个**固定文件**里，重启复用。
 *
 * 不落盘的话每次都换一个，于是带令牌的链接一重启就作废、已经发出去的 cookie
 * 也一起失效 —— 表现就是「每次都要重新拿令牌」。
 *
 * 和配置同处（`MVS_HOME` 或 `~/.mvs-agent`），写入权限 0600。
 */
const tokenFile = path.join(defaultHomeDir(), 'host-token')

const server = new HostServer({
  runtime,
  port: resolved.port,
  tokenFile,
  requireToken: args.requireToken,
  serveDevClient: args.dev,
})
const info = await server.listen()

const state = runtime.state()
const budget = usableBudget({ ...DEFAULT_COMPACTION, windowTokens: window.windowTokens })

process.stdout.write(`\n  MVS Agent 已启动\n\n`)
process.stdout.write(`  配置      ${configStore.configPath}\n`)
process.stdout.write(`  索引      ${runtime.statePath}\n`)
process.stdout.write(
  `  模型      ${resolved.model}  @ ${resolved.baseUrl}${resolved.apiKey === undefined ? ' (无 key)' : ''}\n`,
)
process.stdout.write(
  `  密钥来源  ${resolved.apiKeySource}` +
    `${resolved.apiKeySourceVar === undefined ? '' : `（${resolved.apiKeySourceVar}）`}\n`,
)
process.stdout.write(`  默认模式  ${resolved.defaultMode}\n`)
process.stdout.write(
  `  上下文    窗口 ${window.windowTokens} · 可用预算 ${budget}（预留 ${DEFAULT_COMPACTION.outputReserveTokens} 给输出）\n`,
)
process.stdout.write(`            来源：${window.source}\n`)
process.stdout.write(
  `            ${dim('超过可用预算的 90% 才压缩 —— 即将超出，不是有点大了')}\n`,
)
process.stdout.write(
  `  索引      ${state.workspaces.length} 个工作区 · ${state.sessions.length} 个会话\n`,
)

for (const warning of runtime.warnings) {
  process.stdout.write(`  ⚠ ${warning}\n`)
}

/*
 * 地址工具。
 *
 * 两个名字很像，区别只有一句：**要不要先换一次 cookie**。
 *
 *   · `publicUrl`    —— 不带令牌参数的干净地址。默认（不要求令牌）就用它
 *   · `firstTimeUrl` —— 带令牌的入口：先让 `/auth` 换 cookie、再跳到 `next`
 *
 * 为什么必须有后者：页面上的 `fetch` 认 cookie，不认地址栏里的 `?token=`，
 * 所以要求令牌时第一次必须先换一次。
 */
/** web/ 下有没有这个文件。只在文件真的在时才把地址印出来 —— 指一个打不开的地址是误导 */
const dist = (rel: string): boolean =>
  existsSync(path.join(fileURLToPath(new URL('../../web/', import.meta.url)), rel))

/**
 * **干净地址** —— 不带令牌参数、直接可开、可以收藏。
 *
 * 只在**不要求令牌**时能用（默认就是）。要令牌时必须走 firstTimeUrl。
 */
const publicUrl = (rel: string): string => `${info.origin}${rel}`

/** 带令牌的入口地址。**只在要求令牌时才有意义** */
const firstTimeUrl = (rel: string): string => `${info.origin}/auth?token=${info.token}&next=${rel}`


if (args.dev) {
  process.stdout.write(`\n  界面（Vite 开发服务器，带热更新）：\n    ${info.origin}/?token=${info.token}\n`)
  process.stdout.write(`    ${dim('先在另一个终端跑 npm run web:dev，然后打开 http://127.0.0.1:5173/?token=…')}\n`)
} else {
  /*
   * 令牌**默认关着**，所以这里一律给干净地址，不提令牌那一套。
   * 只有显式 `--require-token` 时横幅才会多出「首次打开」那一条。
   */
  process.stdout.write(`  界面      ${publicUrl('/')}\n`)
  process.stdout.write(
    `            ${dim('React 界面（ui/ → web/）：会话、工具块、设置都在这一份里')}\n`,
  )
  process.stdout.write(`  端点      ${info.origin}\n`)

  if (server.requireToken) {
    process.stdout.write(
      `\n  ${dim('令牌已开启。用这条换一次 cookie（每个浏览器一次，之后 7 天内走上面的干净地址即可）：')}\n`,
    )
    process.stdout.write(`  ${dim(`首次打开  ${firstTimeUrl('/')}`)}\n`)
    process.stdout.write(`  令牌      ${info.token}\n`)
    /*
     * 说明令牌是新建的还是复用的。
     *
     * 这条信息很要紧：**复用意味着链接重启后照样能开**，而新建意味着旧的作废了。
     * 不说的话，用户只能靠「点了打不开」来发现。
     */
    const tokenNote =
      server.tokenSource === 'reused'
        ? `令牌文件  ${tokenFile}（复用，链接重启后依然有效）`
        : server.tokenSource === 'created'
          ? `令牌文件  ${tokenFile}（新建${server.tokenFileNote === undefined ? '' : '，旧内容不合法已替换'}）`
          : `令牌      内存随机（本次进程有效）`
    process.stdout.write(`  ${dim(tokenNote)}\n`)
  } else {
    process.stdout.write(
      `  ${dim('未要求令牌（默认）。挡的是浏览器里的恶意页面 —— Host / Origin / Sec-Fetch-Site 三道围栏，与令牌无关，一直生效。')}\n`,
    )
    process.stdout.write(
      `  ${dim('要令牌就加 --require-token：那时「能连上端口」和「有权限」才分成两件事（防同机器另一个账户）。')}\n`,
    )
  }
}

if (args.app) {
  /*
   * 窗口开**主界面** —— 也就是 `/`，我们自己的那份 React 界面。
   *
   * 这里原来还有两段"不是 X"的解释：不是 `/brand/`（logo 对照页）、不是 `/dsh/`
   * （静态快照）。两个页面都已经删了（连同生成器），所以那两段只剩考古价值。
   *
   * 地址**取决于要不要令牌**：
   *   · 不要令牌（默认）→ 干净地址
   *   · 要令牌 → 必须带令牌，因为那个窗口用独立 profile，第一次没有 cookie
   */
  const target = server.requireToken ? firstTimeUrl('/') : publicUrl('/')
  const label = '主界面'
  const launched = launchAppWindow(target)
  process.stdout.write(
    launched
      ? `  ${dim(`已用 Edge 应用窗口打开${label}（独立 profile，不碰你自己的浏览器数据）`)}\n`
      : `  ⚠ 没能拉起 Edge 应用窗口 —— 手动打开上面的地址即可\n`,
  )
}
/*
 * 收尾说明。
 *
 * ⚠️ 措辞要**跟着 `requireToken` 走**，不能写死。
 * 我第一版这里硬写着「四道防护默认开启 · 必须带令牌」，而令牌已经默认关了 ——
 * 于是横幅在**骗人**：它宣称的保护有一半不存在。这种不一致比没有说明更糟，
 * 因为它会让人以为已经有凭据隔离了。
 */
process.stdout.write(`\n  ⚠ 这是个能执行命令的本地服务。防护默认开启：\n`)
process.stdout.write(
  server.requireToken
    ? `    只绑 127.0.0.1 · 要令牌 · Host 必须是回环 · Origin 必须是回环 · 拒跨站\n`
    : `    只绑 127.0.0.1 · Host 必须是回环 · Origin 必须是回环 · 拒跨站\n` +
      `    ${dim('（未要令牌：本机同账户下的进程本来就能直接执行命令，挡它们没有意义。')}\n` +
      `    ${dim('  要防「同机器另一个账户」请加 --require-token。）')}\n`,
)
if (server.requireToken) {
  process.stdout.write(`  ⚠ 令牌只在打开链接时用一次，随后换成 httpOnly cookie —— 地址栏里不会留着它\n`)
}
process.stdout.write(`  ⚠ 多工作区扩大了爆炸半径 —— 每次打开新路径都会记进审计\n\n`)
process.stdout.write(`  Ctrl+C 退出\n`)

/**
 * 用 Edge 的应用窗口打开界面。
 *
 * 为什么是 Edge：**Windows 自带，所以零安装、零原生代码。** 而 `--app=` 是无地址栏
 * 的独立窗口，看起来就是个应用，不是浏览器标签页。
 *
 * `--user-data-dir` 指向我们自己的目录，这一点很要紧：不加的话它会用用户**默认的**
 * Edge profile —— 于是我们的小工具会出现在他的浏览历史里、会受他装的扩展影响、
 * 也可能被他的企业策略限制。实测过加了这个参数会在独立目录里建出完整 profile
 * （Default / Crashpad / …），用户自己的数据一个字节都没动。
 *
 * 刻意**不等待**它退出：窗口是用户的，不是我们的子进程；关掉窗口不等于关掉服务
 * （服务还在跑，任务还在，重开链接就能回来）。
 */
function launchAppWindow(url: string): boolean {
  if (process.platform !== 'win32') return false
  const candidates = [
    path.join(process.env['ProgramFiles'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(
      process.env['ProgramFiles(x86)'] ?? '',
      'Microsoft',
      'Edge',
      'Application',
      'msedge.exe',
    ),
  ]
  const edge = candidates.find((candidate) => candidate !== '' && existsSync(candidate))
  if (edge === undefined) return false

  try {
    const child = spawn(
      edge,
      [
        `--app=${url}`,
        `--user-data-dir=${path.join(defaultHomeDir(), 'ui-profile')}`,
        '--no-first-run',
        '--no-default-browser-check',
        /*
         * 必须给足宽度，否则侧栏会折叠成一条 rail。
         *
         * DSH 界面里那条判据是 `narrow = viewport < 1024`（`SIDEBAR_AUTO_COLLAPSE`），
         * 窄了就把侧栏收成 rail —— 实测 996px 的窗口正好落在门槛下面，
         * 于是用户看到的是一个「空壳」，而其实数据都在。
         *
         * 这里给 1440×900：既过了 1024 的门槛，也留出右侧栏的余量。
         */
        '--window-size=1440,900',
        // 一个本地工具不需要这些
        '--disable-features=Translate,MediaRouter',
      ],
      // stdio 必须是 ignore：这个环境里 pipe 会同步抛 EPERM（见 command-tool.ts）
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    child.unref()
    return true
  } catch {
    return false
  }
}

let shuttingDown = false
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return
  shuttingDown = true
  process.stdout.write('\n  正在关闭…\n')
  await server.close()
  await runtime.dispose()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
