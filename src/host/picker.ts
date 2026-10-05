/**
 * 目录选择 —— **能力**（capability），不是「一个方法」。
 *
 * ## 为什么是这个形状
 *
 * 这一层是从 DSH 学来的，而它的洞察是：两种后端**交互形态不同，不只是机制不同**。
 *
 *   · `native` —— 在**宿主的显示器上**开一个系统对话框。
 *   · `browse` —— 提供「列目录」的原语，由**应用内的浏览器**来画。
 *
 * 后者的存在理由很具体：**系统对话框开在守护进程那台机器的屏幕上**。
 * 如果操作者是通过 SSH 端口转发、或者从局域网另一台机器打开界面的，
 * 他**根本看不见那个框** —— 点了「添加工作区」什么都不会发生，
 * 而服务端其实正开着框在等人点。
 *
 * 那时候失败的不是机制，是**形态**：需要一个能在浏览器里画的目录浏览器。
 *
 * ## 三个照搬的决定
 *
 * **① 启动时定一次。** 采样一次宿主事实 → 得出一个 kind，此后整个服务生命周期
 *    不变。消费者可以安全地缓存 `capability()` 的结果。
 *
 * **② 判据是「操作者能不能看见宿主桌面」。** 对我们是两条：
 *      · 绑定必须是回环 —— 守护进程**始终**拒绝非回环绑定，所以这条永远成立
 *      · 不能是通过 SSH 启动的 —— 那条路上系统框够不到
 *    再加一条平台前提：native 目前只有 Windows 实现。
 *
 * **③ 未知 kind 的既定默认是「把这个入口藏起来」，不是让它失败。**
 *    「点了没反应」是最糟的形态 —— 用户不知道是坏了、还是自己没有权限。
 *    藏起来至少是诚实的。
 */

export type PickerKind = 'native' | 'browse'

export interface PickerCapability {
  kind: PickerKind
  /** 给人看的说明。界面可以拿它当提示，排查时也有用 */
  reason: string
}

/**
 * 是不是通过 SSH 会话启动的。
 *
 * 三个变量任一个存在就够 —— 它们是 sshd 注入的，不需要额外探测：
 *   SSH_CONNECTION  客户端与服务器的地址端口
 *   SSH_CLIENT      同上（较老的形式）
 *   SSH_TTY         分配的伪终端
 */
function launchedThroughSsh(env: NodeJS.ProcessEnv): boolean {
  return (
    (env['SSH_CONNECTION'] ?? '') !== '' ||
    (env['SSH_CLIENT'] ?? '') !== '' ||
    (env['SSH_TTY'] ?? '') !== ''
  )
}

/**
 * 定这一次启动用哪个后端。
 *
 * 纯函数，**没有副作用** —— 采样一次、算一次、之后不再变。
 * 这样它可测：给定一组宿主事实，答案唯一。
 */
export function resolvePickerKind(options: {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
} = {}): PickerCapability {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env

  if (platform !== 'win32') {
    return {
      kind: 'browse',
      reason: `原生目录对话框目前只有 Windows 实现（当前是 ${platform}）`,
    }
  }

  if (launchedThroughSsh(env)) {
    /*
     * 这条是这一层存在的**主要理由**。
     *
     * SSH 转发下，守护进程跑在远端、界面在本地浏览器里。系统对话框会开在
     * **远端那台机器的屏幕上** —— 而操作者坐在另一台机器前。
     * 他会看到「点了没反应」，实际上有人在等他在看不见的框里点一下。
     */
    return {
      kind: 'browse',
      reason: '这次会话是通过 SSH 启动的 —— 系统对话框开在远端屏幕上，你够不到',
    }
  }

  /*
   * ★ 本机 Windows 桌面 → **native**。
   *
   * ⚠️ 这条结论**翻过两次**，两次都是实测推翻的，写清楚免得下次再翻：
   *
   * **第一次**（第一条结论）：本机 → native。想当然，没验证。
   *
   * **第二次**：改成 browse。因为实测发现框**起来了但藏在别的窗口后面** ——
   * 后台守护进程没有前台权限，Windows 的前台锁不允许它抢前台。当时用的是
   * PowerShell + WinForms 的 `FolderBrowserDialog`（**老式** `SHBrowseForFolder`
   * 那一系），并且照 DSH 合成了一次 Alt 按下抬起，**实测无效**：
   * 进程挂着整整 300 秒超时、没人能点到。
   *
   * **第三次（现在）**：改回 native，因为找到了真正的差别 —— **不是 Alt，是对话框本身**。
   *
   * DSH 用的是**现代 COM `IFileOpenDialog`**（Vista 起有，会自己激活）；
   * 我用的是老式的、依赖 owner 的 z 序。把载体从 PowerShell 换成
   * **Node 子进程 + koffi 直接调 COM**（见 `tools/dialog-worker.mjs`），
   * 换成现代对话框之后**实测到前台了**：
   *
   *     node.exe (pid 14648) "#32770" "MVS"     ← 自有进程持有的原生对话框
   *     focused_element: { class_name: "Edit", name: "文件夹:" }
   *
   * 焦点落在框内那个输入框上 —— 只有对话框处于活动状态时才会这样。
   *
   * 所以：**能做出来，也能到前台。** 而它比自己画的浏览器好：
   * 盘符、路径输入、网络位置、最近位置都是系统给的，不用我们一个个补
   * （「此电脑」那一层就是我为了补盘符才加的）。
   */
  return { kind: 'native', reason: '本机桌面会话 —— 用系统自带的文件夹对话框（现代 COM IFileOpenDialog）' }
}
