/**
 * 目录浏览后端 —— 浏览器里画的目录选择器。
 *
 * ## 它解决什么
 *
 * 系统对话框开在**守护进程那台机器的屏幕上**。通过 SSH、或者从别的机器打开
 * 界面时，操作者看不见那个框 —— 点了「添加工作区」什么都不会发生。
 * 这个后端把「列目录」做成 HTTP 原语，界面自己画，于是在哪台机器上都成立。
 *
 * ## 它只列目录，不列文件
 *
 * 工作区**就是**一个目录，所以列表里除了目录没有别的东西有用。
 * 顺带这也把暴露面收窄了一层：这个接口给不出任何文件内容，
 * 也给不出任何文件名。（后者不是安全边界 —— 守护进程本来就能读那些文件 ——
 * 但它让「这个接口能干什么」一眼可见。）
 *
 * ## ⚠️ 它能读任意路径，这是有意的
 *
 * `listDirectory` 接受**任意绝对路径**，不限制在工作区内。理由：
 * 选工作区这个动作**本来就发生在工作区之外** —— 你要挑的就是一个新的根。
 * 把它限制在现有工作区里，等于这个功能只能用一次。
 *
 * 这不算越权：守护进程以当前用户身份运行，本来就能读那些目录；
 * 而这条接口和其他所有接口一样在回环 + 令牌 + Host/Origin 三道围栏后面。
 */

import { readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 一层里最多列多少个子目录。防的是某些目录（比如 node_modules 的父目录）把响应撑爆 */
const MAX_ENTRIES = 2000

export interface BrowseEntry {
  /** 目录名（最后一段） */
  name: string
  /** 绝对路径 —— 界面点它就等于进这一层 */
  path: string
  /** `.` 开头。DSH 的浏览器默认把它们藏起来，给个开关才显示 */
  hidden: boolean
}

/**
 * 面包屑的一段。
 *
 * ⚠️ **DSH 的 `directoryPicker.list` 要求这个字段**，形状来自它生成出来的 zod：
 *
 *     crumbs: z.array(z.object({ name, path, hidden }))
 *     home:   z.string()
 *
 * 没有 `home`/`crumbs` 的话，它的目录浏览器会拿到一个**缺字段的对象** ——
 * 而 zod 校验失败的表现是界面上某个区域空白，不是一句清楚的报错。
 */
export interface BrowseCrumb {
  name: string
  path: string
  hidden: boolean
}

export interface BrowseListing {
  /** 规范化之后的绝对路径 */
  path: string
  /** 上一级。已经是根（比如盘符）时为 null */
  parent: string | null
  /** 可跳转的根：Windows 上是各盘符 */
  roots: string[]
  /** 用户主目录 —— DSH 的浏览器用它做「主目录」那一跳 */
  home: string
  /** 从根到当前层的祖先链，含当前层 —— DSH 用它画面包屑 */
  crumbs: BrowseCrumb[]
  entries: BrowseEntry[]
  /** 截断了没有。截断了界面要说出来，否则用户会以为「就这么多」 */
  truncated: boolean
}

export interface BrowseFailure {
  code: 'not_found' | 'not_a_directory' | 'denied' | 'unknown'
  message: string
}

/**
 * 可跳转的根。
 *
 * Windows 上列盘符；其它平台就 `/`。
 * 盘符从 `path.parse(root)` 得不到，只能枚举 —— 而枚举不存在的盘符会挂住，
 * 所以这里**用已知存在的那个**：`process.cwd()` 的根，加上常见盘符里的候选，
 * 逐个 stat 一次（异步、并行、失败即忽略）。
 */
async function listRoots(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/']

  const candidates = ['C:', 'D:', 'E:', 'F:', 'G:']
  const checks = await Promise.all(
    candidates.map(async (drive) => {
      const root = `${drive}\\`
      try {
        await stat(root)
        return root
      } catch {
        return null
      }
    }),
  )
  return checks.filter((value): value is string => value !== null)
}

/**
 * 从根到 `target` 的祖先链（含 target 自己）。
 *
 * 用来画面包屑。Windows 上是 `C:\ › Users › fsafsafsa › Desktop`，
 * 类 Unix 上是 `/ › home › user › Desktop`。
 *
 * ⚠️ **正着走、不是倒着走**：`path.dirname` 一路往上再把结果反过来，
 * 在根那里会多出一段（`dirname('C:\\')` 还是 `C:\\`），得额外去重。
 * 从根往下拼没有这个问题，而且顺序天然就是面包屑的顺序。
 */
function buildCrumbs(target: string): BrowseCrumb[] {
  const parsed = path.parse(target)
  const crumbs: BrowseCrumb[] = []

  const rootPath = parsed.root
  crumbs.push({
    // 根那一段的名字：Windows 上用 `C:\`，类 Unix 上用 `/`
    name: rootPath,
    path: rootPath,
    hidden: false,
  })

  const rest = target.slice(rootPath.length)
  if (rest === '') return crumbs

  let current = rootPath
  for (const segment of rest.split(path.sep)) {
    if (segment === '') continue
    current = path.join(current, segment)
    crumbs.push({ name: segment, path: current, hidden: segment.startsWith('.') })
  }
  return crumbs
}

/**
 * 「此电脑」那一层：所有可跳转的盘。
 *
 * ## 为什么需要它
 *
 * DSH 那个浏览器的祖先链是从**路径的根**往上走的（它的 `ancestryCrumbs`），
 * Windows 上**没有盘符列表**。于是它只能：
 *
 *   · 从主目录往下走
 *   · 沿着面包屑退到 `C:\`
 *   · 或者点「编辑路径」手动敲一个路径
 *
 * 而 `D:\` 是 `C:\` 的**兄弟**，不是它的子目录 —— **点不到**。
 * 实测过：弹层里有 `主目录 / $HOME / [C: 的子目录]`，盘符入口一个都没有。
 * 用户的模型和项目都在 D 盘，这就是「加了工作区但选不到」的原因。
 *
 * ## 为什么是「此电脑」而不是「把 D:\ 塞进 C:\ 的列表」
 *
 * 后者更省事，但它**是假的** —— `D:\` 并不在 `C:\` 里面，
 * 面包屑会显示成 `C:\ › D:\`，而点进去之后又变成 `D:\`，前后矛盾。
 *
 * 「此电脑」是 **Windows 自己的模型**：所有盘的父级就是它。这样：
 *
 *     此电脑  →  C:\  D:\  E:\        （点 D:\ 进去）
 *     D:\     →  D:\ › models         （DSH 那边 home 不在链里，显示完整祖先）
 *
 * 前后一致，而且和资源管理器的说法一样。
 *
 * ## `path` 用空串
 *
 * 这一层在文件系统里**不存在**，所以没有一个"真"路径能代表它。用空串是
 * 因为它在两边都能自洽：
 *
 *   · 界面拿 `crumbs[0].name`（「此电脑」）显示，不显示 `path`
 *   · 从这一层点「此电脑」那个面包屑回来 → 又是空串 → 又是这一层
 *
 * ⚠️ 别改成 `'\\'` 之类的。DSH 自己的代码专门注释过：Windows 上 `\foo`
 * 这种「有根无盘」的形式 `isAbsolute` 为真，但**仍然会跟着进程当前盘走** ——
 * 那是个会随环境变的值，不能用来标识一个固定位置。
 */
async function listDrives(): Promise<BrowseListing> {
  const drives = await listRoots()
  return {
    path: '',
    parent: null,
    roots: drives,
    home: os.homedir(),
    crumbs: [{ name: '此电脑', path: '', hidden: false }],
    entries: drives.map((drive) => ({ name: drive, path: drive, hidden: false })),
    truncated: false,
  }
}

/**
 * 列一层目录。
 *
 * @param target - 绝对路径。**不做「必须在工作区内」的限制** —— 见文件头。
 *   空串表示「此电脑」那一层（见 `listDrives`）
 */
export async function listDirectory(target: string): Promise<BrowseListing | BrowseFailure> {
  // 空串 = 盘符列表。DSH 的浏览器不传 path 时走这里，点「此电脑」面包屑也走这里
  if (target === '') return await listDrives()

  const resolved = path.resolve(target)

  let info
  try {
    info = await stat(resolved)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { code: 'not_found', message: `没有这个路径：${resolved}` }
    if (code === 'EACCES' || code === 'EPERM') {
      return { code: 'denied', message: `没有权限读：${resolved}` }
    }
    return { code: 'unknown', message: `${code ?? '读取失败'}：${resolved}` }
  }

  if (!info.isDirectory()) {
    return { code: 'not_a_directory', message: `这不是一个目录：${resolved}` }
  }

  let names
  try {
    names = await readdir(resolved, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM') {
      return { code: 'denied', message: `没有权限读：${resolved}` }
    }
    return { code: 'unknown', message: `${code ?? '读取失败'}：${resolved}` }
  }

  /*
   * 只要目录。
   *
   * `withFileTypes` 给出的 `isDirectory()` 在 Windows 上对目录联结（junction）
   * 也是 true —— 那是我们想要的（用户确实能进去）。
   * 符号链接指向目录的情况它给的是 `isSymbolicLink()`，这里**跳过**：
   * 跟进去可能绕圈，而一个绕圈的目录浏览器会把用户困住。
   */
  const entries: BrowseEntry[] = []
  for (const dirent of names) {
    if (!dirent.isDirectory()) continue
    // 隐藏目录（`.` 开头）照列 —— 工作区放在隐藏目录里是常见的。
    // `hidden` 只是**标记**，由界面决定要不要显示（DSH 默认藏起来）。
    entries.push({
      name: dirent.name,
      path: path.join(resolved, dirent.name),
      hidden: dirent.name.startsWith('.'),
    })
  }

  entries.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  )

  const truncated = entries.length > MAX_ENTRIES
  const parent = path.dirname(resolved)
  // 到根时 `dirname` 会返回自己 —— 那就是「没有上一级」
  const atRoot = parent === resolved

  return {
    path: resolved,
    parent: atRoot ? null : parent,
    roots: await listRoots(),
    home: os.homedir(),
    crumbs: buildCrumbs(resolved),
    entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
    truncated,
  }
}

/** 判断一次列举是不是失败。失败对象只有一个 `code` 字段是字符串枚举，够区分了 */
export function isBrowseFailure(value: BrowseListing | BrowseFailure): value is BrowseFailure {
  return !('entries' in value)
}
