/**
 * 断网执行器：**AppContainer（无网络） + Job 上限**。
 *
 * ## 为什么是"创建后挂 Job"而不是"属性列表里带 Job"
 *
 * 把 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 和 `SECURITY_CAPABILITIES` 放进同一个属性列表时，
 * node 会在 `InitializeOncePerProcess` 崩掉（exit 134，试过六种组合）。
 * 所以 Job 改成**进程创建之后**再 `AssignProcessToJobObject` —— 这一句成功，
 * 断网与资源上限就同时生效了。
 *
 * 分配失败时**如实报告** `job: "failed(N)"` 并继续跑：断网仍然有效，只是没有上限。
 * 不静默降级。
 *
 * ## 三道刹车
 *
 *   1. Job 的 ActiveProcessLimit / ProcessMemoryLimit / JobMemoryLimit / PerJobUserTimeLimit
 *   2. 写字节轮询：每 200 ms 读 Job 的 `WriteTransferCount`，超过 `--max-write-mb` 就
 *      `TerminateJobObject`（这是"写盘填满"的正面防线，之前只计量不拦）
 *   3. 墙钟超时（`--timeout-ms`），超了同样整棵树终止
 *
 * ## 用法
 *
 *     node tools/sandbox-net-run.mjs --cwd <dir> [--max-processes 64] [--max-memory-mb 2048]
 *          [--cpu-seconds 120] [--max-write-mb 512] [--timeout-ms 120000] -- <exe> [args...]
 *
 * `MVS_SANDBOX_NET=1` 时**跳过** AppContainer（联网），只用于装依赖那类场景。
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs'
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
const DeleteProcThreadAttributeList = kernel.func('void __stdcall DeleteProcThreadAttributeList(void *)')
const CreateFileW = kernel.func(
  'void * __stdcall CreateFileW(str16, uint32, uint32, SECURITY_ATTRIBUTES *, uint32, uint32, void *)',
)
const CreateJobObjectW = kernel.func('void * __stdcall CreateJobObjectW(void *, str16)')
const SetInformationJobObject = kernel.func(
  'int32 __stdcall SetInformationJobObject(void *, int32, JOBOBJECT_EXTENDED_LIMIT_INFORMATION *, uint32)',
)
const AssignProcessToJobObject = kernel.func('int32 __stdcall AssignProcessToJobObject(void *, void *)')
const QueryInformationJobObject = kernel.func(
  'int32 __stdcall QueryInformationJobObject(void *, int32, void *, uint32, void *)',
)
const TerminateJobObject = kernel.func('int32 __stdcall TerminateJobObject(void *, uint32)')
const WaitForSingleObject = kernel.func('uint32 __stdcall WaitForSingleObject(void *, uint32)')
const GetExitCodeProcess = kernel.func('int32 __stdcall GetExitCodeProcess(void *, _Out_ uint32 *)')
const GetLastError = kernel.func('uint32 __stdcall GetLastError()')
const CloseHandle = kernel.func('int32 __stdcall CloseHandle(void *)')

const EXTENDED_STARTUPINFO_PRESENT = 0x00080000
const CREATE_NO_WINDOW = 0x08000000
const STARTF_USESTDHANDLES = 0x00000100
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x00020002
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

const dir = mkdtempSync(path.join(tmpdir(), 'mvs-netrun-'))
const outPath = path.join(dir, 'stdout.txt')
const errPath = path.join(dir, 'stderr.txt')

/* 给工作目录授权：容器读不到工作区就什么都干不了（实测 Cannot find module） */
const withAppContainer = process.env['MVS_SANDBOX_NET'] !== '1'
/*
 * 授权分两类：**写只给工作区（+ TEMP），读给整个用户目录**。
 *
 * 读是刻意**不设限**的：工具链要读的东西本来就在工作区之外（`~/.npmrc`、
 * `~/.gitconfig`、包缓存、System32 的 dll…），卡住读只会让沙箱不可用。
 *
 * 挡泄密靠的不是"读不到"，而是：
 *   · 网络被 AppContainer 切断（没有 internetClient）
 *   · 读出的内容进上下文之前过输出审核（打码 / 扣留 / taint）
 */
const grants = []
/* 专属 SID：从注册表映射里查（Windows 自己写的，不靠推导） */
const OWN_SID = (() => {
  try {
    const out = spawnSync('reg', ['query', 'HKCU\\\\Software\\\\Classes\\\\Local Settings\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\AppContainer\\\\Mappings', '/s', '/v', 'Moniker'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    const blocks = String(out.stdout ?? '').split(/\\r?\\n\\r?\\n/)
    for (const block of blocks) {
      const sid = /Mappings\\\\(S-1-15-2-[\\\\d-]+)/.exec(block)?.[1]
      const moniker = /Moniker\\s+REG_SZ\\s+(.+)/.exec(block)?.[1]?.trim().toLowerCase()
      if (sid !== undefined && moniker === 'mvs.agent.sandbox') return sid
    }
  } catch {}
  return 'S-1-15-2-1'
})()
if (withAppContainer) {
  const add = (target, rights) => {
    /* 优先授权给自己 profile 的 SID（只有我们的沙箱认）；查不到才退回 ALL APP PACKAGES */
    const spec = rights === 'M' ? '*' + OWN_SID + ':(M)' : '*' + OWN_SID + ':(OI)(CI)' + rights
    const probe = spawnSync('icacls', [target, '/grant', spec], {
      windowsHide: true,
      timeout: 15000,
    })
    grants.push({ target, rights, ok: probe.status === 0 })
  }
  if (cwd !== null) add(cwd, 'M')
  /* TEMP 与「整个用户目录可读」的授权由 npm run sandbox:grant 一次性做完 ——
     它们递归几千个文件，每条命令都做一次太慢（实测会超时） */
}
const grantedStatus = grants.length === 0
  ? 'skipped'
  : grants.every((item) => item.ok)
    ? 'ok(' + grants.length + ')'
    : 'failed(' + grants.filter((item) => !item.ok).map((item) => item.target).join(',') + ')'

let attributes = null
let attributeApplied = 'skipped'
if (withAppContainer) {
  const profileName = 'MVS.Agent.Sandbox'
  const sidOut = [null]
  CreateAppContainerProfile(profileName, profileName, 'MVS sandbox', null, 0, sidOut)
  /* profile 已存在时返回 183 且不写 SID —— 必须补一次 derive */
  if (sidOut[0] === null) DeriveAppContainerSidFromAppContainerName(profileName, sidOut)

  const sizeOut = [0]
  InitializeProcThreadAttributeList(null, 2, 0, sizeOut)
  /* 属性列表要求 8 字节对齐，Buffer.alloc 不保证 */
  const raw = Buffer.alloc(sizeOut[0] + 16)
  const align = (8 - (raw.byteOffset % 8)) % 8
  attributes = raw.subarray(align, align + sizeOut[0])
  InitializeProcThreadAttributeList(attributes, 2, 0, [sizeOut[0]])
  /* SECURITY_CAPABILITIES 手工布局：传 JS 对象会让 Windows 读到坏指针 */
  const capsBuf = Buffer.alloc(24)
  if (sidOut[0] !== null) capsBuf.writeBigUInt64LE(BigInt(koffi.address(sidOut[0])), 0)
  capsBuf.writeBigUInt64LE(0n, 8)
  capsBuf.writeUInt32LE(0, 16)
  capsBuf.writeUInt32LE(0, 20)
  attributeApplied =
    UpdateProcThreadAttribute(attributes, 0, BigInt(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES), capsBuf, BigInt(24), null, null) !== 0
      ? 'ok'
      : `failed(${GetLastError()})`
}

/* 输出句柄：父进程建，子进程写 —— AppContainer 不需要任何路径权限 */
const inheritable = {
  nLength: koffi.sizeof(SECURITY_ATTRIBUTES),
  lpSecurityDescriptor: null,
  bInheritHandle: 1,
}
const outHandle = CreateFileW(outPath, GENERIC_WRITE, FILE_SHARE_ALL, inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)
const errHandle = CreateFileW(errPath, GENERIC_WRITE, FILE_SHARE_ALL, inheritable, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, null)

/*
 * HANDLE_LIST：只把 stdout/stderr 两个句柄继承下去。
 *
 * 不加这条时，父进程里任何**可继承**句柄子进程都能拿到（日志文件、socket）——
 * 那是真实的逃逸面：写日志、用已有连接发数据都不需要打开新文件。
 *
 * 位置有讲究：属性列表在句柄之前就建好了（count = 2），这一条在句柄之后补 ——
 * 加属性的顺序无所谓，只要都在 CreateProcess 之前即可。
 */
let handlesListed = 'skipped'
if (attributes !== null) {
  const pointerSize = koffi.sizeof('void *')
  const handleList = Buffer.alloc(pointerSize * 2)
  handleList.writeBigUInt64LE(BigInt(koffi.address(outHandle)), 0)
  handleList.writeBigUInt64LE(BigInt(koffi.address(errHandle)), pointerSize)
  handlesListed =
    UpdateProcThreadAttribute(
      attributes, 0, BigInt(PROC_THREAD_ATTRIBUTE_HANDLE_LIST), handleList, BigInt(handleList.length), null, null,
    ) !== 0
      ? 'listed'
      : `failed(${GetLastError()})`
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

const report = {
  ok: created !== 0,
  network: withAppContainer ? 'blocked' : 'allowed',
  granted: grantedStatus,
  handles: handlesListed,
  attribute: attributeApplied,
}

/*
 * `--stream`：后台作业用。
 *
 * 作业要"活过这条命令"，所以 worker 不能像前台那样把输出攒完再吐一次 ——
 * 那样 `npm run dev` 的日志永远看不到。这里改成**边跑边把子进程的输出转发出去**：
 * 子进程仍然写那两个文件（句柄继承不变），worker 循环里把新增的字节泵到自己的
 * stdout/stderr，作业注册表照常 pipe 它。
 *
 * 这样后台作业也能享受 AppContainer 的断网与写隔离，而且 `job_kill` 杀的是 worker，
 * worker 的 job 句柄关闭 → `KILL_ON_JOB_CLOSE` 连带杀掉整棵树。
 */
const streamMode = argv.includes('--stream')
let pumpOutOffset = 0
let pumpErrOffset = 0
function pump() {
  if (!streamMode) return
  for (const item of [
    { file: outPath, offset: () => pumpOutOffset, set: (value) => (pumpOutOffset = value), sink: process.stdout },
    { file: errPath, offset: () => pumpErrOffset, set: (value) => (pumpErrOffset = value), sink: process.stderr },
  ]) {
    try {
      const size = statSync(item.file).size
      const from = item.offset()
      if (size <= from) continue
      const fd = openSync(item.file, 'r')
      const buffer = Buffer.alloc(Math.min(size - from, 1024 * 1024))
      readSync(fd, buffer, 0, buffer.length, from)
      closeSync(fd)
      item.sink.write(buffer)
      item.set(from + buffer.length)
    } catch {
      /* 文件还没建出来 / 已删除：下一次再试 */
    }
  }
}

if (created === 0) {
  report.error = GetLastError()
  process.stdout.write(`${JSON.stringify(report)}\n`)
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}

const hProcess = infoBuf.readBigUInt64LE(0)
report.pid = infoBuf.readUInt32LE(16)
if (attributes !== null) DeleteProcThreadAttributeList(attributes)

/* ① Job：创建后挂载（属性列表里带 Job 会让 node 崩在 InitializeOncePerProcess） */
const job = CreateJobObjectW(null, null)
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
const limitsSet =
  job !== null && SetInformationJobObject(job, JobObjectExtendedLimitInformation, limits, koffi.sizeof(EXTENDED_LIMIT)) !== 0
const assigned = job !== null && AssignProcessToJobObject(job, hProcess) !== 0
report.job = assigned ? 'assigned' : `failed(${GetLastError()})`
if (!limitsSet) report.jobLimits = 'not-set'

/* ② 等结束：墙钟超时 + 写字节轮询 */
const timeoutMs = numOf('--timeout-ms', 120_000)
const maxWriteBytes = numOf('--max-write-mb', 512) * 1024 * 1024
const startedAt = Date.now()
let killedFor
let writeBytes = 0

const accountingBuf = Buffer.alloc(96)
const sampleWriteBytes = () => {
  if (!assigned) return 0
  const ok = QueryInformationJobObject(job, JobObjectBasicAndIoAccountingInformation, accountingBuf, accountingBuf.length, null)
  return ok !== 0 ? Number(accountingBuf.readBigUInt64LE(48 + 32)) : 0
}

/*
 * 轮询间隔自适应：前 2 秒用 10 ms（突发写最可能发生在这段），之后退到 50 ms。
 *
 * 为什么不能只靠轮询：Job Object **没有磁盘配额**，"写超限"永远是事后发现。
 * NTFS 按 SID 的硬配额才是正解，但 `fsutil quota` 需要管理员
 * （实测 `fsutil quota query C:` 直接 Access denied）。所以这里做两件事：
 *   · 窗口从 50 ms 缩到 10 ms（突发写被抓住的概率提高约 5 倍）
 *   · 长命令退避，避免 10 ms 轮询吃满 CPU
 * 硬配额怎么做见 `npm run sandbox:quota`。
 */
const pollMs = () => (Date.now() - startedAt < 2000 ? 10 : 50)
while (WaitForSingleObject(hProcess, pollMs()) === WAIT_TIMEOUT) {
  pump()
  writeBytes = sampleWriteBytes()
  if (writeBytes > maxWriteBytes) {
    /*
     * 写字节超限：**杀整棵树**，不是只杀直接子进程 ——
     * "写盘填满"通常是子进程在写，留下它等于没拦。
     */
    if (job !== null) TerminateJobObject(job, 1)
    killedFor = 'write-bytes'
    break
  }
  if (Date.now() - startedAt > timeoutMs) {
    if (job !== null) TerminateJobObject(job, 1)
    killedFor = 'timeout'
    break
  }
}

WaitForSingleObject(hProcess, 10_000)
const exitCode = [0]
GetExitCodeProcess(hProcess, exitCode)
CloseHandle(hProcess)
writeBytes = sampleWriteBytes()

report.exitCode = exitCode[0]
if (killedFor !== undefined) report.killedFor = killedFor
if (assigned) report.writeBytes = writeBytes
if (assigned && writeBytes > maxWriteBytes) report.exceededWriteBytes = true
report.stdout = existsSync(outPath) ? readFileSync(outPath, 'utf8').slice(0, 2000) : ''
report.stderr = existsSync(errPath) ? readFileSync(errPath, 'utf8').slice(0, 2000) : ''

if (job !== null) CloseHandle(job)
CloseHandle(outHandle)
CloseHandle(errHandle)

if (streamMode) {
  /* 最后再泵一次把尾巴吐干净，然后按子进程的退出码结束 —— 不打印 JSON */
  pump()
  rmSync(dir, { recursive: true, force: true })
  process.exit(exitCode[0] ?? 0)
}

process.stdout.write(`${JSON.stringify(report)}\n`)
rmSync(dir, { recursive: true, force: true })
