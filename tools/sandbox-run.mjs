/**
 * 沙箱执行器：**一条命令，受限令牌 + 低完整性 + Job 上限**。
 *
 * 这个文件是把 `tools/sandbox-spawn-matrix.mjs` 里已经跑通的那一档（B 档）抽出来的：
 * 同样的令牌、同样的 `ProcThreadAttributeJobList`、同样的输出句柄，只是把"只验证"变成"能交付"。
 *
 * ## 两个曾经让它假通过的坑（都在这份代码里修掉了）
 *
 * 1. **`PROCESS_INFORMATION` 必须用 Buffer 承接。**
 *    传 JS 对象时 koffi 不回写：`CreateProcess*` 返回 1、`GetLastError` 是 0，
 *    而 `pid` 永远是 0、`hProcess` 是 NULL。前一版就靠这个返回值判断"起来了"，
 *    于是得出过一串错误结论（见 `docs/沙箱替代方案.md` 6.3/6.4）。
 * 2. **命令行不能把每个 token 都加引号。**
 *    `"cmd.exe" "/c" "echo x > \"f\""` 会让 cmd 报错（stdout 68 字节、exitCode 1）。
 *    正确形态是 `"<exe>" /c "<整条命令>"`，内层引号由 cmd 自己解析。
 *
 * ## 用法
 *
 *     node tools/sandbox-run.mjs --cwd <dir> --out <result.json> [选项] -- <exe> [args...]
 *
 * 选项：`--timeout-ms 120000`、`--max-processes 64`、`--max-memory-mb 2048`、
 *      `--cpu-seconds 120`、`--token none|restricted-low`（默认后者）
 *
 * 结果文件：`{ ok, exitCode, timedOut, writeBytes, pid }`；失败时带 `error`。
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
const numOf = (name, fallback) => {
  const value = Number(argOf(name, ''))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const separator = argv.indexOf('--')
const command = separator >= 0 ? argv[separator + 1] : undefined
const commandArgs = separator >= 0 ? argv.slice(separator + 2) : []
const cwd = argOf('--cwd', process.cwd())
const outPath = argOf('--out', null)
const tokenMode = argOf('--token', 'restricted-low')

const result = { ok: false, koffi: 'missing' }
const finish = (payload) => {
  Object.assign(result, payload)
  if (outPath !== null) {
    try {
      const { writeFileSync } = awaitImportWrite()
      writeFileSync(outPath, JSON.stringify(result), 'utf8')
    } catch {
      /* 没有结果文件时上层会看到"没有结果" */
    }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`)
  process.exitCode = result.ok ? 0 : 1
}
function awaitImportWrite() {
  return { writeFileSync: (p, data) => import('node:fs').then((m) => m.writeFileSync(p, data)) }
}

if (command === undefined) {
  finish({ error: '需要 -- <exe> [args...]' })
} else {
  const koffi = await loadKoffi()
  if (koffi === null) {
    finish({ error: 'koffi 不可用 —— 这台机器用不了低完整性沙箱' })
  } else {
    result.koffi = 'loaded'
    try {
      finish(run(koffi))
    } catch (error) {
      finish({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}

function run(koffi) {
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
  const BASIC_LIMIT = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
    PerProcessUserTimeLimit: 'int64', PerJobUserTimeLimit: 'int64', LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'void *', MaximumWorkingSetSize: 'void *', ActiveProcessLimit: 'uint32',
    Affinity: 'void *', PriorityClass: 'uint32', SchedulingClass: 'uint32',
  })
  const IO_COUNTERS = koffi.struct('IO_COUNTERS', {
    ReadOperationCount: 'int64', WriteOperationCount: 'int64', OtherOperationCount: 'int64',
    ReadTransferCount: 'int64', WriteTransferCount: 'int64', OtherTransferCount: 'int64',
  })
  const EXTENDED_LIMIT = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
    BasicLimitInformation: BASIC_LIMIT, IoInfo: IO_COUNTERS,
    ProcessMemoryLimit: 'uintptr', JobMemoryLimit: 'uintptr',
    PeakProcessMemoryUsed: 'uintptr', PeakJobMemoryUsed: 'uintptr',
  })
  const BASIC_ACCOUNTING = koffi.struct('JOBOBJECT_BASIC_ACCOUNTING_INFORMATION', {
    TotalUserTime: 'int64', TotalKernelTime: 'int64',
    ThisPeriodTotalUserTime: 'int64', ThisPeriodTotalKernelTime: 'int64',
    TotalPageFaultCount: 'uint32', TotalProcesses: 'uint32',
    ActiveProcesses: 'uint32', TotalTerminatedProcesses: 'uint32',
  })
  const ACCOUNTING = koffi.struct('JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION', {
    BasicInfo: BASIC_ACCOUNTING,
    IoInfo: IO_COUNTERS,
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
  const SetInformationJobObject = kernel.func(
    'int32 __stdcall SetInformationJobObject(void *, int32, JOBOBJECT_EXTENDED_LIMIT_INFORMATION *, uint32)',
  )
  const ResumeThread = kernel.func('uint32 __stdcall ResumeThread(void *)')
  const WaitForSingleObject = kernel.func('uint32 __stdcall WaitForSingleObject(void *, uint32)')
  const GetExitCodeProcess = kernel.func('int32 __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)')
  const TerminateJobObject = kernel.func('int32 __stdcall TerminateJobObject(void *, uint32)')
  const QueryInformationJobObject = kernel.func(
    'int32 __stdcall QueryInformationJobObject(void *, int32, void *, uint32, void *)',
  )
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
  const DeleteProcThreadAttributeList = kernel.func('void __stdcall DeleteProcThreadAttributeList(void *)')

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
  const GENERIC_WRITE = 0x40000000
  const FILE_SHARE_ALL = 0x00000007
  const OPEN_ALWAYS = 4
  const FILE_ATTRIBUTE_NORMAL = 0x80
  const WAIT_TIMEOUT = 0x102
  const JOB_KILL_ON_CLOSE = 0x00002000
  const JOB_ACTIVE_PROCESS = 0x00000008
  const JOB_PROCESS_MEMORY = 0x00000100
  const JOB_JOB_MEMORY = 0x00000200
  const JOB_JOB_TIME = 0x00000004
  const JobObjectExtendedLimitInformation = 9
  const JobObjectBasicAndIoAccountingInformation = 8
  const Q = String.fromCharCode(34)

  const steps = {}
  const token = [null]
  if (OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, token) === 0) {
    throw new Error(`OpenProcessToken failed (${GetLastError()})`)
  }
  let primaryToken = token[0]
  if (tokenMode !== 'none') {
    const restricted = [null]
    if (CreateRestrictedToken(token[0], WRITE_RESTRICTED, 0, null, 0, null, 0, null, restricted) === 0) {
      throw new Error(`CreateRestrictedToken failed (${GetLastError()})`)
    }
    const sid = [null]
    if (ConvertStringSidToSidW(LOW_SID, sid) === 0) throw new Error(`ConvertStringSidToSidW failed (${GetLastError()})`)
    if (
      SetTokenInformation(
        restricted[0],
        TOKEN_INTEGRITY_LEVEL,
        { Label: { Sid: sid[0], Attributes: SE_GROUP_INTEGRITY } },
        koffi.sizeof(TOKEN_MANDATORY_LABEL),
      ) === 0
    ) {
      throw new Error(`SetTokenInformation failed (${GetLastError()})`)
    }
    const primary = [null]
    if (DuplicateTokenEx(restricted[0], TOKEN_ALL_ACCESS, null, 2, TOKEN_PRIMARY, primary) === 0) {
      throw new Error(`DuplicateTokenEx failed (${GetLastError()})`)
    }
    primaryToken = primary[0]
  }
  steps.token = tokenMode

  const job = CreateJobObjectW(null, null)
  if (!job) throw new Error(`CreateJobObjectW failed (${GetLastError()})`)
  const memoryBytes = numOf('--max-memory-mb', 2048) * 1024 * 1024
  const cpuSeconds = numOf('--cpu-seconds', 120)
  const limits = {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      PerJobUserTimeLimit: BigInt(cpuSeconds) * 10_000_000n,
      LimitFlags: JOB_KILL_ON_CLOSE | JOB_ACTIVE_PROCESS | JOB_PROCESS_MEMORY | JOB_JOB_MEMORY | JOB_JOB_TIME,
      MinimumWorkingSetSize: null,
      MaximumWorkingSetSize: null,
      ActiveProcessLimit: numOf('--max-processes', 64),
      Affinity: null,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0, WriteOperationCount: 0, OtherOperationCount: 0,
      ReadTransferCount: 0, WriteTransferCount: 0, OtherTransferCount: 0,
    },
    ProcessMemoryLimit: memoryBytes,
    JobMemoryLimit: memoryBytes * 2,
    PeakProcessMemoryUsed: 0,
    PeakJobMemoryUsed: 0,
  }
  if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, koffi.sizeof(EXTENDED_LIMIT)) === 0) {
    throw new Error(`SetInformationJobObject failed (${GetLastError()})`)
  }
  steps.job = 'ok'

  const outDir = mkdtempSync(path.join(tmpdir(), 'mvs-sandbox-'))
  const inheritable = {
    nLength: koffi.sizeof(SECURITY_ATTRIBUTES),
    lpSecurityDescriptor: null,
    bInheritHandle: 1,
  }
  const outHandle = CreateFileW(path.join(outDir, 'stdout.txt'), GENERIC_WRITE, FILE_SHARE_ALL, inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)
  const errHandle = CreateFileW(path.join(outDir, 'stderr.txt'), GENERIC_WRITE, FILE_SHARE_ALL, inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)
  if (!outHandle || !errHandle) throw new Error(`CreateFileW failed (${GetLastError()})`)

  const exe = command
  const inner = [exe, ...commandArgs].map((item) => (item.includes(' ') ? Q + item + Q : item)).join(' ')
  const line = Q + exe + Q + ' ' + commandArgs.map((item) => (item.includes(' ') ? Q + item + Q : item)).join(' ')
  const lineBuffer = Buffer.concat([Buffer.from(line.length > 0 ? line : Q + exe + Q, 'utf16le'), Buffer.from([0, 0])])
  void inner

  const sizeOut = [0]
  InitializeProcThreadAttributeList(null, 1, 0, sizeOut)
  const attributeBuffer = Buffer.alloc(sizeOut[0])
  const attributeSize = [sizeOut[0]]
  if (InitializeProcThreadAttributeList(attributeBuffer, 1, 0, attributeSize) === 0) {
    throw new Error(`InitializeProcThreadAttributeList failed (${GetLastError()})`)
  }
  const handleBuffer = Buffer.alloc(koffi.sizeof('void *'))
  const jobAddress = koffi.address(job)
  if (koffi.sizeof('void *') === 8) handleBuffer.writeBigUInt64LE(BigInt(jobAddress))
  else handleBuffer.writeUInt32LE(Number(jobAddress))
  if (
    UpdateProcThreadAttribute(
      attributeBuffer, 0, BigInt(PROC_THREAD_ATTRIBUTE_JOB_LIST), handleBuffer, BigInt(koffi.sizeof('void *')), null, null,
    ) === 0
  ) {
    throw new Error(`UpdateProcThreadAttribute failed (${GetLastError()})`)
  }

  const startup = {
    StartupInfo: {
      cb: koffi.sizeof(STARTUPINFOEXW),
      lpReserved: null, lpDesktop: null, lpTitle: null,
      dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0, dwFillAttribute: 0,
      dwFlags: STARTF_USESTDHANDLES,
      wShowWindow: 0, cbReserved2: 0, lpReserved2: null,
      hStdInput: null, hStdOutput: outHandle, hStdError: errHandle,
    },
    lpAttributeList: attributeBuffer,
  }

  /* ★ 输出参数必须是 Buffer：传 JS 对象时 koffi 不回写（pid 永远是 0） */
  const infoBuf = Buffer.alloc(koffi.sizeof(PROCESS_INFORMATION))
  const created = CreateProcessAsUserW(
    primaryToken, null, lineBuffer, null, null, 1,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, null, cwd, startup, infoBuf,
  )
  if (created === 0) throw new Error(`CreateProcessAsUserW failed (${GetLastError()})`)
  DeleteProcThreadAttributeList(attributeBuffer)

  const hProcess = infoBuf.readBigUInt64LE(0)
  const hThread = infoBuf.readBigUInt64LE(8)
  const pid = infoBuf.readUInt32LE(16)
  ResumeThread(hThread)

  const timeoutMs = numOf('--timeout-ms', 120_000)
  const waited = WaitForSingleObject(hProcess, timeoutMs)
  const timedOut = waited === WAIT_TIMEOUT
  if (timedOut) TerminateJobObject(job, 1)

  const exitCode = [0]
  GetExitCodeProcess(hProcess, exitCode)

  /* 整棵树的写字节 —— 拿不到就不给这个字段（不给 0 假装"没写"） */
  let writeBytes
  try {
    const accounting = {
      BasicInfo: {
        TotalUserTime: 0, TotalKernelTime: 0, ThisPeriodTotalUserTime: 0, ThisPeriodTotalKernelTime: 0,
        TotalPageFaultCount: 0, TotalProcesses: 0, ActiveProcesses: 0, TotalTerminatedProcesses: 0,
      },
      IoInfo: {
        ReadOperationCount: 0, WriteOperationCount: 0, OtherOperationCount: 0,
        ReadTransferCount: 0, WriteTransferCount: 0, OtherTransferCount: 0,
      },
    }
    if (
      QueryInformationJobObject(job, JobObjectBasicAndIoAccountingInformation, accounting, koffi.sizeof(ACCOUNTING), null) !== 0
    ) {
      writeBytes = Number(accounting.IoInfo.WriteTransferCount)
    }
  } catch {
    /* 保留 undefined */
  }

  const outFile = path.join(outDir, 'stdout.txt')
  const errFile = path.join(outDir, 'stderr.txt')
  const stdout = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
  const stderr = existsSync(errFile) ? readFileSync(errFile, 'utf8') : ''

  CloseHandle(outHandle)
  CloseHandle(errHandle)
  CloseHandle(job)
  rmSync(outDir, { recursive: true, force: true })

  return {
    ok: true,
    steps,
    pid,
    exitCode: exitCode[0],
    timedOut,
    ...(writeBytes === undefined ? {} : { writeBytes }),
    stdout,
    stderr,
  }
}
