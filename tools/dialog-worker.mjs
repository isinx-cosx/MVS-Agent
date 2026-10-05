/**
 * Windows「选择文件夹」对话框 —— **Node 子进程 + koffi 直接调 COM**。
 *
 * 这是 `@deepseek-ai/dsh-host-directory-picker-native/lib/worker.cjs` 的移植。
 * 为什么值得移植：我们原来用 PowerShell + WinForms 的 `FolderBrowserDialog`
 * （**老式**对话框），它在后台守护进程里**抢不到前台** —— 实测框起来了、
 * 却藏在别的窗口后面，用户点不到。
 *
 * DSH 用的是**现代 COM `IFileOpenDialog`**（Vista 起就有），并在 `Show` 之前
 * 合成一次 Alt 按下抬起。它的注释明确说这样**能到前台**：
 *
 *     A background host ... leaves this process without foreground rights, so
 *     runFolderDialog synthesizes an Alt press immediately before Show and the
 *     dialog then activates as foreground.
 *
 * 差别很可能就在对话框本身：现代那个会自己激活，老式的依赖 owner 的 z 序。
 *
 * ## 为什么是子进程而不是 worker 线程
 *
 * 抄 DSH 的理由：`Show` 是模态的、会一直阻塞，放在宿主进程里会把事件循环卡死；
 * 而原生 FFI 万一出错，子进程崩掉不会带走守护进程。
 *
 * ## 和 DSH 的一处**有意偏离**：结果用文件传，不用 IPC
 *
 * DSH 走 `process.send`。但本环境里**命名管道是被挡的**（见项目里那条
 * 「管道会同步抛 EPERM」的记录），而 Node 的 IPC 通道在 Windows 上就是命名管道。
 * 所以这里改成「把结果写进 `--out` 指定的文件、宿主读文件」——
 * 结构（子进程 + 阻塞 Show + 结构化回报）一样，只是载体换成一定会成功的那种。
 *
 * ## 用法
 *
 *     node tools/dialog-worker.cjs --title "选择工作区目录" --out <结果文件>
 *
 * 结果文件内容是 `{kind:'done',path}` 或 `{kind:'done',path:null}`（取消）
 * 或 `{kind:'error',message}`。
 */

import { writeFileSync } from 'node:fs'

/** IFileOpenDialog vtable 槽位（IUnknown 0-2，IModalWindow 3，IFileDialog 4+） */
const SLOT_RELEASE = 2
const SLOT_SHOW = 3
const SLOT_SET_OPTIONS = 9
const SLOT_SET_TITLE = 17
const SLOT_GET_RESULT = 20
/** IShellItem 的 `GetDisplayName` */
const SLOT_GET_DISPLAY_NAME = 5

const COINIT_APARTMENTTHREADED = 2
const CLSCTX_INPROC_SERVER = 1
const SIGDN_FILESYSPATH = -2147123200

/** `FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST`，和 DSH 一样是 104 */
const FOS_PICKFOLDERS = 0x20
const FOS_FORCEFILESYSTEM = 0x40
const FOS_PATHMUSTEXIST = 0x8
const OPTIONS = FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST

/** `VK_MENU`（Alt）与 `KEYEVENTF_KEYUP` */
const VK_MENU = 18
const KEYEVENTF_KEYUP = 2

/** 取消：`HRESULT_FROM_WIN32(ERROR_CANCELLED)` */
const HR_CANCELLED = -2147023673

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(name)
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback
}
const outPath = argOf('--out', null)
const title = argOf('--title', '选择文件夹')

if (outPath === null) {
  console.error('dialog-worker: 需要 --out <结果文件>')
  process.exit(2)
}

const write = (payload) => {
  try {
    writeFileSync(outPath, JSON.stringify(payload), 'utf8')
  } catch (error) {
    console.error('dialog-worker: 写不了结果文件：' + String(error?.message ?? error))
  }
}

/**
 * 解析 koffi。
 *
 * ## 为什么不是简单 `import('koffi')`
 *
 * 我们这个项目**没有 npm 依赖**（这是设计约束）。而 koffi 是原生 FFI 扩展，
 * 是唯一能从 Node 直接调 COM 的东西。所以按优先级找：
 *
 *   1. `MVS_KOFFI` 环境变量 —— 显式指定，部署时最可控
 *   2. 本项目的 `node_modules`（万一以后真的装了）
 *   3. DSH 的安装目录 —— 本机装了 DSH 时白拿一个
 *
 * 一个都找不到就**如实报错**，由上层回退到 `browse` 那套（页面内的浏览器）。
 * 悄悄降级是不行的：用户点了「添加工作区」而框没出来，比明确说「本机用不了
 * 原生框」更糟。
 */
async function loadKoffi() {
  const tried = []
  const candidates = []

  if (process.env.MVS_KOFFI !== undefined && process.env.MVS_KOFFI !== '') {
    candidates.push(process.env.MVS_KOFFI)
  }
  candidates.push('koffi')
  candidates.push('file:///C:/Program Files/DSH NEXT/resources/app/node_modules/koffi/index.cjs')

  for (const candidate of candidates) {
    tried.push(candidate)
    try {
      const loaded = await import(candidate)
      const koffi = loaded.default ?? loaded
      if (typeof koffi?.load === 'function') return koffi
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error('找不到 koffi（原生 FFI）。试过：' + tried.join(' / '))
}

/** 把一个 GUID 字符串编成 `CoCreateInstance` 要的 16 字节小端形式 */
function guidBytes(text) {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text)
  if (match === null) throw new Error(`GUID 形状不对：${text}`)
  const bytes = Buffer.alloc(16)
  bytes.writeUInt32LE(parseInt(match[1], 16), 0)
  bytes.writeUInt16LE(parseInt(match[2], 16), 4)
  bytes.writeUInt16LE(parseInt(match[3], 16), 6)
  Buffer.from(match[4] + match[5], 'hex').copy(bytes, 8)
  return bytes
}

const CLSID_FILE_OPEN_DIALOG = guidBytes('dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7')
const IID_IFILE_OPEN_DIALOG = guidBytes('d57c7288-d4ad-4768-be02-9d969532d960')

/**
 * 读一个 NUL 结尾的 UTF-16 分配。
 *
 * ⚠️ 不能用 `koffi.decode(..., 'str16')` 直接读那个地址：它期望的是
 * **指向字符串的指针变量**，而 `_Out_ void **` 给出来的是字符串地址本身。
 * DSH 也是这么处理的（`readUtf16`）—— 先造一个装着地址的 Buffer，再解引用。
 */
function readUtf16(koffi, address, pointerSize) {
  const pointer = Buffer.alloc(8)
  pointer.writeBigUInt64LE(BigInt(address))
  return koffi.decode(pointer.subarray(0, pointerSize), 'str16')
}

async function main() {
  const koffi = await loadKoffi()
  const ole32 = koffi.load('ole32.dll')
  const user32 = koffi.load('user32.dll')
  const pointerSize = koffi.sizeof('void *')

  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32'])
  const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', [])
  const coCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', [
    'void *', 'void *', 'uint32', 'void *', 'void *',
  ])
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *'])
  const keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr'])

  const protoShow = koffi.proto('int32 __stdcall DshDialogShow(void *self, void *owner)')
  const protoSetOptions = koffi.proto('int32 __stdcall DshDialogSetOptions(void *self, uint32 options)')
  const protoSetTitle = koffi.proto('int32 __stdcall DshDialogSetTitle(void *self, str16 title)')
  const protoGetResult = koffi.proto('int32 __stdcall DshDialogGetResult(void *self, _Out_ void **item)')
  const protoGetDisplayName = koffi.proto(
    'int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ void **name)',
  )
  const protoRelease = koffi.proto('uint32 __stdcall DshComRelease(void *self)')

  /** 把 COM 对象 `self` 的 vtable 第 `slot` 槽绑成可调用的函数 */
  const method = (self, slot, proto) => {
    const vtable = koffi.decode(self, 'void *')
    const fn = koffi.decode(vtable, slot * pointerSize, 'void *')
    return (...callArgs) => koffi.call(fn, proto, self, ...callArgs)
  }

  /*
   * ⚠️ DPI 感知：不做的话在缩放不是 100% 的屏幕上框会糊。
   * `SetThreadDpiAwarenessContext` 在不支持的系统上返回 NULL（而不是抛），
   * 所以往下逐个试就行 —— 这是外观问题，不是功能问题。
   */
  try {
    const setContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'void *', ['intptr'])
    for (const context of [-4, -3, -2]) {
      if (setContext(context) !== null) break
    }
  } catch {
    /* 老系统没有这个导出，忽略 */
  }

  const initialized = coInitializeEx(null, COINIT_APARTMENTTHREADED)
  if (initialized < 0) throw new Error(`CoInitializeEx 失败：HRESULT 0x${(initialized >>> 0).toString(16)}`)

  let dialog = null
  try {
    const out = Buffer.alloc(pointerSize)
    const created = coCreateInstance(
      CLSID_FILE_OPEN_DIALOG,
      null,
      CLSCTX_INPROC_SERVER,
      IID_IFILE_OPEN_DIALOG,
      out,
    )
    if (created < 0) {
      throw new Error(`CoCreateInstance(FileOpenDialog) 失败：HRESULT 0x${(created >>> 0).toString(16)}`)
    }
    dialog = koffi.decode(out, 'void *')

    const setOptions = method(dialog, SLOT_SET_OPTIONS, protoSetOptions)
    const setTitle = method(dialog, SLOT_SET_TITLE, protoSetTitle)
    const show = method(dialog, SLOT_SHOW, protoShow)
    const getResult = method(dialog, SLOT_GET_RESULT, protoGetResult)
    const release = method(dialog, SLOT_RELEASE, protoRelease)

    const setResult = setOptions(OPTIONS)
    if (setResult < 0) throw new Error(`SetOptions 失败：0x${(setResult >>> 0).toString(16)}`)
    const setTitleResult = setTitle(title)
    if (setTitleResult < 0) throw new Error(`SetTitle 失败：0x${(setTitleResult >>> 0).toString(16)}`)

    /*
     * ★★ 这一步是这个文件存在的理由。
     *
     * 后台宿主起的进程没有前台权限，而 Windows 的前台锁不允许它把窗口抢到前面——
     * 框会开在用户正在看的那个窗口**后面**，表现为「点了没反应」。
     *
     * 合成一次键盘输入事件会**授予前台权限**，紧接着的 Show 于是能正常激活。
     */
    keybdEvent(VK_MENU, 0, 0, 0)
    keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0)

    const shown = show(null)
    if (shown === HR_CANCELLED) {
      write({ kind: 'done', path: null })
      return
    }
    if (shown < 0) throw new Error(`Show 失败：0x${(shown >>> 0).toString(16)}`)

    const itemOut = [null]
    const gotItem = getResult(itemOut)
    if (gotItem < 0) throw new Error(`GetResult 失败：0x${(gotItem >>> 0).toString(16)}`)

    const item = itemOut[0]
    try {
      const nameOut = [null]
      const gotName = koffi.call(
        koffi.decode(koffi.decode(item, 'void *'), SLOT_GET_DISPLAY_NAME * pointerSize, 'void *'),
        protoGetDisplayName,
        item,
        SIGDN_FILESYSPATH,
        nameOut,
      )
      if (gotName < 0) throw new Error(`GetDisplayName 失败：0x${(gotName >>> 0).toString(16)}`)
      const path = readUtf16(koffi, nameOut[0], pointerSize)
      coTaskMemFree(nameOut[0])
      write({ kind: 'done', path })
    } finally {
      method(item, SLOT_RELEASE, protoRelease)()
    }

    release()
    dialog = null
  } finally {
    if (dialog !== null) {
      try {
        method(dialog, SLOT_RELEASE, protoRelease)()
      } catch {
        /* 已经放掉了 */
      }
    }
    coUninitialize()
  }
}

main().catch((error) => {
  write({ kind: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) })
  process.exitCode = 1
})
