/**
 * 最小探针：`ProcThreadAttributeJobList` 的两次调用到底该怎么写。
 *
 * 上一次直接接进 CreateProcess 得到的是 `0xC0000005`（访问违例）—— 说明参数
 * 传成了值而不是地址。这个探针只做三件事，跑通了才往下接：
 *
 *   1. `InitializeProcThreadAttributeList(NULL, 1, 0, &size)` —— 只为拿大小
 *   2. `InitializeProcThreadAttributeList(buf, 1, 0, &size)` —— 真建
 *   3. `UpdateProcThreadAttribute(buf, 0, JobList, &handle, sizeof(HANDLE), NULL, NULL)`
 *   4. `DeleteProcThreadAttributeList(buf)`
 *
 * 输出一行 JSON：每一步的结果与拿到的 size。
 */

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

const report = { ok: false, steps: {}, error: undefined }
const koffi = await loadKoffi()
if (koffi === null) {
  report.error = 'koffi 不可用'
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.exit(1)
}

try {
  const kernel = koffi.load('kernel32.dll')
  const InitializeProcThreadAttributeList = kernel.func(
    'bool __stdcall InitializeProcThreadAttributeList(void *pAttrList, uint32 dwAttributeCount, uint32 dwFlags, _Out_ uintptr *lpSize)',
  )
  const UpdateProcThreadAttribute = kernel.func(
    'bool __stdcall UpdateProcThreadAttribute(void *pAttrList, uint32 dwFlags, uintptr Attribute, void *lpValue, uintptr cbSize, void *lpPreviousValue, void *lpReturnSize)',
  )
  const DeleteProcThreadAttributeList = kernel.func('void __stdcall DeleteProcThreadAttributeList(void *pAttrList)')
  const CreateJobObjectW = kernel.func('void * __stdcall CreateJobObjectW(void *lpJobAttributes, str16 lpName)')
  const CloseHandle = kernel.func('bool __stdcall CloseHandle(void *hObject)')

  const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000d
  const pointerSize = koffi.sizeof('void *')

  /* ① 第一次：拿大小。传 NULL + 一个 out 标量（koffi 用 [0] 表示 out 参数） */
  const sizeOut = [0]
  const first = InitializeProcThreadAttributeList(null, 1, 0, sizeOut)
  report.steps.size = `call=${first} size=${sizeOut[0]}`
  if (sizeOut[0] <= 0) throw new Error('第一次调用没拿到大小')

  /* ② 第二次：真建。缓冲区比 size 大一点，避免 koffi 的边界计算差一格 */
  const buffer = Buffer.alloc(sizeOut[0] + 64)
  const size2 = [sizeOut[0] + 64]
  if (!InitializeProcThreadAttributeList(buffer, 1, 0, size2)) {
    throw new Error(`第二次调用失败（errno=${koffi.errno?.() ?? 'unknown'}）`)
  }
  report.steps.init = 'ok'

  /* ③ 把一个 job 句柄塞进属性列表 —— 注意 lpValue 是**指向句柄的指针** */
  const job = CreateJobObjectW(null, null)
  if (!job) throw new Error('CreateJobObjectW 失败')
  const handleBuffer = Buffer.alloc(pointerSize)
  const address = koffi.address(job)
  if (pointerSize === 8) handleBuffer.writeBigUInt64LE(BigInt(address))
  else handleBuffer.writeUInt32LE(Number(address))

  const updated = UpdateProcThreadAttribute(
    buffer,
    0,
    BigInt(PROC_THREAD_ATTRIBUTE_JOB_LIST),
    handleBuffer,
    BigInt(pointerSize),
    null,
    null,
  )
  report.steps.update = updated ? 'ok' : `failed(errno=${koffi.errno?.() ?? 'unknown'})`

  DeleteProcThreadAttributeList(buffer)
  report.steps.delete = 'ok'
  CloseHandle(job)

  report.ok = report.steps.init === 'ok' && report.steps.update === 'ok'
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
}

process.stdout.write(`${JSON.stringify(report)}\n`)
process.exitCode = report.ok ? 0 : 1
