/**
 * 原生目录选择器 —— **起一个 Node 子进程去开 Windows 自带的文件夹对话框**。
 *
 * ## 为什么是这个形状（而不是 PowerShell）
 *
 * 我一开始用 PowerShell + WinForms 的 `FolderBrowserDialog`。那个框**起来了**
 * （实测 `powershell.exe "浏览文件夹" [window_id: 460110]`），但它在用户正看着的
 * 窗口**后面** —— 后台守护进程没有前台权限，Windows 的前台锁不允许它把窗口
 * 抢到前面。用户看到的是「点了没反应」，而框一直在那里等着。
 *
 * 我照 DSH 的做法合成过一次 Alt 按下抬起（那会授予前台权限），**用老式对话框
 * 实测无效**：进程挂着整整 300 秒超时、没人能点到。
 *
 * 后来读了 DSH 的实现才看清差别不在 Alt，而在**对话框本身**：
 *
 *     它用现代 COM `IFileOpenDialog`（Vista 起有，会自己激活）
 *     我用的是老式 `SHBrowseForFolder` 那一系（依赖 owner 的 z 序）
 *
 * 换成现代对话框之后**实测到前台了** —— 焦点落在框内「文件夹:」那个输入框上，
 * 而那只有对话框处于活动状态时才会发生。
 *
 * ## 结构照搬 DSH
 *
 *     Node 子进程  ← 不是 worker 线程：`Show` 是模态的会阻塞，
 *                    放宿主里会卡死事件循环；原生 FFI 出错也不至于带走守护进程
 *     子进程里    ← koffi 直接调 COM，Show 之前合成一次 Alt
 *     结果        ← 写进文件（见下）
 *
 * ## 和 DSH 的一处**有意偏离**：结果走文件，不走 IPC
 *
 * DSH 用 `process.send`。但本环境里**命名管道是被挡的**（项目里那条
 * 「管道会同步抛 EPERM」的记录），而 Node 的 IPC 通道在 Windows 上正是命名管道。
 * 用文件是这里一定会成功的载体，而结构（子进程 + 结构化回报）不变。
 *
 * ## 没有 koffi 怎么办
 *
 * 如实报错，由上层回退到 `browse`（页面内的目录浏览器）。
 * **不静默降级** —— 用户点了「添加工作区」而框没出来，比明确告诉他
 * 「这台机器上用不了原生框」更糟。
 */

import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * worker 的位置。
 *
 * 从 `src/host/` 往上三级是仓库根（`src/host/directory-picker.ts` → `src/host` →
 * `src` → 根）。用 `fileURLToPath` 而不是 `__dirname`：这个项目是 ESM。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.resolve(HERE, '..', '..', 'tools', 'dialog-worker.mjs')

export interface PickResult {
  /** 选中的绝对路径；取消时为 null */
  path: string | null
  cancelled: boolean
  /** 出错时的人话说明。**要能直接给用户看** */
  error?: string
}

/** 同一时刻只允许一个选择框。两个叠在一起会让人以为第一个坏了 */
let inFlight: Promise<PickResult> | null = null

/** 用户可能离开座位。给一个足够长但不是无限的上限 */
const PICK_TIMEOUT_MS = 5 * 60 * 1000

export async function pickDirectory(title = '选择工作区目录'): Promise<PickResult> {
  if (process.platform !== 'win32') {
    return { path: null, cancelled: false, error: '原生目录选择器目前只实现了 Windows' }
  }

  if (!existsSync(WORKER)) {
    return {
      path: null,
      cancelled: false,
      error: `找不到原生选择器的工作进程：${WORKER}`,
    }
  }

  /*
   * 已经有一个在等结果 → **共用它**，不要拒绝。
   *
   * ⚠️ 我第一版是拒绝的：`{ error: '已经有一个选择框开着，请先处理它' }`。
   * 那是个**死胡同**：那个框可能开在用户看不见的地方（正是当时的情况），
   * 于是他既看不到框、也没法再开一个，只能重启守护进程。
   * 共用同一个 promise 至少让第二次点击有结果。
   */
  if (inFlight !== null) return await inFlight

  const run = (async (): Promise<PickResult> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-picker-'))
    const outPath = path.join(dir, 'result.json')
    const errPath = path.join(dir, 'stderr.log')

    try {
      /*
       * ⚠️ **stderr 接到文件，不是管道。**
       *
       * 本环境里管道会同步抛 EPERM（见文件头），所以不能收进变量 ——
       * 但也不能就这样丢掉：丢掉的后果是失败只剩一个退出码，
       * 而 koffi / COM 的真实报错全在 stderr 上。
       */
      const errFd = openSync(errPath, 'w')
      const child = spawn(process.execPath, [WORKER, '--title', title, '--out', outPath], {
        stdio: ['ignore', 'ignore', errFd],
        // 子进程不该弹控制台窗口
        windowsHide: true,
      })
      closeSync(errFd)

      /*
       * ⚠️ 记下**为什么结束的**。
       *
       * spawn 失败和 5 分钟超时是两件排查方向完全不同的事，而它们原来回的是
       * 同一句话（「没能给出结果」）—— 那句话我看了一轮，无从下手。
       * 这一课我在旧版（PowerShell 版）就学过，重写时不该丢掉。
       */
      let reason = '未知'
      const exitCode = await new Promise<number | null>((resolve) => {
        let settled = false
        const finish = (code: number | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(code)
        }
        child.on('error', (err) => {
          reason = `启动失败：${err instanceof Error ? err.message : String(err)}`
          finish(null)
        })
        child.on('close', (code) => finish(code))
        const timer = setTimeout(() => {
          reason = `等满 ${PICK_TIMEOUT_MS / 1000} 秒`
          try {
            child.kill('SIGKILL')
          } catch {
            /* 已经退出了 */
          }
          finish(null)
        }, PICK_TIMEOUT_MS)
      })

      if (exitCode === null) {
        return { path: null, cancelled: false, error: `选择器没能给出结果 —— ${reason}` }
      }

      // worker 无论成功失败都会写结果文件；写不出来才去看 stderr
      let raw: string | null = null
      try {
        raw = await readFile(outPath, 'utf8')
      } catch {
        raw = null
      }

      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as { kind?: string; path?: string | null; message?: string }
          if (parsed.kind === 'done') {
            return parsed.path == null || parsed.path === ''
              ? { path: null, cancelled: true }
              : { path: parsed.path, cancelled: false }
          }
          if (parsed.kind === 'error') {
            return { path: null, cancelled: false, error: firstLines(parsed.message ?? '未知错误') }
          }
        } catch {
          /* 落到下面的兜底 */
        }
      }

      let detail = ''
      try {
        detail = (await readFile(errPath, 'utf8')).trim()
      } catch {
        /* 没有 stderr 就算了 */
      }
      return {
        path: null,
        cancelled: false,
        error: `选择器异常退出（码 ${exitCode}）${detail === '' ? '，且没有错误输出' : `：${firstLines(detail)}`}`,
      }
    } catch (err) {
      return { path: null, cancelled: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })()

  inFlight = run
  try {
    return await run
  } finally {
    inFlight = null
  }
}

/**
 * 取错误的**前几行**。
 *
 * ⚠️ 不是后几行。Node 的栈是「真实错误在最前面」，后面全是 `at …` 调用帧；
 * PowerShell 的模板也堆在尾部。取尾部等于**恰好把有用的那行滤掉**。
 * 这个错我在这个文件里犯过一次，不想再犯。
 */
function firstLines(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('+') && !line.startsWith('at '))
    .slice(0, 3)
    .join(' / ')
}

