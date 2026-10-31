/**
 * 探针 E2/E3：**受限令牌 + 低完整性**能不能建出来。
 *
 * 这不是最终实现，是那一步的**前提验证**：
 *
 *   1. `OpenProcessToken` 拿到自己的令牌
 *   2. `CreateRestrictedToken(WRITE_RESTRICTED)` —— 只限制写，保留用户 SID
 *   3. `SetTokenInformation(TokenIntegrityLevel, Low)` —— 降完整性级别
 *   4. `DuplicateTokenEx` 把受限令牌转成**主令牌**（下一步 CreateProcessAsUser 要用它）
 *
 * 每一步都要看到真实 HRESULT；失败在哪一步，就知道卡在哪儿。
 *
 * 用法：
 *
 *     node tools/sandbox-probe.mjs                  # 用自动找到的 koffi
 *     MVS_KOFFI=<path> node tools/sandbox-probe.mjs
 *
 * 输出一行 JSON：`{ ok, koffi, steps: { open, restrict, integrity, primary }, error? }`
 */

import { existsSync } from 'node:fs'

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

function hr(code) {
  return `0x${(code >>> 0).toString(16).padStart(8, '0')}`
}

const report = {
  ok: false,
  platform: process.platform,
  koffi: 'missing',
  steps: {},
  pointerSize: null,
  error: undefined,
}

if (process.platform !== 'win32') {
  report.error = '只在 Windows 上验证'
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.exit(1)
}

const koffi = await loadKoffi()
if (koffi === null) {
  report.error = `找不到 koffi；试过：${CANDIDATES.join(' / ')}`
  process.stdout.write(`${JSON.stringify(report)}\n`)
  process.exit(1)
}

report.koffi = 'loaded'
report.pointerSize = koffi.sizeof('void *')

const advapi = koffi.load('advapi32.dll')
const kernel = koffi.load('kernel32.dll')

/* TOKEN_MANDATORY_LABEL = { SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; } } */
const SID_AND_ATTRIBUTES = koffi.struct('SID_AND_ATTRIBUTES', {
  Sid: 'void *',
  Attributes: 'uint32',
})
const TOKEN_MANDATORY_LABEL = koffi.struct('TOKEN_MANDATORY_LABEL', {
  Label: SID_AND_ATTRIBUTES,
})

const OpenProcessToken = advapi.func('bool __stdcall OpenProcessToken(void *ProcessHandle, uint32 DesiredAccess, _Out_ void **TokenHandle)')
const CreateRestrictedToken = advapi.func(
  'bool __stdcall CreateRestrictedToken(void *ExistingTokenHandle, uint32 Flags, uint32 DisableSidCount, void *SidsToDisable, uint32 DeletePrivilegeCount, void *PrivilegesToDelete, uint32 RestrictedSidCount, void *SidsToRestrict, _Out_ void **NewTokenHandle)',
)
const DuplicateTokenEx = advapi.func(
  'bool __stdcall DuplicateTokenEx(void *ExistingToken, uint32 DesiredAccess, void *TokenAttributes, int32 ImpersonationLevel, int32 TokenType, _Out_ void **NewToken)',
)
const SetTokenInformation = advapi.func(
  'bool __stdcall SetTokenInformation(void *TokenHandle, int32 TokenInformationClass, TOKEN_MANDATORY_LABEL *TokenInformation, uint32 TokenInformationLength)',
)
const ConvertStringSidToSidW = advapi.func('bool __stdcall ConvertStringSidToSidW(str16 StringSid, _Out_ void **Sid)')
const GetCurrentProcess = kernel.func('void * __stdcall GetCurrentProcess()')



const TOKEN_ALL_ACCESS = 0xf01ff
const TOKEN_DUPLICATE = 0x0002
const TOKEN_QUERY = 0x0008
/** 只限制**写**访问 —— 这是"能跑工具链但写不出去"的关键标志 */
const WRITE_RESTRICTED = 0x0001
const SECURITY_IMPERSONATION = 2
const TOKEN_PRIMARY = 1
const TOKEN_INTEGRITY_LEVEL = 25
/** Low Mandatory Level */
const LOW_SID = 'S-1-16-4096'
/** SE_GROUP_INTEGRITY —— 这个属性让 SID 被当成完整性级别而不是普通组 */
const SE_GROUP_INTEGRITY = 0x00000020



try {
  const tokenOut = [null]
  const okOpen = OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, tokenOut)
  report.steps.open = okOpen ? 'ok' : `failed(${koffi.errno?.() ?? 'unknown'})`
  if (!okOpen) throw new Error('OpenProcessToken 失败')

  const restrictedOut = [null]
  const okRestrict = CreateRestrictedToken(tokenOut[0], WRITE_RESTRICTED, 0, null, 0, null, 0, null, restrictedOut)
  report.steps.restrict = okRestrict ? 'ok' : `failed(${koffi.errno?.() ?? 'unknown'})`
  if (!okRestrict) throw new Error('CreateRestrictedToken 失败')

  const sidOut = [null]
  const okSid = ConvertStringSidToSidW(LOW_SID, sidOut)
  report.steps.sid = okSid ? 'ok' : `failed(${koffi.errno?.() ?? 'unknown'})`
  if (!okSid) throw new Error('ConvertStringSidToSidW 失败')

  const label = { Label: { Sid: sidOut[0], Attributes: SE_GROUP_INTEGRITY } }
  const okIntegrity = SetTokenInformation(
    restrictedOut[0],
    TOKEN_INTEGRITY_LEVEL,
    label,
    koffi.sizeof(TOKEN_MANDATORY_LABEL),
  )
  report.steps.integrity = okIntegrity ? 'ok' : `failed(${koffi.errno?.() ?? 'unknown'})`

  const primaryOut = [null]
  const okPrimary = DuplicateTokenEx(
    restrictedOut[0],
    TOKEN_ALL_ACCESS,
    null,
    SECURITY_IMPERSONATION,
    TOKEN_PRIMARY,
    primaryOut,
  )
  report.steps.primary = okPrimary ? 'ok' : `failed(${koffi.errno?.() ?? 'unknown'})`

  report.ok =
    report.steps.open === 'ok' &&
    report.steps.restrict === 'ok' &&
    report.steps.integrity === 'ok' &&
    report.steps.primary === 'ok'
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error)
}

process.stdout.write(`${JSON.stringify(report)}\n`)
process.exitCode = report.ok ? 0 : 1

/* 让 lint 知道 existsSync 被用到（保留给以后"检查 koffi 文件存在"的分支） */
void existsSync
