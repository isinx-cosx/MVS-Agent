/**
 * 杀掉**整棵进程树**，而不只是直接子进程。
 *
 * ⚠️ 这是恢复层归属边界的一部分，不是顺手加的保险。
 *
 * 快照边界是「动作前 → 动作后」这个时间窗。只杀直接子进程的话，它派出去的
 * 孙进程会活下来继续写文件 —— 那些写入发生在 after 快照**之后**，于是既不属于
 * 本次事务的 diff，又会被算进**下一个**事务。结果是「撤销上一步」可能删掉或
 * 还原不属于它的东西：用户撤的是第 3 步，动的却是第 4 步留下的痕迹。
 *
 * 两个平台的机制不能互相替代，所以分开写：
 *  - POSIX：子进程需用 `detached: true` 单独开组，负 pid 打的是整组。
 *  - Windows：Node 根本没有进程组信号（`process.kill(-pid)` 不可用），
 *    `taskkill /T` 才会沿父子关系把树砍掉。
 *
 * 失败一律吞掉：调用这条路径时目标进程可能已经自己退出了。在这里再抛一个错误
 * 出来，只会把「命令超时」变成「命令超时 + 另一个异常」。
 *
 * 单独成一个模块是因为现在有两个调用方：超时/取消的 `run_command`，
 * 以及后台作业的 `kill_job`。**两处必须是同一套逻辑** —— 一处改了另一处没改，
 * 就会出现「前台命令杀得干净、后台作业留下孤儿」这种最难查的不一致。
 */

import { spawnSync, type ChildProcess } from 'node:child_process'

export interface Killable {
  pid?: number | undefined
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface KillOutcome {
  /** 至少直接子进程被杀了（整棵树是否干净是另一回事，见 `wholeTree`） */
  killed: boolean
  via: 'taskkill' | 'signal' | 'none'
  /** 用的手段能不能保证连孙进程一起收 */
  wholeTree: boolean
}

export function killTree(child: Killable): KillOutcome {
  const pid = child.pid
  if (pid === undefined) {
    return { killed: signalOnly(child), via: 'signal', wholeTree: false }
  }

  if (process.platform === 'win32') {
    /*
     * stdio 必须是 ignore：本环境里 pipe 会**同步抛 EPERM**（见 command-tool 顶部注释）。
     *
     * ⚠️ `timeout` 不是可选项：实测在受限环境里 `taskkill` 可能直接返回 1
     * （被沙箱拒绝），也可能挂住。挂住时没有 timeout 就等于把守护进程一起挂死
     * —— 而这条路径通常正发生在超时/取消的收尾阶段。
     */
    const probe = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 5_000,
    })

    if (probe.status === 0) return { killed: true, via: 'taskkill', wholeTree: true }

    /*
     * taskkill 失败（被拒绝 / 权限不足 / 进程已经退出）时的兜底：
     * 直接 `TerminateProcess` 至少能收掉直接子进程。
     *
     * 这不是替代品 —— 孙进程会留下。所以 `wholeTree: false` 必须被调用方看见。
     */
    return { killed: signalOnly(child), via: 'signal', wholeTree: false }
  }

  try {
    process.kill(-pid, 'SIGKILL')
    return { killed: true, via: 'signal', wholeTree: true }
  } catch {
    return { killed: signalOnly(child), via: 'signal', wholeTree: false }
  }
}

/** 只杀直接子进程。失败（进程已退出）不算错 */
function signalOnly(child: Killable): boolean {
  try {
    child.kill('SIGKILL')
    return true
  } catch {
    return false
  }
}

/** 给 `ChildProcess` 用的窄化版本，省得每个调用方都写一遍类型断言 */
export function killTreeOf(child: ChildProcess): KillOutcome {
  return killTree(child)
}
