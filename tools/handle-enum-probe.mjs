/**
 * S9：句柄继承的**双向**验证 —— 直接在父进程侧枚举子进程的句柄表。
 *
 * ## 为什么之前失败
 *
 * 子进程用 `fs.writeSync(句柄号)` 测，走的是 libuv 的 fd 表，不是裸 HANDLE，
 * 所以继承与否都返回 EBADF —— 那不是证据。要在容器里用 `WriteFile` 写裸 HANDLE，
 * 又得加载原生模块，而容器不许。
 *
 * ## 现在的做法
 *
 * **父进程**调 `NtQuerySystemInformation(SystemExtendedHandleInformation)`
 * 拿到全系统句柄表，筛出子进程 PID 的那些条目，看目标句柄值在不在里面。
 * 父进程不受容器限制，所以这条路对两个用例都成立：
 *
 *   · 对照：自己用 `CreateProcessW(bInheritHandles = TRUE)` 启动 → **应当在表里**
 *   · 沙箱：同一个可继承句柄交给 `sandbox-net-run.mjs` → **应当不在表里**
 *
 *     node tools/handle-enum-probe.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const dir = mkdtempSync(path.join(tmpdir(), 'mvs-enum-'))
const kernel = koffi.load('kernel32.dll')
const ntdll = koffi.load('ntdll.dll')

const CreateFileW = kernel.func('void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)')
const CloseHandle = kernel.func('int32 __stdcall CloseHandle(void *)')
const NtQuerySystemInformation = ntdll.func(
  'int32 __stdcall NtQuerySystemInformation(uint32, void *, uint32, _Out_ uint32 *)',
)

const SYSTEM_EXTENDED_HANDLE_INFORMATION = 64
const ENTRY_SIZE = 40

/** 开一个可继承句柄（SECURITY_ATTRIBUTES 手工布局，JS 对象会因对齐失真） */
function openInheritable(file) {
  const sa = Buffer.alloc(24)
  sa.writeUInt32LE(24, 0)
  sa.writeUInt32LE(1, 16)
  const handle = CreateFileW(file, 0x40000000, 7, sa, 2, 0x80, null)
  return { handle, value: handle === null ? undefined : Number(koffi.address(handle)) }
}

/** 枚举某个进程的全部句柄值 */
function handlesOf(pid) {
  /* 16 MB 起步：实测这台机器 163k 个句柄，8 MB 还不够 */
  let length = 1 << 24
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const buffer = Buffer.alloc(length)
    const returned = Buffer.alloc(4)
    const status = NtQuerySystemInformation(SYSTEM_EXTENDED_HANDLE_INFORMATION, buffer, length, returned)
    /* NtQuerySystemInformation 返回的是 NTSTATUS，koffi 给的是**有符号** int32 */
    if ((status >>> 0) === 0xc0000004) {
      length *= 2
      continue
    }
    if (status !== 0) return { ok: false, status }
    const count = Number(buffer.readBigUInt64LE(0))
    const values = []
    for (let index = 0; index < count && index < 400000; index += 1) {
      const base = 16 + index * ENTRY_SIZE
      if (base + ENTRY_SIZE > buffer.length) break
      const ownerPid = Number(buffer.readBigUInt64LE(base + 8))
      if (ownerPid !== pid) continue
      values.push(Number(buffer.readBigUInt64LE(base + 16)))
    }
    return { ok: true, count, values }
  }
  return { ok: false, status: 'buffer-too-small' }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* 子进程：把 pid 写进文件，然后睡一会儿，好让父进程枚举 */
const childCode = [
  "const fs = require('fs')",
  'const [, pidFile] = process.argv',
  'fs.writeFileSync(pidFile, String(process.pid))',
  'setTimeout(() => {}, 15000)',
].join('\n')

async function waitForPid(pidFile, timeoutMs = 15_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (existsSync(pidFile)) {
      const value = Number(readFileSync(pidFile, 'utf8'))
      if (Number.isFinite(value) && value > 0) return value
    }
    await sleep(100)
  }
  return undefined
}

/* ① 对照：自己 CreateProcessW，bInheritHandles = TRUE */
async function controlCase() {
  const pidFile = path.join(dir, 'control.pid')
  const { handle, value } = openInheritable(path.join(dir, 'control.bin'))
  if (handle === null) return { ok: false, error: 'CreateFileW 失败' }

  const line = [process.execPath, '-e', childCode, pidFile].map((item) => `"${item}"`).join(' ')
  const lineBuffer = Buffer.concat([Buffer.from(line, 'utf16le'), Buffer.from([0, 0])])
  const STARTUP = koffi.struct('ENUM_STARTUPINFO', {
    cb: 'uint32', lpReserved: 'str16', lpDesktop: 'str16', lpTitle: 'str16',
    dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
    dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32',
    dwFlags: 'uint32', wShowWindow: 'uint16', cbReserved2: 'uint16', lpReserved2: 'void *',
    hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
  })
  const PROCINFO = koffi.struct('ENUM_PROCESS_INFORMATION', {
    hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32',
  })
  const CreateProcessW = kernel.func(
    'int32 __stdcall CreateProcessW(str16, str16, void *, void *, int32, uint32, void *, str16, ENUM_STARTUPINFO *, ENUM_PROCESS_INFORMATION *)',
  )
  const info = Buffer.alloc(koffi.sizeof(PROCINFO))
  const startup = { cb: koffi.sizeof(STARTUP) }
  const created = CreateProcessW(null, lineBuffer, null, null, 1, 0, null, null, startup, info)
  if (created === 0) return { ok: false, error: 'CreateProcessW 失败' }

  const pid = (await waitForPid(pidFile)) ?? koffi.decode(info, 'ENUM_PROCESS_INFORMATION').dwProcessId
  await sleep(300)
  const table = handlesOf(pid)
  const decoded = koffi.decode(info, 'ENUM_PROCESS_INFORMATION')
  if (decoded.hProcess !== null) CloseHandle(decoded.hProcess)
  CloseHandle(handle)
  try {
    process.kill(pid)
  } catch {
    /* 已经退出 */
  }
  return { ok: true, pid, handleValue: value, table }
}

/* ② 沙箱：同一个可继承句柄交给 runner */
async function sandboxCase() {
  const pidFile = path.join(dir, 'sandbox.pid')
  const { handle, value } = openInheritable(path.join(dir, 'sandbox.bin'))
  if (handle === null) return { ok: false, error: 'CreateFileW 失败' }

  const child = spawn(
    process.execPath,
    [RUNNER, '--cwd', dir, '--timeout-ms', '30000', '--', process.execPath, '-e', childCode, pidFile],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )
  const done = new Promise((resolve) => child.on('close', resolve))
  const pid = await waitForPid(pidFile)
  let table
  if (pid !== undefined) {
    await sleep(300)
    table = handlesOf(pid)
  }
  try {
    if (pid !== undefined) process.kill(pid)
  } catch {
    /* 已退出 */
  }
  CloseHandle(handle)
  await Promise.race([done, sleep(5000)])
  return { ok: uidOk(pid), pid, handleValue: value, table }
}

function uidOk(pid) {
  return pid !== undefined
}

const control = await controlCase()
const sandbox = await sandboxCase()
rmSync(dir, { recursive: true, force: true })

const inControl = control.table?.ok === true && control.table.values.includes(control.handleValue)
const inSandbox = sandbox.table?.ok === true && sandbox.table.values.includes(sandbox.handleValue)

const verdict =
  inControl && !inSandbox ? 'isolated-verified' : !inControl ? 'control-broken' : inSandbox ? 'LEAKED' : 'inconclusive'

process.stdout.write(
  `${JSON.stringify({
    verdict,
    control: { pid: control.pid, handle: control.handleValue, enumerated: control.table?.ok, present: inControl },
    sandbox: { pid: sandbox.pid, handle: sandbox.handleValue, enumerated: sandbox.table?.ok, present: inSandbox },
  })}\n`,
)
process.exitCode = verdict === 'isolated-verified' ? 0 : 1
