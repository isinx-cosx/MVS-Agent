/**
 * 断言：`HANDLE_LIST` 真的挡住了"别的句柄被继承"。
 *
 * ## 为什么要**双向**
 *
 * 只证明"沙箱里拿不到"（EBADF）是不够的：EBADF 也可能来自"Windows 根本不会继承
 * 这个句柄" —— 那样我们什么也没证明。必须有正向对照：
 *
 *   · **对照**：自己调 `CreateProcessW(bInheritHandles = TRUE)`，子进程应当**写成功**
 *   · **沙箱**：同样的句柄交给 `sandbox-net-run.mjs` 启动，子进程应当 `EBADF`
 *
 * ## 为什么对照不放在产品代码里
 *
 * 正向对照需要"不设 HANDLE_LIST 的启动路径"。把它加进 runner 等于为了测试留一个
 * 不安全开关。所以对照在这个探针里**自己调 CreateProcessW** —— 它只存在于 tools/。
 *
 *     node tools/handle-list-probe.mjs
 *
 * 判定：`isolated-verified`（对照 WROTE + 沙箱 EBADF）/ `LEAKED` / `control-broken`。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CANDIDATES = [
  process.env.MVS_KOFFI,
  'koffi',
  'file:///C:/Program Files/DSH NEXT/resources/app/node_modules/koffi/index.cjs',
].filter((item) => typeof item === 'string' && item !== '')

async function loadKoffi() {
  for (const candidate of CANDIDATES) {
    try {
      const loaded = await import(String(candidate))
      const koffi = loaded.default ?? loaded
      if (typeof koffi?.load === 'function') return koffi
    } catch {
      /* 下一个 */
    }
  }
  return null
}

const koffi = await loadKoffi()
if (koffi === null) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'koffi 不可用' })}\n`)
  process.exit(1)
}

const RUNNER = path.join(process.cwd(), 'tools', 'sandbox-net-run.mjs')
const dir = mkdtempSync(path.join(tmpdir(), 'mvs-handle-'))
const kernel = koffi.load('kernel32.dll')

const SECURITY_ATTRIBUTES = koffi.struct('SECURITY_ATTRIBUTES', {
  nLength: 'uint32',
  lpSecurityDescriptor: 'void *',
  bInheritHandle: 'int32',
})
const STARTUPINFO = koffi.struct('MVS_STARTUPINFO', {
  cb: 'uint32',
  lpReserved: 'str16',
  lpDesktop: 'str16',
  lpTitle: 'str16',
  dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
  dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16', cbReserved2: 'uint16', lpReserved2: 'void *',
  hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
})
const PROCESS_INFORMATION = koffi.struct('MVS_PROCESS_INFORMATION', {
  hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32',
})

const CreateFileW = kernel.func(
  'void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)',
)
const CreateProcessW = kernel.func(
  'int32 __stdcall CreateProcessW(str16, str16, void *, void *, int32, uint32, void *, str16, MVS_STARTUPINFO *, MVS_PROCESS_INFORMATION *)',
)
const WaitForSingleObject = kernel.func('uint32 __stdcall WaitForSingleObject(void *, uint32)')
const CloseHandle = kernel.func('int32 __stdcall CloseHandle(void *)')

const GENERIC_WRITE = 0x40000000
const FILE_SHARE_ALL = 0x00000007
const CREATE_ALWAYS = 2
const STARTF_USESTDHANDLES = 0x00000100

/** 开一个可继承句柄（子进程能看到的"别的句柄"） */
function openInheritable(file) {
  /*
   * SECURITY_ATTRIBUTES 手工布局：nLength(4) + 对齐 + 描述符指针(8) + bInheritHandle(4)。
   * 之前传 JS 对象给 koffi，`bInheritHandle` 因为对齐落到别的偏移，句柄其实**没**标成可继承 ——
   * 于是"正向对照"也拿到 EBADF，看起来像拦截生效，实际是对照本身没成立。
   * 这和当初 PROCESS_INFORMATION / JOBOBJECT_ACCOUNTING 是同一类错误。
   */
  const sa = Buffer.alloc(24)
  sa.writeUInt32LE(24, 0)
  sa.writeUInt32LE(1, 16)
  const handle = CreateFileW(file, GENERIC_WRITE, FILE_SHARE_ALL, sa, CREATE_ALWAYS, 0x80, null)
  return { handle, value: handle === null ? undefined : Number(koffi.address(handle)) }
}

const childCode = [
  "const fs = require('fs')",
  'try {',
  "  fs.writeSync(Number(process.argv[1]), Buffer.from('leaked'))",
  "  console.log('WROTE')",
  '} catch (error) {',
  "  console.log('DENIED ' + (error.code ?? error.message))",
  '}',
].join('\n')

function quote(item) {
  return `"${item}"`
}

/* ① 正向对照：自己调 CreateProcessW，bInheritHandles = TRUE */
function controlRun() {
  const outPath = path.join(dir, 'control.out')
  const handleFile = path.join(dir, 'inheritable.txt')
  const { handle: target, value } = openInheritable(handleFile)
  const out = openInheritable(outPath)

  const line = [quote(process.execPath), '-e', quote(childCode), String(value)].join(' ')
  const lineBuffer = Buffer.concat([Buffer.from(line, 'utf16le'), Buffer.from([0, 0])])

  const startup = {}
  startup.cb = koffi.sizeof(koffi.types.MVS_STARTUPINFO ?? 'MVS_STARTUPINFO')
  startup.dwFlags = STARTF_USESTDHANDLES
  startup.hStdOutput = out.handle
  startup.hStdError = out.handle
  startup.hStdInput = null

  const info = Buffer.alloc(koffi.sizeof(koffi.types.MVS_PROCESS_INFORMATION ?? 'MVS_PROCESS_INFORMATION'))
  const created = CreateProcessW(null, lineBuffer, null, null, 1, 0, null, null, startup, info)
  if (created === 0) return { created: false }

  WaitForSingleObject(info !== null ? null : null, 0)
  /* 用 node 的 pid 等待：从结构里读 hProcess */
  const processHandle = koffi.decode(info, 'MVS_PROCESS_INFORMATION').hProcess
  WaitForSingleObject(processHandle, 20_000)
  CloseHandle(processHandle)
  if (target !== null) CloseHandle(target)

  const text = readFileSync(outPath, 'utf8')
  return { created: true, text }
}

/* ② 沙箱：同一个可继承句柄交给 runner */
function sandboxRun() {
  const handleFile = path.join(dir, 'sandbox-inheritable.txt')
  const { handle: target, value } = openInheritable(handleFile)

  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [RUNNER, '--cwd', dir, '--timeout-ms', '30000', '--', process.execPath, '-e', childCode, String(value)],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    let out = ''
    child.stdout?.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.on('close', () => {
      const line = out.split('\n').filter((item) => item.trim().startsWith('{')).at(-1)
      let parsed = {}
      try { parsed = line === undefined ? {} : JSON.parse(line) } catch { parsed = {} }
      if (target !== null) CloseHandle(target)
      resolve({ text: `${parsed.stdout ?? ''}${parsed.stderr ?? ''}`.trim().slice(0, 160) })
    })
  })
}

let control
try {
  control = controlRun()
} catch (error) {
  control = { created: false, error: String(error).slice(0, 120) }
}
const sandbox = await sandboxRun()

rmSync(dir, { recursive: true, force: true })

const controlWrote = /WROTE/.test(control.text ?? '')
const sandboxDenied = /EBADF/.test(sandbox.text)
const sandboxWrote = /WROTE/.test(sandbox.text)

const verdict = sandboxWrote
  ? 'LEAKED'
  : controlWrote && sandboxDenied
    ? 'isolated-verified'
    : 'control-broken'

process.stdout.write(
  `${JSON.stringify({
    verdict,
    control: { created: control.created === true, wrote: controlWrote, text: (control.text ?? control.error ?? '').slice(0, 60) },
    sandbox: { denied: sandboxDenied, text: sandbox.text.slice(0, 60) },
  })}\n`,
)
process.exitCode = verdict === 'LEAKED' ? 1 : 0

/*
 * ## 这个探针**证明了什么**（写清楚，免得又被当成"已隔离"）
 *
 * `fs.writeSync(句柄号)` 用的是 libuv 自己的 fd 表，不是裸 HANDLE。
 * 所以即使句柄真的被继承了，子进程也会得到 EBADF —— 两侧同因。
 *
 * 也就是说：这条探针**无法**仅凭 EBADF 区分"没被继承"和"不是 libuv 的 fd"。
 * 要真验证，子进程必须用 `WriteFile` 直接写那个 HANDLE —— 而那需要在容器里
 * 加载原生模块，正是容器不许可的事（`realpath 'C:\'` 被拒）。
 *
 * 结论：这条断言在本沙箱里**结构上无法双向验证**。之前那句"isolated"只是
 * 单侧观察，不能当证据用。判定里因此把 `control-broken` 单列，不再冒充成功。
 */