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

export function killTree(child: Killable): void {
  const pid = child.pid
  if (pid === undefined) {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经退出了
    }
    return
  }

  if (process.platform === 'win32') {
    // stdio 必须是 ignore：本环境里 pipe 会**同步抛 EPERM**（见 command-tool 顶部注释），
    // 而这条路径上再抛一次错毫无意义。用 spawnSync 是因为 taskkill 很快，
    // 而 kill 路径本来就该是同步收尾的。
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }

  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // 组不存在（比如没开成组）就退回到只杀直接子进程
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经退出了
    }
  }
}

/** 给 `ChildProcess` 用的窄化版本，省得每个调用方都写一遍类型断言 */
export function killTreeOf(child: ChildProcess): void {
  killTree(child)
}
