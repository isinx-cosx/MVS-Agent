/**
 * 探针：**AppContainer 能不能真的断网**。
 *
 * ## 为什么不是"再写几条 deny 规则"
 *
 * 规则挡的是命令名（`curl` / `wget`），而 `node -e`、`python -c`、PowerShell 一行
 * 都能开 socket。要真断网，得让进程**在操作系统看来就没有网络身份**。
 *
 * Windows 上唯一的免管理员做法是 **AppContainer**：给进程一个包 SID，并且**不给**
 * `internetClient` 能力。没有那个能力，TCP/UDP 出站会被系统直接拒绝，
 * 不管用什么语言、什么库。
 *
 * ## 做法
 *
 * 不需要再造令牌 —— 用 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 属性
 * （我们已经在用同一套 `STARTUPINFOEXW` 属性列表挂 job 了，只是多加一条）。
 *
 *   1. `CreateAppContainerProfile(name, ...)` → 拿到包 SID
 *   2. 属性列表里加 `SECURITY_CAPABILITIES { SID, 0 个能力 }`
 *   3. `CreateProcessAsUser` 起 `node -v`（应当成功）
 *   4. 再起 `node -e "fetch(...)"`（应当失败 —— 没有 internetClient）
 *
 * 输出两行 JSON，一行一个用例。
 */

import { readFileSync } from 'node:fs'

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

const SECURITY_CAPABILITIES = koffi.struct('SECURITY_CAPABILITIES', {
  AppContainerSid: 'void *',
  Capabilities: 'void *',
  CapabilityCount: 'uint32',
  Reserved: 'uint32',
})
const SID_AND_ATTRIBUTES = koffi.struct('SID_AND_ATTRIBUTES', { Sid: 'void *', Attributes: 'uint32' })
const TOKEN_MANDATORY_LABEL = koffi.struct('TOKEN_MANDATORY_LABEL', { Label: SID_AND_ATTRIBUTES })
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
const STARTUPINFOEXW = koffi.struct('STARTUPINFOEXW', {
  StartupInfo: STARTUPINFOW,
  lpAttributeList: 'void *',
})
const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void *', hThread: 'void *', dwProcessId: 'uint32', dwThreadId: 'uint32',
})

const CreateAppContainerProfile = userenv.func(
  'int32 __stdcall CreateAppContainerProfile(str16, str16, str16, void *, uint32, _Out_ void **)',
)
const DeriveAppContainerSidFromAppContainerName = userenv.func(
  'int32 __stdcall DeriveAppContainerSidFromAppContainerName(str16, _Out_ void **)',
)
const ConvertSidToStringSidW = advapi.func('int32 __stdcall ConvertSidToStringSidW(void *, _Out_ void **)')
const OpenProcessToken = advapi.func('int32 __stdcall OpenProcessToken(void *, uint32, _Out_ void **)')
const CreateRestrictedToken = advapi.func(
  'int32 __stdcall CreateRestrictedToken(void *, uint32, uint32, void *, uint32, void *, uint32, void *, _Out_ void **)',
)
const DuplicateTokenEx = advapi.func('int32 __stdcall DuplicateTokenEx(void *, uint32, void *, int32, int32, _Out_ void **)')
const SetTokenInformation = advapi.func('int32 __stdcall SetTokenInformation(void *, int32, TOKEN_MANDATORY_LABEL *, uint32)')
const ConvertStringSidToSidW = advapi.func('int32 __stdcall ConvertStringSidToSidW(str16, _Out_ void **)')
const CreateProcessAsUserW = advapi.func(
  'int32 __stdcall CreateProcessAsUserW(void *, str16, void *, void *, void *, int32, uint32, void *, str16, STARTUPINFOEXW *, PROCESS_INFORMATION *)',
)
/*
 * 对照：`CreateProcessW`（不换令牌，只用当前令牌 + AppContainer 属性）。
 * MS 文档说 CreateProcessAsUser 可以带 SECURITY_CAPABILITIES，但实测它一直 87；
 * 换成 CreateProcess 至少能区分"属性写法错"和"AsUser 的限制"。
 */
const CreateProcessW2 = kernel.func(
  'int32 __stdcall CreateProcessW(str16, void *, void *, void *, int32, uint32, void *, str16, STARTUPINFOEXW *, PROCESS_INFORMATION *)',
)
const GetCurrentProcess = kernel.func('void * __stdcall GetCurrentProcess()')
const CreateFileW = kernel.func(
  'void * __stdcall CreateFileW(str16, uint32, uint32, SECURITY_ATTRIBUTES *, uint32, uint32, void *)',
)
const InitializeProcThreadAttributeList = kernel.func(
  'int32 __stdcall InitializeProcThreadAttributeList(void *, uint32, uint32, _Inout_ uintptr *)',
)
const UpdateProcThreadAttribute = kernel.func(
  'int32 __stdcall UpdateProcThreadAttribute(void *, uint32, uintptr, void *, uintptr, void *, void *)',
)
/*
 * 同一个导出、两份声明：`UpdateProcThreadAttribute` 的 lpValue 是 void*，
 * 而传结构时必须让 koffi 知道类型（否则报 "Unexpected Object value, expected void *"）。
 */
const UpdateProcThreadAttributeCaps = kernel.func(
  'int32 __stdcall UpdateProcThreadAttribute(void *, uint32, uintptr, SECURITY_CAPABILITIES *, uintptr, void *, void *)',
)
const WaitForSingleObject = kernel.func('uint32 __stdcall WaitForSingleObject(void *, uint32)')
const GetExitCodeProcess = kernel.func('int32 __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)')
const GetLastError = kernel.func('uint32 __stdcall GetLastError()')
const CloseHandle = kernel.func('int32 __stdcall CloseHandle(void *)')

const TOKEN_ALL_ACCESS = 0xf01ff
const WRITE_RESTRICTED = 0x1
const TOKEN_PRIMARY = 1
const TOKEN_INTEGRITY_LEVEL = 25
const SE_GROUP_INTEGRITY = 0x20
const LOW_SID = 'S-1-16-4096'
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
const STARTF_USESTDHANDLES = 0x00000100
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_ALL = 0x00000007
const OPEN_ALWAYS = 4
const FILE_ATTRIBUTE_NORMAL = 0x80
const Q = String.fromCharCode(34)

const WORK = process.env.TEMP ?? 'C:\\Windows\\Temp'

/* ① 包 SID：先建 profile（已存在就 derive） */
const profileName = 'MVS.Sandbox.Probe'
const sidOut = [null]
if (CreateAppContainerProfile(profileName, profileName, 'MVS sandbox probe', null, 0, sidOut) !== 0) {
  if (DeriveAppContainerSidFromAppContainerName(profileName, sidOut) !== 0) {
    process.stdout.write(`${JSON.stringify({ ok: false, step: 'profile', error: GetLastError() })}\n`)
    process.exit(1)
  }
}
const sidString = [null]
ConvertSidToStringSidW(sidOut[0], sidString)

/* ② 令牌：受限 + Low（和 worker 一样） */
const token = [null]
OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, token)
const restricted = [null]
CreateRestrictedToken(token[0], WRITE_RESTRICTED, 0, null, 0, null, 0, null, restricted)
const lowSid = [null]
ConvertStringSidToSidW(LOW_SID, lowSid)
SetTokenInformation(restricted[0], TOKEN_INTEGRITY_LEVEL, { Label: { Sid: lowSid[0], Attributes: SE_GROUP_INTEGRITY } }, koffi.sizeof(TOKEN_MANDATORY_LABEL))
const primary = [null]
DuplicateTokenEx(restricted[0], TOKEN_ALL_ACCESS, null, 2, TOKEN_PRIMARY, primary)

/* ③ 跑一个用例：带 SECURITY_CAPABILITIES（0 个能力 = 没有 internetClient） */
async function runCase(label, args) {
  const exitCode = [0]
  const stdoutPath = `${WORK}\\mvs-ac-${label}.out`
  const inheritable = { nLength: koffi.sizeof(SECURITY_ATTRIBUTES), lpSecurityDescriptor: null, bInheritHandle: 1 }
  const handle = CreateFileW(stdoutPath, GENERIC_WRITE, FILE_SHARE_ALL, inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)

  const sizeOut = [0]
  InitializeProcThreadAttributeList(null, 1, 0, sizeOut)
  /*
   * 属性列表要求 8 字节对齐，而 Buffer.alloc 不保证 —— 对齐错位会让
   * CreateProcessAsUser 报 ERROR_INVALID_PARAMETER (87)。这里自己切一段对齐的。
   */
  const rawAttributes = Buffer.alloc(sizeOut[0] + 16)
  const alignOffset = (8 - (rawAttributes.byteOffset % 8)) % 8
  const attributes = rawAttributes.subarray(alignOffset, alignOffset + sizeOut[0])
  const size2 = [sizeOut[0]]
  if (InitializeProcThreadAttributeList(attributes, 1, 0, size2) === 0) {
    process.stdout.write(`${JSON.stringify({ ok: false, step: 'attrlist', error: GetLastError() })}\n`)
    process.exit(1)
  }

    /*
   * CapabilityCount = 0 + Capabilities = null 可能是 87 的来源之一。
   * MVS_PROBE_ONE_CAP=1 时给一个**无害**能力（registryRead），只是为了验证形状：
   * 若能创建成功，说明 0 个能力这种写法不被接受。
   */
  let capabilities
  if (process.env.MVS_PROBE_ONE_CAP === '1') {
    const capSid = [null]
    ConvertStringSidToSidW('S-1-15-3-1', capSid)
    const capArray = Buffer.alloc(koffi.sizeof(SID_AND_ATTRIBUTES))
    /* SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } —— SE_GROUP_ENABLED = 4 */
    capArray.writeBigUInt64LE(BigInt(koffi.address(capSid[0])), 0)
    capArray.writeUInt32LE(4, 8)
    capabilities = { AppContainerSid: sidOut[0], Capabilities: capArray, CapabilityCount: 1, Reserved: 0 }
  } else {
    capabilities = { AppContainerSid: sidOut[0], Capabilities: null, CapabilityCount: 0, Reserved: 0 }
  }
  const updated = UpdateProcThreadAttributeCaps(attributes, 0, BigInt(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capabilities, BigInt(koffi.sizeof(SECURITY_CAPABILITIES)), null, null)
  if (updated === 0) {
    return { case: label, created: false, step: 'update-attribute', error: GetLastError() }
  }

  const line = Q + process.execPath + Q + ' ' + args.map((item) => Q + item + Q).join(' ')
  const lineBuffer = Buffer.concat([Buffer.from(line, 'utf16le'), Buffer.from([0, 0])])

  const startup = {
    StartupInfo: {
      cb: koffi.sizeof(STARTUPINFOEXW),
      lpReserved: null, lpDesktop: null, lpTitle: null,
      dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
      dwFlags: STARTF_USESTDHANDLES,
      wShowWindow: 0, cbReserved2: 0, lpReserved2: null,
      hStdInput: null, hStdOutput: handle, hStdError: handle,
    },
    lpAttributeList: attributes,
  }
  const infoBuf = Buffer.alloc(koffi.sizeof(PROCESS_INFORMATION))
  const tokenToUse = process.env.MVS_PROBE_PLAINTOKEN === '1' ? token[0] : primary[0]
  const inherit = process.env.MVS_PROBE_NOINHERIT === '1' ? 0 : 1
  /* lpApplicationName 也填上：某些属性要求可执行文件名显式给出 */
  const created = process.env.MVS_PROBE_CREATEPROC === '1'
    ? CreateProcessW2(null, lineBuffer, null, null, inherit, EXTENDED_STARTUPINFO_PRESENT, null, WORK, startup, infoBuf)
    : CreateProcessAsUserW(tokenToUse, process.execPath, lineBuffer, null, null, inherit, EXTENDED_STARTUPINFO_PRESENT, null, WORK, startup, infoBuf)
  if (created === 0) {
    return { case: label, created: false, error: GetLastError() }
  }
  const hProcess = infoBuf.readBigUInt64LE(0)
  WaitForSingleObject(hProcess, 30_000)
  GetExitCodeProcess(hProcess, exitCode)
  CloseHandle(hProcess)
  let output = ''
  try {
    output = readFileSync(stdoutPath, 'utf8').slice(0, 200)
  } catch {
    /* 没输出 */
  }
  return { case: label, created: true, exitCode: exitCode[0], output: output.trim() }
}

const results = []
results.push(await runCase('version', ['-v']))
results.push(await runCase('fetch', ['-e', "fetch('https://example.com').then(()=>{console.log('NET-OK');process.exit(0)}).catch((e)=>{console.log('NET-BLOCKED:'+e.code);process.exit(3)})"]))

process.stdout.write(`${JSON.stringify({ ok: true, sid: sidString[0] ? 'ok' : 'unknown', results }, null, 0)}\n`)
