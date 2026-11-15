/**
 * 断网执行器：**AppContainer + 无网络能力**，一条命令一次。
 *
 * ## 为什么不直接改 `sandbox-run.mjs`
 *
 * 那个文件已经把「受限令牌 + Low + Job 上限」跑通了（进程数/内存/CPU/写字节都实测过）。
 * 把 AppContainer 属性加进同一个属性列表里会让 node 崩在 `InitializeOncePerProcess`
 * （exit 134，实测多次）。而 `tools/ac-net3.mjs` 用另一种形态 —— **普通令牌 +
 * `CreateProcessW` + 只有 AppContainer 一条属性** —— 是好的，网络被 DNS 级拒绝。
 *
 * 两者不是同一件事：
 *
 *   `sandbox-run.mjs`      Job 上限齐全，但**能联网**
 *   `sandbox-net-run.mjs`  **断网**（AppContainer），但不挂 Job
 *
 * 所以这里刻意保持和 ac-net3 完全相同的调用形态：普通令牌、`CreateProcessW`、
 * 单条属性、不挂起。任何"顺手加一个 job"的改动都会把它打回 134 —— 要加就在
 * 一个新的分支里加，并重新验证。
 *
 * ## 用法
 *
 *     node tools/sandbox-net-run.mjs --cwd <dir> -- <exe> [args...]
 *     MVS_SANDBOX_NET=1 node tools/sandbox-net-run.mjs -- <exe> [args...]   # 放行网络对照
 *
 * 输出一行 JSON：`{ ok, exitCode, stdout, stderr, network }`
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
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
      const loaded = await import(candidate)
      const koffi = loaded.default ?? loaded
      if (typeof koffi?.load === 'function') return koffi
    } catch {
      /* 下一个 */
    }
  }
  return null
}

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
}
const separator = argv.indexOf('--')
const command = separator >= 0 ? argv[separator + 1] : undefined
const commandArgs = separator >= 0 ? argv.slice(separator + 2) : []
const cwd = argOf('--cwd', null)

const koffi = await loadKoffi()
if (koffi === null) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'koffi 不可用' })}\n`)
  process.exit(1)
}
if (command === undefined) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: '需要 -- <exe> [args...]' })}\n`)
  process.exit(2)
}

const advapi = koffi.load('advapi32.dll')
const kernel = koffi.load('kernel32.dll')
const userenv = koffi.load('userenv.dll')

const SECURITY_ATTRIBUTES = koffi.struct('SECURITY_ATTRIBUTES', {
  nLength: 'uint32',
  lpSecurityDescriptor: 'void *',
  bInheritHandle: 'int32',
})
const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32', lpReserved: 'void *', lpDesktop: 'void *', lpTitle: 'void *',
  dwX: 'uint32', dwY: 'uint32', dwXSize: 'uint32', dwYSize: 'uint32',
  dwXCountChars: 'uint32', dwYCountChars: 'uint32', dwFillAttribute: 'uint32', dwFlags: 'uint32',
  wShowWindow: 'uint16', cbReserved2: 'uint16', lpReserved2: 'void *',
  hStdInput: 'void *', hStdOutput: 'void *', hStdError: 'void *',
})
const STARTUPINFOEXW = koffi.struct('STARTUPINFOEXW', { StartupInfo: STARTUPINFOW, lpAttributeList: 'void *' })
const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32',
})

const CreateAppContainerProfile = userenv.func(
  'int32 __stdcall CreateAppContainerProfile(str16, str16, str16, void *, uint32, _Out_ void **)',
)
const DeriveAppContainerSidFromAppContainerName = userenv.func(
  'int32 __stdcall DeriveAppContainerSidFromAppContainerName(str16, _Out_ void **)',
)
const CreateProcessW = kernel.func(
  'int32 __stdcall CreateProcessW(str16, void *, void *, void *, int32, uint32, void *, str16, STARTUPINFOEXW *, PROCESS_INFORMATION *)',
)
const InitializeProcThreadAttributeList = kernel.func(
  'int32 __stdcall InitializeProcThreadAttributeList(void *, uint32, uint32, _Inout_ uintptr *)',
)
const UpdateProcThreadAttribute = kernel.func(
  'int32 __stdcall UpdateProcThreadAttribute(void *, uint32, uintptr, void *, uintptr, void *, void *)',
)
const CreateFileW = kernel.func(
  'void * __stdcall CreateFileW(str16, uint32, uint32, SECURITY_ATTRIBUTES *, uint32, uint32, void *)',
)
const GetLastError = kernel.func('uint32 __stdcall GetLastError()')
const WaitForSingleObject = kernel.func('uint32 __stdcall WaitForSingleObject(void *, uint32)')
const GetExitCodeProcess = kernel.func('int32 __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)')
const CloseHandle = kernel.func('int32 __stdcall CloseHandle(void *)')

const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
const CREATE_NO_WINDOW = 0x08000000
const STARTF_USESTDHANDLES = 0x00000100
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_ALL = 0x00000007
const OPEN_ALWAYS = 4
const FILE_ATTRIBUTE_NORMAL = 0x80
const Q = String.fromCharCode(34)

const dir = mkdtempSync(path.join(tmpdir(), 'mvs-netrun-'))
const outPath = path.join(dir, 'stdout.txt')
const errPath = path.join(dir, 'stderr.txt')

const profileName = 'MVS.Agent.Sandbox'
const sidOut = [null]
CreateAppContainerProfile(profileName, profileName, 'MVS sandbox', null, 0, sidOut)
/* profile 已存在时返回 183 且不写 SID —— 必须补一次 derive */
if (sidOut[0] === null) DeriveAppContainerSidFromAppContainerName(profileName, sidOut)

const inheritable = {
  nLength: koffi.sizeof(SECURITY_ATTRIBUTES),
  lpSecurityDescriptor: null,
  bInheritHandle: 1,
}
const outHandle = CreateFileW(outPath, GENERIC_WRITE, FILE_SHARE_ALL, inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)
const errHandle = CreateFileW(errPath, GENERIC_WRITE, FILE_SHARE_ALL, inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)

const withAppContainer = process.env['MVS_SANDBOX_NET'] !== '1'
let attributes = null
if (withAppContainer) {
  const sizeOut = [0]
  InitializeProcThreadAttributeList(null, 1, 0, sizeOut)
  /* 属性列表要求 8 字节对齐，Buffer.alloc 不保证 —— 自己切一段对齐的 */
  const raw = Buffer.alloc(sizeOut[0] + 16)
  const align = (8 - (raw.byteOffset % 8)) % 8
  attributes = raw.subarray(align, align + sizeOut[0])
  if (InitializeProcThreadAttributeList(attributes, 1, 0, [sizeOut[0]]) === 0) {
    process.stdout.write(`${JSON.stringify({ ok: false, step: 'attrlist', error: GetLastError() })}\n`)
    process.exit(1)
  }
  /* SECURITY_CAPABILITIES 手工布局：传 JS 对象会让 Windows 读到坏指针 */
  const capsBuf = Buffer.alloc(24)
  if (sidOut[0] !== null) capsBuf.writeBigUInt64LE(BigInt(koffi.address(sidOut[0])), 0)
  capsBuf.writeBigUInt64LE(0n, 8)
  capsBuf.writeUInt32LE(0, 16)
  capsBuf.writeUInt32LE(0, 20)
  if (
    UpdateProcThreadAttribute(attributes, 0, BigInt(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capsBuf, BigInt(24), null, null) === 0
  ) {
    process.stdout.write(`${JSON.stringify({ ok: false, step: 'attribute', error: GetLastError() })}\n`)
    process.exit(1)
  }
}

const line = [command, ...commandArgs].map((item) => Q + item + Q).join(' ')
const lineBuffer = Buffer.concat([Buffer.from(line, 'utf16le'), Buffer.from([0, 0])])

const startup = {
  StartupInfo: {
    cb: koffi.sizeof(STARTUPINFOEXW),
    lpReserved: null, lpDesktop: null, lpTitle: null,
    dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
    dwFlags: STARTF_USESTDHANDLES,
    wShowWindow: 0, cbReserved2: 0, lpReserved2: null,
    hStdInput: null, hStdOutput: outHandle, hStdError: errHandle,
  },
  lpAttributeList: attributes,
}

const infoBuf = Buffer.alloc(koffi.sizeof(PROCESS_INFORMATION))
const created = CreateProcessW(
  null,
  lineBuffer,
  null,
  null,
  1,
  EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
  null,
  cwd,
  startup,
  infoBuf,
)

const report = { ok: created !== 0, network: withAppContainer ? 'blocked' : 'allowed', sid: sidOut[0] !== null }
if (created === 0) {
  report.error = GetLastError()
} else {
  const hProcess = infoBuf.readBigUInt64LE(0)
  WaitForSingleObject(hProcess, Number(argOf('--timeout-ms', '120000')))
  const exitCode = [0]
  GetExitCodeProcess(hProcess, exitCode)
  CloseHandle(hProcess)
  report.exitCode = exitCode[0]
  report.stdout = existsSync(outPath) ? readFileSync(outPath, 'utf8').slice(0, 2000) : ''
  report.stderr = existsSync(errPath) ? readFileSync(errPath, 'utf8').slice(0, 2000) : ''
}

process.stdout.write(`${JSON.stringify(report)}\n`)
rmSync(dir, { recursive: true, force: true })
