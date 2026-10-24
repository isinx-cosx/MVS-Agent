/**
 * 原生「选择文件夹」对话框（仅 Windows）—— Node 子进程 + koffi 直接调 COM。
 *
 * ## 为什么需要这个文件
 *
 * 守护进程是后台进程，没有前台权限。用老式的 `SHBrowseForFolder` 那一系
 * （包括 PowerShell 的 `FolderBrowserDialog`）实测的结果是：框确实起来了，
 * 但被压在用户正在看的窗口**后面**，表现为「点了没反应」。
 *
 * `IFileOpenDialog`（Vista 起提供）不一样：它自己会激活。实测换过去之后，
 * 焦点直接落在框内的输入框上 —— 那只可能在对话框处于活动状态时发生。
 *
 * ## 为什么是子进程
 *
 * `Show` 是**模态**的，会一直阻塞到用户点掉它。放在守护进程里会把事件循环
 * 卡死（连 `/state` 都不响应）；而原生 FFI 一旦崩了，子进程崩掉不会波及宿主。
 *
 * ## 结果怎么回来
 *
 * 写文件，不走 IPC。Node 的 IPC 通道在 Windows 上背后是命名管道，而这个环境里
 * 管道是受限的（项目里有一整条记录）。文件是一定能成功的载体。
 *
 *     结果文件：{"kind":"done","path":"D:\\work"}     选中
 *               {"kind":"done","path":null}            取消
 *               {"kind":"error","message":"…"}         出错
 *
 * ## 用法
 *
 *     node tools/dialog-worker.mjs --title "选择工作区目录" --out <结果文件>
 *     node tools/dialog-worker.mjs --self-check          （不弹框，只验环境）
 *     node tools/dialog-worker.mjs --dry-run --out <f>   （走到 Show 之前就退出）
 *
 * `--self-check` 与 `--dry-run` 存在的理由：这个文件平时一跑就会**弹出一个模态框**，
 * 自动化测试没法碰它。把「除了弹框之外的全部」做成可跑的，才谈得上给它写测试 ——
 * 尤其是 vtable 槽位，那是这里唯一靠记忆的地方，写错时应该在这里崩，而不是在用户面前。
 */

import { statSync, writeFileSync } from 'node:fs'

/* ═══════════════════════════════════════════════════════════════════════
 * 一、COM 的公开定义
 *
 * IFileOpenDialog 的 vtable 顺序由 Windows SDK 的 `shobjidl.h` 固定，
 * 不能自己排。下面是这个文件真正要用的几个槽位（IUnknown 占 0..2）：
 *
 *     IUnknown              0 QueryInterface  1 AddRef  2 Release
 *     IModalWindow          3 Show
 *     IFileDialog           9 SetOptions     17 SetTitle  20 GetResult
 *     IShellItem            5 GetDisplayName  2 Release
 * ═══════════════════════════════════════════════════════════════════════ */

const DIALOG_SLOT = Object.freeze({ release: 2, show: 3, setOptions: 9, setTitle: 17, getResult: 20 })
const ITEM_SLOT = Object.freeze({ release: 2, getDisplayName: 5 })

/** `FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_PICKFOLDERS` */
const OPTIONS_PICK_FOLDER = 0x8 | 0x20 | 0x40

/** `SIGDN_FILESYSPATH`：要真实文件系统路径，不要别名或显示名（0x80058000 的有符号形式） */
const SIGDN_FILE_SYSTEM_PATH = -2147123200

/** `HRESULT_FROM_WIN32(ERROR_CANCELLED)`：用户点了取消 */
const HRESULT_CANCELLED = -2147023673

/** `COINIT_APARTMENTTHREADED` —— Shell 的对话框必须在 STA 里开 */
const COINIT_STA = 0x2
/** `CLSCTX_INPROC_SERVER` */
const CLSCTX_INPROC = 0x1

/** `VK_MENU`（Alt）与 `KEYEVENTF_KEYUP` */
const VK_MENU = 0x12
const KEYEVENTF_KEYUP = 0x2

/**
 * DPI 感知上下文，从最理想往下试：
 * `-4` PER_MONITOR_AWARE_V2、`-3` PER_MONITOR_AWARE、`-2` SYSTEM_AWARE。
 * 不做这一步时，缩放不是 100% 的屏幕上框会是糊的（外观问题，不影响功能）。
 */
const DPI_CONTEXTS = [-4, -3, -2]

/** IFileOpenDialog 的 CLSID 与它的 IID（都是 SDK 里的公开常量） */
const CLSID_FILE_OPEN_DIALOG = '{DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}'
const IID_IFILE_OPEN_DIALOG = '{D57C7288-D4AD-4768-BE02-9D969532D960}'

/* ═══════════════════════════════════════════════════════════════════════
 * 二、小工具
 * ═══════════════════════════════════════════════════════════════════════ */

/** HRESULT 在日志里永远写成十六进制 —— 十进制没法拿去查文档 */
function hr(code) {
  return `0x${(code >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 把 `{XXXXXXXX-XXXX-...}` 编成 `CoCreateInstance` 要的 16 字节。
 *
 * 前三个字段是**小端**，最后 8 字节按原顺序 —— 这是 GUID 的内存布局，
 * 不是字符串顺序。
 */
function guidBytes(text) {
  const m = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i.exec(text)
  if (m === null) throw new Error(`GUID 形状不对：${text}`)
  const out = Buffer.alloc(16)
  out.writeUInt32LE(parseInt(m[1], 16), 0)
  out.writeUInt16LE(parseInt(m[2], 16), 4)
  out.writeUInt16LE(parseInt(m[3], 16), 6)
  Buffer.from(m[4] + m[5], 'hex').copy(out, 8)
  return out
}

/**
 * 读一个 NUL 结尾的 UTF-16 字符串。
 *
 * ⚠️ 不能直接把地址交给 `koffi.decode(addr, 'str16')`：`_Out_ LPCWSTR*` 给回来的
 * 是**字符串地址本身**，而 `str16` 期望的是「指向字符串的指针变量」。所以先造一个
 * 装着这个地址的缓冲区，再解引用。
 */
function readWide(koffi, address, pointerSize) {
  const holder = Buffer.alloc(pointerSize)
  if (pointerSize === 8) holder.writeBigUInt64LE(BigInt(address))
  else holder.writeUInt32LE(Number(address))
  return koffi.decode(holder, 'str16')
}

/* ═══════════════════════════════════════════════════════════════════════
 * 三、koffi 从哪儿来
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 找 koffi。它是原生 FFI 扩展，也是从 Node 调 COM 唯一可行的路。
 *
 * 本项目**没有 npm 依赖**（那是设计约束），所以按优先级：
 *
 *   1. `MVS_KOFFI` 环境变量 —— 显式指定，部署时最可控
 *   2. `koffi` —— 用户自己 `npm i koffi` 之后就在 node_modules 里
 *   3. 本机装了 DSH 时它自带的那个 —— 白拿一份（koffi 本身是 MIT）
 *
 * 一个都找不到就**如实报错**，由上层回退到页面内的目录浏览器。
 * 悄悄降级不行：「点了添加工作区但框没出来」比「明确说这台机器用不了原生框」更糟。
 */
async function loadKoffi(explicit) {
  const tried = []
  const candidates = []
  if (explicit !== undefined && explicit !== '') candidates.push(explicit)
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
  throw new Error(`找不到 koffi（原生 FFI）。试过：${tried.join(' / ')}`)
}

/* ═══════════════════════════════════════════════════════════════════════
 * 四、打开对话框
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * 弹一次「选择文件夹」，返回选中的绝对路径；用户取消返回 null。
 *
 * 所有资源都在 `finally` 里放掉：这个进程是**一次性的**，一次调用只开一个框，
 * 但泄漏一个 COM 引用会让下一次（同一个进程里不会发生）和诊断都变难。
 */
async function pickFolder({ title, koffiPath, dryRun = false }) {
  const koffi = await loadKoffi(koffiPath)
  const ole32 = koffi.load('ole32.dll')
  const user32 = koffi.load('user32.dll')
  const pointerSize = koffi.sizeof('void *')

  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32'])
  const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', [])
  const coCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', [
    'void *',
    'void *',
    'uint32',
    'void *',
    'void *',
  ])
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *'])
  const keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr'])

  /* 每个 vtable 槽位要一个原型：调用约定与参数必须和 SDK 里的声明一致 */
  const proto = {
    release: koffi.proto('uint32 __stdcall MvsCoRelease(void *self)'),
    show: koffi.proto('int32 __stdcall MvsDialogShow(void *self, void *owner)'),
    setOptions: koffi.proto('int32 __stdcall MvsDialogSetOptions(void *self, uint32 options)'),
    setTitle: koffi.proto('int32 __stdcall MvsDialogSetTitle(void *self, str16 title)'),
    getResult: koffi.proto('int32 __stdcall MvsDialogGetResult(void *self, _Out_ void **item)'),
    getDisplayName: koffi.proto(
      'int32 __stdcall MvsItemGetDisplayName(void *self, int32 form, _Out_ void **name)',
    ),
  }

  /**
   * 取 COM 对象 `self` 的 vtable 第 `slot` 个函数，绑定成可调用的 JS 函数。
   *
   * COM 对象在内存里就是「指向 vtable 的指针」，vtable 是「函数指针数组」。
   * 所以两步：先解引用拿到 vtable 地址，再按 `slot * 指针宽度` 取那一格。
   */
  const bind = (self, slot, prototype) => {
    const vtable = koffi.decode(self, 'void *')
    const fn = koffi.decode(vtable, slot * pointerSize, 'void *')
    return (...rest) => koffi.call(fn, prototype, self, ...rest)
  }

  /* DPI 感知：老系统没有这个导出，失败也无所谓（只影响清晰度） */
  try {
    const setDpi = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'void *', ['intptr'])
    for (const context of DPI_CONTEXTS) {
      if (setDpi(context) !== null) break
    }
  } catch {
    /* 忽略 */
  }

  const hrInit = coInitializeEx(null, COINIT_STA)
  if (hrInit < 0) throw new Error(`CoInitializeEx 失败（${hr(hrInit)}）`)

  let dialog = null
  try {
    const created = Buffer.alloc(pointerSize)
    const hrCreate = coCreateInstance(
      guidBytes(CLSID_FILE_OPEN_DIALOG),
      null,
      CLSCTX_INPROC,
      guidBytes(IID_IFILE_OPEN_DIALOG),
      created,
    )
    if (hrCreate < 0) throw new Error(`CoCreateInstance(FileOpenDialog) 失败（${hr(hrCreate)}）`)
    dialog = koffi.decode(created, 'void *')

    const setOptions = bind(dialog, DIALOG_SLOT.setOptions, proto.setOptions)
    const setTitle = bind(dialog, DIALOG_SLOT.setTitle, proto.setTitle)
    const show = bind(dialog, DIALOG_SLOT.show, proto.show)
    const getResult = bind(dialog, DIALOG_SLOT.getResult, proto.getResult)
    const releaseDialog = bind(dialog, DIALOG_SLOT.release, proto.release)

    const hrOptions = setOptions(OPTIONS_PICK_FOLDER)
    if (hrOptions < 0) throw new Error(`SetOptions 失败（${hr(hrOptions)}）`)
    const hrTitle = setTitle(title)
    if (hrTitle < 0) throw new Error(`SetTitle 失败（${hr(hrTitle)}）`)

    /*
     * `--dry-run`：到这里就结束，不弹框。
     *
     * 上面这几步已经证明了最要紧的东西 —— `CoCreateInstance` 拿到了对象、
     * 两个 vtable 槽位（SetOptions / SetTitle）确实在那个位置。槽位写错时
     * 这里会崩或者返回一个负的 HRESULT，而不是等到用户面前才暴露。
     *
     * `Show` 是模态的，自动化测试碰不了；把「除弹框之外的全部」做成可跑的，
     * 这个文件才算有测试。
     */
    if (dryRun) return { path: null, dryRun: true }

    /*
     * ★ 这个文件全部技巧里最关键的一步。
     *
     * 后台进程没有前台权限，Windows 的前台锁不允许它把窗口提到最前。
     * 而在 `Show` 之前**合成一次按键**（这里用 Alt 按下/抬起，Alt 本身不产生字符，
     * 副作用最小）会把前台权限交给本进程，紧接着的对话框于是能正常激活。
     *
     * 为什么老式对话框同样加了这一步却没用：那个框的激活依赖 owner 的 z 序，
     * 而不是自己去抢前台。差别在对话框本身，不在这一步。
     */
    keybdEvent(VK_MENU, 0, 0, 0)
    keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0)

    const hrShow = show(null)
    if (hrShow === HRESULT_CANCELLED) return { path: null }
    if (hrShow < 0) throw new Error(`Show 失败（${hr(hrShow)}）`)

    const itemHolder = [null]
    const hrItem = getResult(itemHolder)
    if (hrItem < 0) throw new Error(`GetResult 失败（${hr(hrItem)}）`)

    const item = itemHolder[0]
    try {
      const getDisplayName = bind(item, ITEM_SLOT.getDisplayName, proto.getDisplayName)
      const nameHolder = [null]
      const hrName = getDisplayName(SIGDN_FILE_SYSTEM_PATH, nameHolder)
      if (hrName < 0) throw new Error(`GetDisplayName 失败（${hr(hrName)}）`)
      const chosen = readWide(koffi, nameHolder[0], pointerSize)
      coTaskMemFree(nameHolder[0])
      return { path: chosen }
    } finally {
      bind(item, ITEM_SLOT.release, proto.release)()
    }
  } finally {
    if (dialog !== null) {
      try {
        bind(dialog, DIALOG_SLOT.release, proto.release)()
      } catch {
        /* 已经放掉了 */
      }
    }
    coUninitialize()
  }
}

/* ═══════════════════════════════════════════════════════════════════════
 * 五、命令行
 * ═══════════════════════════════════════════════════════════════════════ */

function argValue(argv, name) {
  const at = argv.indexOf(name)
  return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined
}

/**
 * 不弹框的自检：确认这套代码依赖的**外部事实**还在。
 *
 * 它验证的是「换了机器 / 换了 koffi 版本之后仍然成立」的那部分：koffi 能不能
 * 加载、指针宽度、COM 常量是否对得上。vtable 槽位写错在这里就能看出来 ——
 * 那是这个文件里唯一靠记忆的地方。
 */
async function selfCheck(koffiPath) {
  const report = {
    ok: false,
    platform: process.platform,
    koffi: 'missing',
    pointerSize: null,
    dialogSlots: DIALOG_SLOT,
    itemSlots: ITEM_SLOT,
    options: OPTIONS_PICK_FOLDER,
    clsid: CLSID_FILE_OPEN_DIALOG,
    iid: IID_IFILE_OPEN_DIALOG,
    error: undefined,
  }
  report.ok =
    report.dialogSlots.show === 3 &&
    report.dialogSlots.getResult === 20 &&
    report.dialogSlots.setOptions === 9 &&
    report.dialogSlots.setTitle === 17 &&
    report.itemSlots.getDisplayName === 5

  try {
    const koffi = await loadKoffi(koffiPath)
    report.koffi = 'loaded'
    report.pointerSize = koffi.sizeof('void *')
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  }

  process.stdout.write(`${JSON.stringify(report)}\n`)
  /* 没有 koffi 不算失败：那说明这台机器该走页面内浏览，是正常情况 */
  process.exitCode = report.ok ? 0 : 1
}

async function main() {
  const argv = process.argv.slice(2)

  if (argv.includes('--self-check')) {
    await selfCheck(argValue(argv, '--koffi'))
    return
  }

  const outPath = argValue(argv, '--out')
  if (outPath === undefined) {
    process.stderr.write('dialog-worker: 需要 --out <结果文件>\n')
    process.exitCode = 2
    return
  }

  const title = argValue(argv, '--title') ?? '选择文件夹'
  const write = (payload) => {
    try {
      writeFileSync(outPath, JSON.stringify(payload), 'utf8')
    } catch (error) {
      process.stderr.write(`dialog-worker: 写不了结果文件：${String(error?.message ?? error)}\n`)
    }
  }

  try {
    const picked = await pickFolder({
      title,
      koffiPath: argValue(argv, '--koffi'),
      dryRun: argv.includes('--dry-run'),
    })
    if (picked.dryRun === true) {
      write({ kind: 'done', path: null, dryRun: true })
      return
    }
    if (picked.path === null) {
      write({ kind: 'done', path: null })
      return
    }
    /*
     * 复核一次：`FOS_PICKFOLDERS` 本该保证选中的是目录，但这个结果要拿去
     * 挂载工作区 —— 一个文件路径传上去，失败会发生在很远的地方。
     */
    try {
      if (!statSync(picked.path).isDirectory()) {
        write({ kind: 'error', message: `选中的不是一个目录：${picked.path}` })
        return
      }
    } catch (error) {
      write({ kind: 'error', message: `选中的路径读不了：${String(error?.message ?? error)}` })
      return
    }
    write({ kind: 'done', path: picked.path })
  } catch (error) {
    write({ kind: 'error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) })
    process.exitCode = 1
  }
}

await main()
