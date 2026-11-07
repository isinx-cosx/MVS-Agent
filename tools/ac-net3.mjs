/**
 * AppContainer 断网验证（第三版）：**不读脚本文件**，代码用 `node -e` 传进去。
 *
 * 前两版的教训：
 *   1. 容器写不了临时目录 → 结果走**继承句柄**（已解决）
 *   2. 容器读不到脚本文件 → 这一版干脆不要脚本文件：`node -e "<代码>"`，
 *      代码里只用单引号，命令行就不会有嵌套引号问题
 *
 * 于是只剩一个变量：**网络**。
 *
 *     node tools/ac-net3.mjs                  # 带 AppContainer（预期 NET-BLOCKED）
 *     MVS_AC_OFF=1 node tools/ac-net3.mjs     # 对照（预期 NET-OK 200）
 */

import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
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

const koffi = await loadKoffi()
if (koffi === null) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: 'koffi 不可用' })}\n`)
  process.exit(1)
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
const NL = String.fromCharCode(10)
const SQ = String.fromCharCode(39)

const withAppContainer = process.env.MVS_AC_OFF !== '1'
const dir = mkdtempSync(path.join(tmpdir(), 'mvs-ac3-'))
const outPath = path.join(dir, 'stdout.txt')

/* 代码里只用单引号 —— 命令行里就不会出现嵌套双引号 */
const code = [
  'try {',
  '  const r = await fetch(' + SQ + 'https://example.com' + SQ + ', { signal: AbortSignal.timeout(5000) })',
  '  console.log(' + SQ + 'NET-OK ' + SQ + ' + r.status)',
  '} catch (e) {',
  '  console.log(' + SQ + 'NET-BLOCKED ' + SQ + ' + (e.cause?.code ?? e.code ?? e.name))',
  '}',
].join(NL)

const sidOut = [null]
CreateAppContainerProfile('MVS.Sandbox.Net3', 'MVS.Sandbox.Net3', 'probe', null, 0, sidOut)
if (sidOut[0] === null) DeriveAppContainerSidFromAppContainerName('MVS.Sandbox.Net3', sidOut)

const inheritable = {
  nLength: koffi.sizeof(SECURITY_ATTRIBUTES),
  lpSecurityDescriptor: null,
  bInheritHandle: 1,
}
const outHandle = CreateFileW(outPath, GENERIC_WRITE, FILE_SHARE_ALL, inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)

let attributes = null
let attributeUpdated = false
if (withAppContainer) {
  const sizeOut = [0]
  InitializeProcThreadAttributeList(null, 1, 0, sizeOut)
  const raw = Buffer.alloc(sizeOut[0] + 16)
  const align = (8 - (raw.byteOffset % 8)) % 8
  const list = raw.subarray(align, align + sizeOut[0])
  InitializeProcThreadAttributeList(list, 1, 0, [sizeOut[0]])
  const capsBuf = Buffer.alloc(24)
  if (sidOut[0] !== null) capsBuf.writeBigUInt64LE(BigInt(koffi.address(sidOut[0])), 0)
  capsBuf.writeBigUInt64LE(0n, 8)
  capsBuf.writeUInt32LE(0, 16)
  capsBuf.writeUInt32LE(0, 20)
  attributeUpdated =
    UpdateProcThreadAttribute(list, 0, BigInt(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capsBuf, BigInt(24), null, null) !== 0
  attributes = list
}

const line = `${Q}${process.execPath}${Q} ${Q}-e${Q} ${Q}${code}${Q}`
const lineBuffer = Buffer.concat([Buffer.from(line, 'utf16le'), Buffer.from([0, 0])])

const startup = {
  StartupInfo: {
    cb: koffi.sizeof(STARTUPINFOEXW),
    lpReserved: null, lpDesktop: null, lpTitle: null,
    dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
    dwFlags: STARTF_USESTDHANDLES,
    wShowWindow: 0, cbReserved2: 0, lpReserved2: null,
    hStdInput: null, hStdOutput: outHandle, hStdError: outHandle,
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
  null,
  startup,
  infoBuf,
)

const report = {
  ok: created !== 0,
  appContainer: withAppContainer,
  sid: sidOut[0] !== null,
  attributeUpdated,
  ...(created === 0 ? { error: GetLastError(), line: line.slice(0, 160) } : {}),
}

if (created !== 0) {
  const hProcess = infoBuf.readBigUInt64LE(0)
  WaitForSingleObject(hProcess, 30_000)
  const exitCode = [0]
  GetExitCodeProcess(hProcess, exitCode)
  CloseHandle(hProcess)
  report.exitCode = exitCode[0]
  report.output = existsSync(outPath) ? readFileSync(outPath, 'utf8').trim().slice(0, 300) : '(empty)'
}

process.stdout.write(`${JSON.stringify(report)}${NL}`)
