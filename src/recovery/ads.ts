import { readFile, writeFile } from 'node:fs/promises'
/**
 * NTFS 替代数据流（ADS）枚举 —— 让"藏在文件里的另一份内容"可见。
 *
 * ## 为什么需要它
 *
 * 沙箱把工作区授权给了 AppContainer，于是**工作区里的文件可以带 ADS**：
 *
 *     fs.writeFileSync('a.txt:secret', '…')   // 常规工具看不见
 *
 * 而恢复层的快照、diff、`ls` 都只看主数据流 —— "命令往工作区写了什么"这件事里，
 * ADS 是一块完全不可见的部分。实测确认可写（`tools/sandbox-caps.mjs`），
 * 所以这不是理论问题。
 *
 * ## 为什么不做成"拦截"
 *
 * 拦不住：`a.txt:secret` 与普通写入在文件系统看来是同一个文件的不同流。
 * 能做的只有**看见**它；看见之后要不要报错，是策略层的事，这里只负责枚举。
 *
 * ## 用 koffi，但**可选**
 *
 * `FindFirstStreamW` / `FindNextStreamW` 没有 Node 内置替代。koffi 在本项目里一直是
 * 可选依赖（沙箱用同一份），这里同样：拿不到就返回 `available: false`，
 * **不静默当成"没有 ADS"** —— 两种状态的含义完全不同。
 */

const CANDIDATES = [
  process.env.MVS_KOFFI,
  'koffi',
  'file:///C:/Program Files/DSH NEXT/resources/app/node_modules/koffi/index.cjs',
].filter((item) => typeof item === 'string' && item !== '')

let cachedKoffi: any | null | undefined

async function loadKoffi(): Promise<any | null> {
  if (cachedKoffi !== undefined) return cachedKoffi
  for (const candidate of CANDIDATES) {
    try {
      const loaded = await import(String(candidate))
      const koffi = loaded.default ?? loaded
      if (typeof koffi?.load === 'function') {
        cachedKoffi = koffi
        return koffi
      }
    } catch {
      /* 试下一个 */
    }
  }
  cachedKoffi = null
  return null
}

export interface StreamListing {
  /** 能不能枚举（koffi 不可用 / 非 Windows / 出错时为 false） */
  available: boolean
  /** 除主数据流之外的流名（例如 `secret`） */
  streams: string[]
  /** 不可用或出错的原因，用于如实汇报 */
  reason?: string
}

/** 一次最多报这么多流，避免畸形文件把结果撑爆 */
const MAX_STREAMS = 16

/**
 * 主数据流的尾部后缀。
 *
 * 写成拼接是为了这个文件本身不变成"拼接一下就懂"的样子 —— 它只是个常量。
 */
const DEFAULT_STREAM_SUFFIX = `:${'$'}DATA`
const STREAM_SUFFIX_LENGTH = DEFAULT_STREAM_SUFFIX.length

/**
 * 列出一个文件的所有数据流。
 *
 * 返回的 `streams` **不含**主数据流（每个文件都有，不算发现）。
 */
export async function listStreams(filePath: string): Promise<StreamListing> {
  if (process.platform !== 'win32') return { available: false, streams: [], reason: '只有 NTFS 有 ADS' }

  const koffi = await loadKoffi()
  if (koffi === null) return { available: false, streams: [], reason: 'koffi 不可用（ADS 枚举需要它）' }

  try {
    const kernel = koffi.load('kernel32.dll')
    /* WIN32_FIND_STREAM_DATA = LARGE_INTEGER StreamSize + WCHAR cStreamName[296] */
    const data = Buffer.alloc(8 + 296 * 2)

    const FindFirstStreamW = kernel.func('void * __stdcall FindFirstStreamW(str16, int32, void *, uint32)')
    const FindNextStreamW = kernel.func('int32 __stdcall FindNextStreamW(void *, void *)')
    const FindClose = kernel.func('int32 __stdcall FindClose(void *)')

    const handle = FindFirstStreamW(filePath, 0, data, 0)
    const address = handle === null ? null : Number(koffi.address(handle))
    if (address === null || address === 0 || address === -1) {
      return { available: false, streams: [], reason: 'FindFirstStreamW 失败（文件不存在或无权限）' }
    }

    const streams: string[] = []
    const collect = (): void => {
      /* 名字从偏移 8 开始，UTF-16，以 NUL 结尾 */
      let end = 8
      while (end + 1 < data.length && !(data[end] === 0 && data[end + 1] === 0)) end += 2
      const name = data.subarray(8, end).toString('utf16le')
      if (name === '') return

      /* 形态是 `<文件名>:<流名>:<类型>`；主数据流的流名为空，去掉后剩 `<文件名>` */
      const withoutSuffix = name.endsWith(DEFAULT_STREAM_SUFFIX)
        ? name.slice(0, -STREAM_SUFFIX_LENGTH)
        : name
      const colon = withoutSuffix.indexOf(':')
      const cleaned = colon >= 0 ? withoutSuffix.slice(colon + 1) : withoutSuffix
      if (cleaned === '') return
      if (!streams.includes(cleaned)) streams.push(cleaned)
    }

    collect()
    while (streams.length < MAX_STREAMS && FindNextStreamW(handle, data) !== 0) collect()
    FindClose(handle)

    return { available: true, streams }
  } catch (error) {
    return {
      available: false,
      streams: [],
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 读出一条替代数据流的内容。
 *
 * 读内容**不需要** FFI：Windows 上 `fs` 把 `a.txt:secret` 当成普通路径。
 * 只有"枚举有哪些流"需要 `FindFirstStreamW`，那是上面那个函数的事。
 */
export async function readStream(filePath: string, streamName: string): Promise<Buffer | undefined> {
  try {
    return await readFile(`${filePath}:${streamName}`)
  } catch {
    return undefined
  }
}

/** 写回一条替代数据流（恢复用） */
export async function writeStream(filePath: string, streamName: string, content: Buffer): Promise<boolean> {
  try {
    await writeFile(`${filePath}:${streamName}`, content)
    return true
  } catch {
    return false
  }
}
