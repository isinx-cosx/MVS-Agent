/**
 * 目录选择：能力判定 + 浏览后端。
 *
 * ## 为什么这两块值得测
 *
 * **能力判定**决定的是「界面给用户看什么」。判错了的后果不是报错，是
 * **一片沉默**：系统对话框开在守护进程那台机器的屏幕上，而操作者在另一台机器前，
 * 于是他点了「添加工作区」什么都不发生 —— 而服务端正开着框在等一个看不见的人点。
 * 这个错**在本地开发时永远不会出现**，只会在别人 SSH 进来的时候出现。
 * 所以判据只能靠测试钉住。
 *
 * **浏览后端**是那个「到哪台机器上都成立」的形态，也是我能端到端验证的那一半。
 * 它有几处具体到容易写错的边界：到根时 `dirname` 会返回自己、
 * 目录联结在 Windows 上 `isDirectory()` 是 true、排序要让 `10` 排在 `9` 后面。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'

import { resolvePickerKind } from '../src/host/picker.ts'
import { isBrowseFailure, listDirectory } from '../src/host/directory-browse.ts'

// ---------------------------------------------------------------------------
// 能力判定
// ---------------------------------------------------------------------------

test('★ 本机 Windows 桌面 → native（系统自带的文件夹对话框）', () => {
  /*
   * ⚠️ 这条断言**翻过两次**，两次都是被实测推翻的。写清楚免得下次再翻。
   *
   * **第一版**：本机 → native。想当然，没验证。
   *
   * **第二版**：本机 → browse。因为实测发现框**起来了但藏在别的窗口后面** ——
   * 后台守护进程没有前台权限，Windows 的前台锁不允许它抢前台。当时用的是
   * PowerShell + WinForms 的 `FolderBrowserDialog`（**老式** `SHBrowseForFolder`
   * 那一系），并且照 DSH 合成了一次 Alt 按下抬起，**实测无效**：
   * 进程挂着整整 300 秒超时、没人能点到。
   *
   * **第三版（现在）**：改回 native。读了 DSH 的实现才发现差别
   * **不在 Alt 合成，在对话框本身** —— 它用现代 COM `IFileOpenDialog`
   * （Vista 起有，会自己激活），我用的是老式的（依赖 owner 的 z 序）。
   *
   * 换成 **Node 子进程 + koffi 直接调 COM**（`tools/dialog-worker.mjs`）之后实测：
   *
   *     node.exe (pid 23768) "#32770" "选择工作区目录"     ← 自有进程持有的原生框
   *     focused_element: { class_name: "View" }             ← 焦点在框内部
   *     Button "取消" [actions=[invoke]]                     ← 真实可交互的原生控件
   *
   * 所以：**能做出来，也能到前台。** 而它比自己画的浏览器好 ——
   * 盘符、路径输入、网络位置、最近位置都是系统给的，不用一个个补
   * （「此电脑」那一层就是我为了补盘符才加的）。
   */
  const cap = resolvePickerKind({ platform: 'win32', env: {} })
  assert.equal(cap.kind, 'native')
  assert.ok(cap.reason !== '', '理由要能说出口 —— 排查时它是唯一的线索')
})

test('★ SSH 会话 → browse（这条是整层的存在理由）', () => {
  /*
   * 三种变量任一个出现就够 —— 它们都是 sshd 注入的。
   * 这条断言的是**最要紧的那个行为**：宁可少给一个原生框，
   * 也不能让用户点了没反应 —— 框开在远端那台机器的屏幕上，他够不到。
   */
  for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
    const cap = resolvePickerKind({ platform: 'win32', env: { [key]: 'x' } })
    assert.equal(cap.kind, 'browse', `${key} 存在时应当是 browse`)
    assert.match(cap.reason, /SSH/, '理由要指出是 SSH —— 否则用户不知道框开在哪台机器上')
  }
})

test('空字符串的 SSH 变量不算（shell 约定里「空 export」等于没设）', () => {
  const cap = resolvePickerKind({ platform: 'win32', env: { SSH_CONNECTION: '' } })
  assert.equal(cap.kind, 'native', '本机是 native；这里只验「空字符串没有被当成 SSH」')
  assert.ok(!/SSH/.test(cap.reason), '不应当报 SSH —— 那个变量是空的')
})

test('非 Windows → browse（原生实现只有 Windows 一份）', () => {
  for (const platform of ['linux', 'darwin'] as const) {
    const cap = resolvePickerKind({ platform, env: {} })
    assert.equal(cap.kind, 'browse')
    assert.match(cap.reason, new RegExp(platform), '理由要说清是平台问题')
  }
})

test('平台和 SSH 同时不满足时，说的是平台（更根本的那条）', () => {
  const cap = resolvePickerKind({ platform: 'linux', env: { SSH_CONNECTION: 'x' } })
  assert.equal(cap.kind, 'browse')
  assert.match(cap.reason, /linux/)
})

// ---------------------------------------------------------------------------
// 浏览后端
// ---------------------------------------------------------------------------

async function withTree(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mvs-browse-'))
  try {
    await mkdir(path.join(dir, 'alpha'), { recursive: true })
    await mkdir(path.join(dir, 'beta'), { recursive: true })
    await mkdir(path.join(dir, 'alpha', 'nested'), { recursive: true })
    // 排序边界：数字要按数值排，否则 '10' 会排在 '9' 前面
    await mkdir(path.join(dir, 'item9'), { recursive: true })
    await mkdir(path.join(dir, 'item10'), { recursive: true })
    // 文件必须被排除
    await writeFile(path.join(dir, 'a.txt'), 'x', 'utf8')
    await writeFile(path.join(dir, 'zzz.md'), 'x', 'utf8')
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('只列目录，文件一个都不出现', async () => {
  await withTree(async (dir) => {
    const listing = await listDirectory(dir)
    assert.ok(!isBrowseFailure(listing), '应当成功')

    const names = listing.entries.map((e) => e.name)
    assert.deepEqual(names.sort(), ['alpha', 'beta', 'item10', 'item9'].sort())
    assert.ok(!names.includes('a.txt'), '文件不该出现')
    assert.ok(!names.includes('zzz.md'), '文件不该出现')
  })
})

test('每项都带可直接进入的绝对路径', async () => {
  await withTree(async (dir) => {
    const listing = await listDirectory(dir)
    assert.ok(!isBrowseFailure(listing))
    const alpha = listing.entries.find((e) => e.name === 'alpha')
    assert.ok(alpha !== undefined)
    assert.equal(alpha.path, path.join(dir, 'alpha'))
    // 点进去要能列出下一层 —— 路径是给人用的，不是装饰
    const nested = await listDirectory(alpha.path)
    assert.ok(!isBrowseFailure(nested))
    assert.deepEqual(nested.entries.map((e) => e.name), ['nested'])
  })
})

test('parent 指向上级，且不是一个不存在的路径', async () => {
  await withTree(async (dir) => {
    const listing = await listDirectory(path.join(dir, 'alpha'))
    assert.ok(!isBrowseFailure(listing))
    assert.equal(listing.parent, dir)
    assert.equal(listing.path, path.join(dir, 'alpha'))
  })
})

test('★ 到根时 parent 是 null，不是它自己', async () => {
  /*
   * `path.dirname('C:\\')` 返回 `'C:\\'` —— 就是它自己。
   * 直接把它当 parent 给界面，用户点「上一级」会原地不动，
   * 而且永远出不去。所以判据必须是 `parent === resolved`。
   */
  const root = process.platform === 'win32' ? 'C:\\' : '/'
  const listing = await listDirectory(root)
  if (isBrowseFailure(listing)) return // 某些环境连根都读不了，跳过
  assert.equal(listing.parent, null, '根上面没有东西')
})

test('roots 不为空（界面要有地方可跳）', async () => {
  await withTree(async (dir) => {
    const listing = await listDirectory(dir)
    assert.ok(!isBrowseFailure(listing))
    assert.ok(listing.roots.length > 0)
    if (process.platform === 'win32') {
      // 每个盘符都得是 `X:\` 这种形状，否则界面拼出来的跳转路径是坏的
      for (const r of listing.roots) assert.match(r, /^[A-Z]:\\$/)
    }
  })
})

test('没这个路径 → not_found（而不是空列表）', async () => {
  await withTree(async (dir) => {
    const listing = await listDirectory(path.join(dir, 'nope-does-not-exist'))
    assert.ok(isBrowseFailure(listing))
    assert.equal(listing.code, 'not_found')
    assert.match(listing.message, /没有这个路径/)
  })
})

test('路径是个文件 → not_a_directory', async () => {
  await withTree(async (dir) => {
    const listing = await listDirectory(path.join(dir, 'a.txt'))
    assert.ok(isBrowseFailure(listing))
    assert.equal(listing.code, 'not_a_directory')
  })
})

test('列出的是规范化之后的绝对路径（相对路径进来也对）', async () => {
  await withTree(async (dir) => {
    const listing = await listDirectory(path.join(dir, 'alpha', '..', 'beta'))
    assert.ok(!isBrowseFailure(listing))
    assert.equal(listing.path, path.join(dir, 'beta'))
    assert.equal(path.isAbsolute(listing.path), true)
  })
})

// ---------------------------------------------------------------------------
// 「此电脑」那一层
// ---------------------------------------------------------------------------

test('★ 空串 = 「此电脑」那一层，列出所有盘', async () => {
  /*
   * ⚠️ 这条测的是一个**实测出来的缺陷**，不是想当然的便利。
   *
   * DSH 那个浏览器的祖先链是从路径的根往上走的（它自己的 `ancestryCrumbs`），
   * Windows 上**没有盘符列表**。于是它只能从主目录往下走、或者退到 `C:\` ——
   * 而 `D:\` 是 `C:\` 的**兄弟**，点不到。实测那个弹层里盘符入口一个都没有，
   * 而用户的模型和项目都在 D 盘。
   *
   * 所以空串（= 浏览器第一次打开、以及点「此电脑」面包屑）回的是盘符列表。
   */
  const listing = await listDirectory('')
  assert.ok(!isBrowseFailure(listing), '不应当是失败')

  assert.equal(listing.path, '', '这一层在文件系统里不存在，所以路径是空串')
  assert.equal(listing.crumbs.length, 1, '只有一段面包屑')
  assert.equal(listing.crumbs[0].name, '此电脑')
  assert.equal(listing.crumbs[0].path, '', '点它回来还是这一层')

  if (process.platform === 'win32') {
    assert.ok(listing.entries.length >= 1, 'Windows 上至少有一个盘')
    for (const entry of listing.entries) {
      assert.match(entry.name, /^[A-Za-z]:\\$/, `盘符要长成 C:\\ 这样，实际是 ${entry.name}`)
      assert.equal(entry.path, entry.name, '盘符的 path 就是它自己')
      assert.equal(entry.hidden, false, '盘不是隐藏项')
    }
    assert.ok(
      listing.entries.some((e) => e.name === 'C:\\'),
      'C 盘一定在 —— 测试跑在它上面',
    )
  } else {
    assert.deepEqual(
      listing.entries.map((e) => e.name),
      ['/'],
      '非 Windows 只有 /',
    )
  }
})

test('★ 「此电脑」那层里的 home 仍然是真主目录', async () => {
  /*
   * 这一条防的是一个很容易顺手做错的改法：既然这一层叫「此电脑」，
   * 那把 `home` 也改成空串/盘符看起来「更一致」——
   *
   * 但 DSH 的浏览器**用 `home` 渲染「主目录」那个按钮**，也用它推断路径分隔符
   * （`listing.home.includes('\\') ? '\\' : '/'`）。改成空串会让那个按钮
   * 跳到空路径，而分隔符推断退化成 `/`，在 Windows 上敲路径就废了。
   */
  const listing = await listDirectory('')
  assert.ok(!isBrowseFailure(listing))
  assert.equal(listing.home, homedir())
  assert.ok(listing.home !== '', 'home 不能是空串')
})
