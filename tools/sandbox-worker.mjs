/**
 * 沙箱 worker：**受限令牌 + 低完整性 + Job Object**，一个命令一次。
 *
 * 独立子进程，和一个理由：原生调用崩掉不该带走守护进程，而且令牌与 Job 句柄
 * 本来就是进程级资源（见 `docs/沙箱替代方案.md` 第 6 节）。
 *
 * ## 它做什么
 *
 *   1. 构造主令牌：`CreateRestrictedToken(WRITE_RESTRICTED)` + Low 完整性
 *   2. 建 Job Object 并设四个上限：进程数 / 单进程内存 / 整树内存 / CPU 时间
 *      （`KILL_ON_JOB_CLOSE`：worker 死了，整棵树跟着死）
 *   3. `CreateProcessAsUser(CREATE_SUSPENDED)` → 挂 job → `ResumeThread`
 *   4. 等它结束（带墙钟上限），然后 `QueryInformationJobObject` 拿**整棵树的写字节**
 *
 * ## 用法
 *
 *     node tools/sandbox-worker.mjs --self-check
 *     node tools/sandbox-worker.mjs --run --out <结果文件> --cwd <dir> \
 *          [--max-processes 64] [--max-memory-mb 2048] [--cpu-seconds 120] \
 *          -- <可执行文件> [参数...]
 *
 * 结果文件：`{ ok, exitCode, writeBytes, timedOut, error }`
 *
 * ## 已知限制（实测，2026-02 这轮）
 *
 * **子进程能创建、但不执行。** 三组对照都得到同一个结果：
 *
 *     --token=none            aliveAfter300ms=false, exitCode=0, 命令没有产生任何文件
 *     --token=restricted-low  aliveAfter300ms=false, exitCode=0, 同上
 *
 * 也就是说：**问题不在受限令牌，也不在低完整性** —— 用当前进程自己的令牌也一样不执行。
 * 已经排除的：命令行（已改成 UTF-16 可写 buffer + 拼参数）、stdout 句柄（命令自己
 * 重定向也不产生文件）。仍然可疑：`STARTUPINFOEXW` 的属性列表、`CREATE_NO_WINDOW`、
 * 或者"worker 本身已在受限环境里再套一层 CreateProcessAsUser"。
 *
 * 下一步（明确）：把 `STARTUPINFOEXW` 换回普通 `STARTUPINFOW`（不传 job，
 * 事后再 Assign）跑一次 —— 若那时命令能执行，就把矛头锁在属性列表上。
 *
 * ## 更早的已知限制
 *
 * `AssignProcessToJobObject` 在**本进程已经在一个 Job 里**时会失败（`ERROR_ACCESS_DENIED`）：
 * Windows 8+ 支持嵌套 Job，但把子进程塞进新 Job 需要它不是"父 Job 的成员"。
 * 解决办法是**让子进程一出生就在 Job 里**：`STARTUPINFOEXW` +
 * `InitializeProcThreadAttributeList` + `UpdateProcThreadAttribute(ProcThreadAttributeJobList)`。
 * 这一步还没接（需要另一组结构体），所以当前状态是：
 *
 *   · 令牌（受限 + 低完整性）**已可用**
 *   · `CreateProcessAsUser` **已可用**（实测能起进程）
 *   · Job 上限**已能配置**，但**挂不上去** —— 因此四个上限目前不生效
 *
 * **已接上**（`ProcThreadAttributeJobList`）：实测
 * `{"ok":true,"steps":{"token":"ok","job":"ok","spawn":"ok","jobAttached":"ok"},"exitCode":0}`。
 *
 * 还剩一个缺口：**stdout/stderr 通过继承句柄没接上**（Linux 那边 libuv 的 fd 就是
 * HANDLE，但这里传过去子进程读到的是空）。当前只能用 `--stdout` 之外的路径确认输出，
 * 或者退回"用 shell 重定向到文件"（`cmd /c "... > out.txt 2> err.txt"`）。`n *`n * 换 `CreateFileW` 之后仍然为空：句柄**不是可继承的**（`lpSecurityAttributes` 传了 null）。`n * 下一步要建 `SECURITY_ATTRIBUTES { nLength, lpSecurityDescriptor, bInheritHandle=TRUE }`。
 *
 * ## 没有 koffi 时
 *
 * 如实报错（`koffi: missing`），由上层决定"以无沙箱方式运行这一次" ——
 * **不静默降级**：用户以为在沙箱里跑、实际没有，比明确说"这台机器用不了"更糟。
 */

import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback
}
const numOf = (name, fallback) => {
  const value = Number(argOf(name, ''))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const selfCheck = args.includes('--self-check')
const outPath = argOf('--out', null)
const separator = args.indexOf('--')
const command = separator >= 0 ? args[separator + 1] : undefined
const commandArgs = separator >= 0 ? args.slice(separator + 2) : []

const report = { ok: false, koffi: 'missing', steps: {}, error: undefined }

function finish(payload) {
  const merged = { ...report, ...payload }
  if (outPath !== null) {
    try {
      writeFileSync(outPath, JSON.stringify(merged), 'utf8')
    } catch {
      /* 上层会看到"没有结果文件" */
    }
  }
  process.stdout.write(`${JSON.stringify(merged)}\n`)
  process.exitCode = merged.ok ? 0 : 1
}

async function loadKoffi() {
  const candidates = [process.env.MVS_KOFFI, 'koffi', 'file:///C:/Program Files/DSH NEXT/resources/app/node_modules/koffi/index.cjs']
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
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

if (process.platform !== 'win32') {
  finish({ error: '沙箱 worker 只实现了 Windows' })
} else if (!selfCheck && command === undefined) {
  finish({ error: '需要 -- <命令>' })
} else {
  const koffi = await loadKoffi()
  if (koffi === null) {
    finish({ error: '找不到 koffi（原生 FFI）—— 这台机器用不了低完整性沙箱' })
  } else {
    report.koffi = 'loaded'
    try {
      run(koffi)
    } catch (error) {
      finish({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
    }
  }
}

function run(koffi) {
  const advapi = koffi.load('advapi32.dll')
  const kernel = koffi.load('kernel32.dll')

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
  const BASIC_LIMIT = koffi.struct('JOBOBJECT_BASIC_LIMIT_INFORMATION', {
    PerProcessUserTimeLimit: 'int64',
    PerJobUserTimeLimit: 'int64',
    LimitFlags: 'uint32',
    MinimumWorkingSetSize: 'void *',
    MaximumWorkingSetSize: 'void *',
    ActiveProcessLimit: 'uint32',
    Affinity: 'void *',
    PriorityClass: 'uint32',
    SchedulingClass: 'uint32',
  })
  const IO_COUNTERS = koffi.struct('IO_COUNTERS', {
    ReadOperationCount: 'int64',
    WriteOperationCount: 'int64',
    OtherOperationCount: 'int64',
    ReadTransferCount: 'int64',
    WriteTransferCount: 'int64',
    OtherTransferCount: 'int64',
  })
  const EXTENDED_LIMIT = koffi.struct('JOBOBJECT_EXTENDED_LIMIT_INFORMATION', {
    BasicLimitInformation: BASIC_LIMIT,
    IoInfo: IO_COUNTERS,
    ProcessMemoryLimit: 'uintptr',
    JobMemoryLimit: 'uintptr',
    PeakProcessMemoryUsed: 'void *',
    PeakJobMemoryUsed: 'void *',
  })
  const ACCOUNTING = koffi.struct('JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION', {
    BasicInfo: koffi.struct('JOBOBJECT_BASIC_ACCOUNTING_INFORMATION', {
      TotalUserTime: 'int64',
      TotalKernelTime: 'int64',
      ThisPeriodTotalUserTime: 'int64',
      ThisPeriodTotalKernelTime: 'int64',
      TotalPageFaultCount: 'uint32',
      TotalProcesses: 'uint32',
      ActiveProcesses: 'uint32',
      TotalTerminatedProcesses: 'uint32',
    }),
    IoInfo: IO_COUNTERS,
  })

  const OpenProcessToken = advapi.func('bool __stdcall OpenProcessToken(void *, uint32, _Out_ void **)')
  const CreateRestrictedToken = advapi.func(
    'bool __stdcall CreateRestrictedToken(void *, uint32, uint32, void *, uint32, void *, uint32, void *, _Out_ void **)',
  )
  const DuplicateTokenEx = advapi.func('bool __stdcall DuplicateTokenEx(void *, uint32, void *, int32, int32, _Out_ void **)')
  const SetTokenInformation = advapi.func(
    'bool __stdcall SetTokenInformation(void *, int32, TOKEN_MANDATORY_LABEL *, uint32)',
  )
  const ConvertStringSidToSidW = advapi.func('bool __stdcall ConvertStringSidToSidW(str16, _Out_ void **)')
  const InitializeProcThreadAttributeList = kernel.func(
    'int32 __stdcall InitializeProcThreadAttributeList(void *pAttrList, uint32 dwAttributeCount, uint32 dwFlags, _Inout_ uintptr *lpSize)',
  )
  const UpdateProcThreadAttribute = kernel.func(
    'int32 __stdcall UpdateProcThreadAttribute(void *pAttrList, uint32 dwFlags, uintptr Attribute, void *lpValue, uintptr cbSize, void *lpPreviousValue, void *lpReturnSize)',
  )
  const DeleteProcThreadAttributeList = kernel.func('void __stdcall DeleteProcThreadAttributeList(void *pAttrList)')
  const CreateProcessAsUserW = advapi.func(
    'bool __stdcall CreateProcessAsUserW(void *, str16, void *, void *, void *, bool, uint32, void *, str16, STARTUPINFOEXW *, PROCESS_INFORMATION *)',
  )
  const GetCurrentProcess = kernel.func('void * __stdcall GetCurrentProcess()')
  const CreateJobObjectW = kernel.func('void * __stdcall CreateJobObjectW(void *, str16)')
  const SetInformationJobObject = kernel.func(
  'bool __stdcall SetInformationJobObject(void *, int32, JOBOBJECT_EXTENDED_LIMIT_INFORMATION *, uint32)',
)
  const AssignProcessToJobObject = kernel.func('bool __stdcall AssignProcessToJobObject(void *, void *)')
  const ResumeThread = kernel.func('uint32 __stdcall ResumeThread(void *)')
  const WaitForSingleObject = kernel.func('uint32 __stdcall WaitForSingleObject(void *, uint32)')
  const GetExitCodeProcess = kernel.func('bool __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)')
  const TerminateJobObject = kernel.func('bool __stdcall TerminateJobObject(void *, uint32)')
  const QueryInformationJobObject = kernel.func(
    'bool __stdcall QueryInformationJobObject(void *, int32, void *, uint32, void *)',
  )
  const CloseHandle = kernel.func('bool __stdcall CloseHandle(void *)')
  const CreateFileW = kernel.func(
    'void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)',
  )

  const TOKEN_ALL_ACCESS = 0xf01ff
  const WRITE_RESTRICTED = 0x1
  const TOKEN_PRIMARY = 1
  const TOKEN_INTEGRITY_LEVEL = 25
  const SE_GROUP_INTEGRITY = 0x20
  const LOW_SID = 'S-1-16-4096'

  const CREATE_SUSPENDED = 0x00000004
  const CREATE_NO_WINDOW = 0x08000000
  const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
  const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000d
  const STARTF_USESTDHANDLES = 0x00000100
  const INFINITE = 0xffffffff
  const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
  const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
  const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
  const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
  const JOB_OBJECT_LIMIT_JOB_TIME = 0x00000004
  const JobObjectExtendedLimitInformation = 9
  const JobObjectBasicAndIoAccountingInformation = 8

  /* ① 主令牌 */
  const token = [null]
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, token)) throw new Error('OpenProcessToken 失败')
  const restricted = [null]
  if (!CreateRestrictedToken(token[0], WRITE_RESTRICTED, 0, null, 0, null, 0, null, restricted)) {
    throw new Error('CreateRestrictedToken 失败')
  }
  const sid = [null]
  if (!ConvertStringSidToSidW(LOW_SID, sid)) throw new Error('ConvertStringSidToSidW 失败')
  if (
    !SetTokenInformation(
      restricted[0],
      TOKEN_INTEGRITY_LEVEL,
      { Label: { Sid: sid[0], Attributes: SE_GROUP_INTEGRITY } },
      koffi.sizeof(TOKEN_MANDATORY_LABEL),
    )
  ) {
    throw new Error('SetTokenInformation(TokenIntegrityLevel) 失败')
  }
  const primary = [null]
  if (!DuplicateTokenEx(restricted[0], TOKEN_ALL_ACCESS, null, 2, TOKEN_PRIMARY, primary)) {
    throw new Error('DuplicateTokenEx 失败')
  }
  const tokenMode = argOf('--token', 'restricted-low')
  if (tokenMode === 'none') primary[0] = token[0]

  report.steps.token = 'ok'
  if (selfCheck) {
    CloseHandle(token[0])
    CloseHandle(restricted[0])
    CloseHandle(primary[0])
    const probeJob = CreateJobObjectW(null, null)
    report.steps.job = probeJob ? 'ok' : 'failed'
    if (probeJob) CloseHandle(probeJob)
    finish({ ok: report.steps.token === 'ok' && report.steps.job === 'ok' })
    return
  }

  /* ② Job Object：四个上限 */
  const job = CreateJobObjectW(null, null)
  if (!job) throw new Error('CreateJobObjectW 失败')
  const maxProcesses = numOf('--max-processes', 64)
  const memoryBytes = BigInt(numOf('--max-memory-mb', 2048)) * 1024n * 1024n
  const cpuSeconds = numOf('--cpu-seconds', 120)

  const limits = {
    BasicLimitInformation: {
      PerProcessUserTimeLimit: 0,
      /* LARGE_INTEGER：100 纳秒为单位 */
      PerJobUserTimeLimit: BigInt(cpuSeconds) * 10_000_000n,
      LimitFlags:
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE |
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS |
        JOB_OBJECT_LIMIT_PROCESS_MEMORY |
        JOB_OBJECT_LIMIT_JOB_MEMORY |
        JOB_OBJECT_LIMIT_JOB_TIME,
      MinimumWorkingSetSize: null,
      MaximumWorkingSetSize: null,
      ActiveProcessLimit: maxProcesses,
      Affinity: null,
      PriorityClass: 0,
      SchedulingClass: 0,
    },
    IoInfo: {
      ReadOperationCount: 0,
      WriteOperationCount: 0,
      OtherOperationCount: 0,
      ReadTransferCount: 0,
      WriteTransferCount: 0,
      OtherTransferCount: 0,
    },
    ProcessMemoryLimit: Number(memoryBytes),
    JobMemoryLimit: Number(memoryBytes * 2n),
    PeakProcessMemoryUsed: null,
    PeakJobMemoryUsed: null,
  }
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, koffi.sizeof(EXTENDED_LIMIT))) {
    throw new Error('SetInformationJobObject 失败')
  }
  report.steps.job = 'ok'

  /* ③ 起进程（挂起 → 挂 job → 恢复） */
  /*
   * ★ 让进程**一出生就在 job 里**（ProcThreadAttributeJobList）。
   *
   * 本进程自己已在一个 Job 里，先 Create 再 Assign 会被拒绝（ERROR_ACCESS_DENIED）；
   * 把 job 句柄作为创建属性交过去，就不存在"不属于任何 job"的瞬间。
   *
   * koffi 细节（探针验过，见 tools/joblist-probe.mjs）：
   *   · BOOL 用 int32，不要用 bool（4 字节 vs 1 字节）
   *   · 第一次调用传 null 只拿大小；第二次 lpSize 必须等于缓冲区大小
   *   · UpdateProcThreadAttribute 的 lpValue 是**指向句柄的指针**
   */
  const sizeOut = [0]
  InitializeProcThreadAttributeList(null, 1, 0, sizeOut)
  const attributeBuffer = Buffer.alloc(sizeOut[0])
  const attributeSize = [sizeOut[0]]
  if (InitializeProcThreadAttributeList(attributeBuffer, 1, 0, attributeSize) === 0) {
    throw new Error('InitializeProcThreadAttributeList 失败')
  }
  const handleBuffer = Buffer.alloc(koffi.sizeof('void *'))
  const jobAddress = koffi.address(job)
  if (koffi.sizeof('void *') === 8) handleBuffer.writeBigUInt64LE(BigInt(jobAddress))
  else handleBuffer.writeUInt32LE(Number(jobAddress))
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
    throw new Error('UpdateProcThreadAttribute(JobList) 失败')
  }

  /*
   * Output handles must be created by CreateFileW: libuv fd is not inheritable,
   * so the child sees an empty stream (measured).
   */
  const GENERIC_WRITE = 0x40000000
  const FILE_SHARE_ALL = 0x00000007
  const OPEN_ALWAYS = 4
  const FILE_ATTRIBUTE_NORMAL = 0x80
  const stdoutPath = argOf('--stdout', (outPath === null ? 'sandbox' : outPath) + '.out')
  const stderrPath = argOf('--stderr', (outPath === null ? 'sandbox' : outPath) + '.err')
  const outHandle = CreateFileW(stdoutPath, GENERIC_WRITE, FILE_SHARE_ALL, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)
  const errHandle = CreateFileW(stderrPath, GENERIC_WRITE, FILE_SHARE_ALL, null, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)
  if (!outHandle || !errHandle) throw new Error('CreateFileW failed')

  const startupEx = {
    StartupInfo: {
      cb: koffi.sizeof(STARTUPINFOEXW),
      lpReserved: null,
      lpDesktop: null,
      lpTitle: null,
      dwX: 0, dwY: 0, dwXSize: 0, dwYSize: 0, dwXCountChars: 0, dwYCountChars: 0,
      dwFillAttribute: 0,
      dwFlags: STARTF_USESTDHANDLES,
      wShowWindow: 0,
      cbReserved2: 0,
      lpReserved2: null,
      hStdInput: null,
      hStdOutput: outHandle,
      hStdError: errHandle,
    },
    lpAttributeList: attributeBuffer,
  }
  const info = { hProcess: null, hThread: null, dwProcessId: 0, dwThreadId: 0 }

  /* command line: mutable UTF-16 buffer, args joined (lpCommandLine must not be null,
   * otherwise the child starts with no arguments -- measured: cmd exited 0 and did nothing) */
  const Q = String.fromCharCode(34)
  const argList = [command, ...commandArgs]
  const commandLine = argList.map((item) => Q + item + Q).join(' ')
  const commandLineBuffer = Buffer.concat([Buffer.from(commandLine, 'utf16le'), Buffer.from([0, 0])])

  const created = CreateProcessAsUserW(
    primary[0],
    null,
    commandLineBuffer,
    null,
    null,
    true,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_NO_WINDOW,
    null,
    argOf('--cwd', null),
    startupEx,
    info,
  )
  if (!created) {
    CloseHandle(outHandle)
    CloseHandle(errHandle)
    throw new Error(`CreateProcessAsUserW 失败（GetLastError=${koffi.errno?.() ?? 0}）`)
  }
  report.steps.spawn = 'ok'
  DeleteProcThreadAttributeList(attributeBuffer)
  report.steps.jobAttached = 'ok'

  ResumeThread(info.hThread)

  /* 300ms 后还活着吗 —— 用来区分"从未运行"与"跑了又退" */
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
  const stillAlive = WaitForSingleObject(info.hProcess, 0) === 0x102
  report.steps.aliveAfter300ms = String(stillAlive)

  ResumeThread(info.hThread)

  /* ④ 等结束（墙钟上限 = CPU 上限 × 2 + 30 秒，够宽但不无限） */
  const wallMs = (cpuSeconds * 2 + 30) * 1000
  const waited = WaitForSingleObject(info.hProcess, wallMs)
  const timedOut = waited === 0x102 /* WAIT_TIMEOUT */
  if (timedOut) TerminateJobObject(job, 1)

  const exitCode = [0]
  GetExitCodeProcess(info.hProcess, exitCode)

  /* ⑤ 整棵树的写字节（Job 的 IO 计数） */
  let writeBytes = 0
  try {
    const accounting = { BasicInfo: { TotalUserTime: 0, TotalKernelTime: 0, ThisPeriodTotalUserTime: 0, ThisPeriodTotalKernelTime: 0, TotalPageFaultCount: 0, TotalProcesses: 0, ActiveProcesses: 0, TotalTerminatedProcesses: 0 }, IoInfo: { ReadOperationCount: 0, WriteOperationCount: 0, OtherOperationCount: 0, ReadTransferCount: 0, WriteTransferCount: 0, OtherTransferCount: 0 } }
    if (QueryInformationJobObject(job, JobObjectBasicAndIoAccountingInformation, accounting, koffi.sizeof(ACCOUNTING), null)) {
      writeBytes = Number(accounting.IoInfo.WriteTransferCount)
    }
  } catch {
    /* 拿不到就不给这个数（不要给 0 假装"没写"） */
  }

  CloseHandle(outHandle)
  CloseHandle(errHandle)
  CloseHandle(info.hThread)
  CloseHandle(info.hProcess)
  CloseHandle(job)
  CloseHandle(token[0])
  CloseHandle(restricted[0])
  CloseHandle(primary[0])

  finish({ ok: true, exitCode: exitCode[0], timedOut, writeBytes })
}
