/**
 * 沙箱启动矩阵：命令到底在哪一档能执行。
 *
 * ## 为什么要这个文件
 *
 * worker 里 `spawn: ok` 只说明 `CreateProcessAsUser` 返回了真值，**不说明进程跑起来了**。
 * 上一轮加了 300ms 存活检查才发现：子进程一出生就退，`exitCode` 是 0，什么都没执行。
 * 而 `--token=none`（当前进程令牌）也一样 —— 所以问题不在受限令牌。
 *
 * 这个矩阵把嫌疑拆成两档，每档都用**同一条命令**（写一个标记文件）：
 *
 *   A. 普通 `STARTUPINFOW`，不传 job（事后再 Assign）
 *   B. `STARTUPINFOEXW` + `ProcThreadAttributeJobList`（worker 现在的写法）
 *
 * 每档打印：创建的 pid、是否有 GetLastError、500ms 后是否还活着、标记文件是否出现。
 *
 * ## 实测结果（2026-02）
 *
 *     A: create=ok pid=0 assign=failed(6) aliveAfter500ms=false exitCode=0 marker=false
 *     B: create=ok pid=0                          aliveAfter500ms=false exitCode=0 marker=false
 *
 * **两档的 pid 都是 0，`hProcess` 是 NULL**（A 档 `AssignProcessToJobObject` 报
 * ERROR_INVALID_HANDLE=6 就是证明）。也就是说：**进程从来没有被创建** ——
 * 之前 worker 里那句 `spawn: ok` 是假的，它只看了 `CreateProcessAsUserW` 的返回值。
 *
 * 所以现在的结论变成：卡点不在令牌、不在低完整性、不在属性列表，而在
 * **`CreateProcessAsUserW` 这次调用本身没成功**（返回值可疑 + 输出参数全空）。
 * 下一个要看的是：返回值原始值、`GetLastError()`、以及 `PROCESS_INFORMATION`
 * 的输出参数是不是被 koffi 正确回写（用 `_Out_` 还是结构指针）。
 *
 * 用法（写成文件是为了不踩 PowerShell 吃引号那个坑，见 AGENT.md §六.1）：
 *
 *     node tools/sandbox-spawn-matrix.mjs
 *     node tools/sandbox-spawn-matrix.mjs --token none
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
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
      /* 试下一个 */
    }
  }
  return null
}

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(name)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback
}
const tokenMode = argOf('--token', 'none')

const koffi = await loadKoffi()
if (koffi === null) {
  console.log(JSON.stringify({ error: 'koffi 不可用' }))
  process.exit(1)
}

const advapi = koffi.load('advapi32.dll')
const kernel = koffi.load('kernel32.dll')

const SECURITY_ATTRIBUTES = koffi.struct('SECURITY_ATTRIBUTES', {
  nLength: 'uint32',
  lpSecurityDescriptor: 'void *',
  bInheritHandle: 'int32',
})
const SID_AND_ATTRIBUTES = koffi.struct('SID_AND_ATTRIBUTES', { Sid: 'void *', Attributes: 'uint32' })
const TOKEN_MANDATORY_LABEL = koffi.struct('TOKEN_MANDATORY_LABEL', { Label: SID_AND_ATTRIBUTES })
const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: 'uint32',
  lpReserved: 'void *',
  lpDesktop: 'void *',
  lpTitle: 'void *',
  dwX: 'uint32',
  dwY: 'uint32',
  dwXSize: 'uint32',
  dwYSize: 'uint32',
  dwXCountChars: 'uint32',
  dwYCountChars: 'uint32',
  dwFillAttribute: 'uint32',
  dwFlags: 'uint32',
  wShowWindow: 'uint16',
  cbReserved2: 'uint16',
  lpReserved2: 'void *',
  hStdInput: 'void *',
  hStdOutput: 'void *',
  hStdError: 'void *',
})
const STARTUPINFOEXW = koffi.struct('STARTUPINFOEXW', {
  StartupInfo: STARTUPINFOW,
  lpAttributeList: 'void *',
})
const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: 'void *',
  hThread: 'void *',
  dwProcessId: 'uint32',
  dwThreadId: 'uint32',
})

const OpenProcessToken = advapi.func('int32 __stdcall OpenProcessToken(void *, uint32, _Out_ void **)')
const CreateRestrictedToken = advapi.func(
  'int32 __stdcall CreateRestrictedToken(void *, uint32, uint32, void *, uint32, void *, uint32, void *, _Out_ void **)',
)
const DuplicateTokenEx = advapi.func('int32 __stdcall DuplicateTokenEx(void *, uint32, void *, int32, int32, _Out_ void **)')
const SetTokenInformation = advapi.func(
  'int32 __stdcall SetTokenInformation(void *, int32, TOKEN_MANDATORY_LABEL *, uint32)',
)
const ConvertStringSidToSidW = advapi.func('int32 __stdcall ConvertStringSidToSidW(str16, _Out_ void **)')
const CreateProcessAsUserW = advapi.func(
  'int32 __stdcall CreateProcessAsUserW(void *, str16, void *, void *, void *, int32, uint32, void *, str16, STARTUPINFOEXW *, PROCESS_INFORMATION *)',
)
const GetCurrentProcess = kernel.func('void * __stdcall GetCurrentProcess()')
const CreateJobObjectW = kernel.func('void * __stdcall CreateJobObjectW(void *, str16)')
const AssignProcessToJobObject = kernel.func('int32 __stdcall AssignProcessToJobObject(void *, void *)')
const ResumeThread = kernel.func('uint32 __stdcall ResumeThread(void *)')
const WaitForSingleObject = kernel.func('uint32 __stdcall WaitForSingleObject(void *, uint32)')
const GetExitCodeProcess = kernel.func('int32 __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)')
const CloseHandle = kernel.func('int32 __stdcall CloseHandle(void *)')
const CreateFileW = kernel.func(
  'void * __stdcall CreateFileW(str16, uint32, uint32, SECURITY_ATTRIBUTES *, uint32, uint32, void *)',
)
const GetLastError = kernel.func('uint32 __stdcall GetLastError()')
const InitializeProcThreadAttributeList = kernel.func(
  'int32 __stdcall InitializeProcThreadAttributeList(void *, uint32, uint32, _Inout_ uintptr *)',
)
const UpdateProcThreadAttribute = kernel.func(
  'int32 __stdcall UpdateProcThreadAttribute(void *, uint32, uintptr, void *, uintptr, void *, void *)',
)

const TOKEN_ALL_ACCESS = 0xf01ff
const WRITE_RESTRICTED = 0x1
const TOKEN_PRIMARY = 1
const TOKEN_INTEGRITY_LEVEL = 25
const SE_GROUP_INTEGRITY = 0x20
const LOW_SID = 'S-1-16-4096'
const CREATE_SUSPENDED = 0x00000004
const STARTF_USESTDHANDLES = 0x00000100
const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000d
const WAIT_TIMEOUT = 0x102
const GENERIC_WRITE = 0x40000000
const FILE_SHARE_ALL = 0x00000007
const OPEN_ALWAYS = 4
const FILE_ATTRIBUTE_NORMAL = 0x80

const Q = String.fromCharCode(34)

/** 造令牌：none 用当前进程的，restricted-low 走完整五步 */
function buildToken() {
  const token = [null]
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, token) === 0) {
    throw new Error('OpenProcessToken 失败')
  }
  if (tokenMode === 'none') return token[0]

  const restricted = [null]
  if (CreateRestrictedToken(token[0], WRITE_RESTRICTED, 0, null, 0, null, 0, null, restricted) === 0) {
    throw new Error('CreateRestrictedToken 失败')
  }
  const sid = [null]
  if (ConvertStringSidToSidW(LOW_SID, sid) === 0) throw new Error('ConvertStringSidToSidW 失败')
  if (
    SetTokenInformation(
      restricted[0],
      TOKEN_INTEGRITY_LEVEL,
      { Label: { Sid: sid[0], Attributes: SE_GROUP_INTEGRITY } },
      koffi.sizeof(TOKEN_MANDATORY_LABEL),
    ) === 0
  ) {
    throw new Error('SetTokenInformation 失败')
  }
  const primary = [null]
  if (DuplicateTokenEx(restricted[0], TOKEN_ALL_ACCESS, null, 2, TOKEN_PRIMARY, primary) === 0) {
    throw new Error('DuplicateTokenEx 失败')
  }
  return primary[0]
}

/** 跑一档：buildStartup 决定用哪种 STARTUPINFO，attachedJob 决定是不是创建时就挂 job */
function arm(label, { extended, startInJob }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mvs-matrix-'))
  const marker = path.join(dir, 'marker.txt')
  const result = { arm: label, token: tokenMode }

  try {
    const primaryToken = buildToken()
    result.token = 'ok'

    const job = startInJob ? CreateJobObjectW(null, null) : null
    if (startInJob && !job) throw new Error('CreateJobObjectW 失败')

    /* 输出句柄：可继承 */
    const inheritable = {
      nLength: koffi.sizeof(SECURITY_ATTRIBUTES),
      lpSecurityDescriptor: null,
      bInheritHandle: 1,
    }
    const outHandle = CreateFileW(
      path.join(dir, 'stdout.txt'),
      GENERIC_WRITE,
      FILE_SHARE_ALL,
      inheritable,
      OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      null,
    )

    const argList = [process.env.ComSpec ?? 'cmd.exe', '/c', `echo MARK > ${Q}${marker}${Q}`]
    const line = argList.map((item) => Q + item + Q).join(' ')
    const lineBuffer = Buffer.concat([Buffer.from(line, 'utf16le'), Buffer.from([0, 0])])

    const baseInfo = {
      cb: koffi.sizeof(extended ? STARTUPINFOEXW : STARTUPINFOW),
      lpReserved: null,
      lpDesktop: null,
      lpTitle: null,
      dwX: 0,
      dwY: 0,
      dwXSize: 0,
      dwYSize: 0,
      dwXCountChars: 0,
      dwYCountChars: 0,
      dwFillAttribute: 0,
      dwFlags: STARTF_USESTDHANDLES,
      wShowWindow: 0,
      cbReserved2: 0,
      lpReserved2: null,
      hStdInput: null,
      hStdOutput: outHandle,
      hStdError: outHandle,
    }

    /*
     * 两档都用 STARTUPINFOEXW 这个类型（`CreateProcessAsUserW` 的签名只能有一种），
     * 差别在 **cb 与 EXTENDED 标志**：
     *   · A 档：cb = sizeof(STARTUPINFOW)、不设 EXTENDED、lpAttributeList = null
     *     → Windows 只读前 68 字节，语义等同于普通 STARTUPINFOW
     *   · B 档：cb = sizeof(STARTUPINFOEXW)、设 EXTENDED、带属性列表
     */
    const startup = {
      StartupInfo: {
        ...baseInfo,
        cb: extended ? koffi.sizeof(STARTUPINFOEXW) : koffi.sizeof(STARTUPINFOW),
      },
      lpAttributeList: null,
    }
    if (extended) {
      const sizeOut = [0]
      InitializeProcThreadAttributeList(null, 1, 0, sizeOut)
      const attributeBuffer = Buffer.alloc(sizeOut[0])
      const size2 = [sizeOut[0]]
      if (InitializeProcThreadAttributeList(attributeBuffer, 1, 0, size2) === 0) {
        throw new Error('InitializeProcThreadAttributeList 失败')
      }
      const handleBuffer = Buffer.alloc(koffi.sizeof('void *'))
      const address = koffi.address(job)
      if (koffi.sizeof('void *') === 8) handleBuffer.writeBigUInt64LE(BigInt(address))
      else handleBuffer.writeUInt32LE(Number(address))
      if (
        UpdateProcThreadAttribute(
          attributeBuffer,
          0,
          BigInt(PROC_THREAD_ATTRIBUTE_JOB_LIST),
          handleBuffer,
          BigInt(koffi.sizeof('void *')),
          null,
          null,
        ) === 0
      ) {
        throw new Error('UpdateProcThreadAttribute 失败')
      }
      startup.lpAttributeList = attributeBuffer
    }

    const info = { hProcess: null, hThread: null, dwProcessId: 0, dwThreadId: 0 }
    const created = CreateProcessAsUserW(
      primaryToken,
      null,
      lineBuffer,
      null,
      null,
      1,
      (extended ? EXTENDED_STARTUPINFO_PRESENT : 0) | CREATE_SUSPENDED,
      null,
      dir,
      startup,
      info,
    )
    if (created === 0) {
      result.create = `failed(${GetLastError()})`
      return result
    }
    result.create = 'ok'
    result.pid = info.dwProcessId

    if (!extended && job) {
      result.assign = AssignProcessToJobObject(job, info.hProcess) === 0 ? `failed(${GetLastError()})` : 'ok'
    }
    ResumeThread(info.hThread)

    /* 500ms 后还活着吗 */
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    result.aliveAfter500ms = WaitForSingleObject(info.hProcess, 0) === WAIT_TIMEOUT

    WaitForSingleObject(info.hProcess, 5000)
    const code = [0]
    GetExitCodeProcess(info.hProcess, code)
    result.exitCode = code[0]
    result.marker = existsSync(marker)
    if (result.marker) result.markerContent = readFileSync(marker, 'utf8').trim()

    const outPath = path.join(dir, 'stdout.txt')
    if (existsSync(outPath)) result.stdoutBytes = readFileSync(outPath, 'utf8').length

    CloseHandle(info.hThread)
    CloseHandle(info.hProcess)
    if (job) CloseHandle(job)
    if (outHandle) CloseHandle(outHandle)
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const rows = [
  arm('A: STARTUPINFOW, 事后 Assign', { extended: false, startInJob: true }),
  arm('B: STARTUPINFOEXW + JobList', { extended: true, startInJob: true }),
]

for (const row of rows) console.log(JSON.stringify(row))
process.exitCode = rows.every((row) => row.marker === true) ? 0 : 1
