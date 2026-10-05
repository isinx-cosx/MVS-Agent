/**
 * 「这个命令能不能被**证明**是只读的」。
 *
 * ## 为什么需要它
 *
 * 出厂默认的允许列表是**空的**，这是个正确的决定（Cursor 把 `npm` 整条放进允许
 * 列表，而它按命令前缀匹配 —— 那一条覆盖了 `npm publish` 和**所有 postinstall
 * 脚本**）。代价是 `run_command` 在 `workspace-write` 下每次都要问，于是
 * `git status` 这种绝对无害的东西也要点一次确认。用户很快就会开始闭眼点「允许」，
 * 而那正是权限层想避免的事。
 *
 * 所以补的不是「更宽的允许列表」，而是一个**能证明只读**的分类器：
 *
 * - 证明得了 → 自动放行
 * - 证明不了 → 走原来的流程（照常问）
 *
 * ## 三条硬规矩（都是被 CVE 教出来的）
 *
 * 1. **命令里出现任何 shell 元字符，一律不认。**
 *    `git status && rm -rf /` 和 `git status` 的前缀是一样的 —— 靠前缀匹配
 *    放行就等于把整条链放行了。这是 CVE-2025-54131 那一类（反引号 / `$(cmd)`）
 *    的同族问题，所以这里连 `;`、`&&`、`|`、重定向、换行都不允许出现。
 * 2. **不做前缀匹配，做「程序 + 子命令 + 参数形状」的匹配。**
 *    `npm` 单独一条会吞掉 `npm publish`。所以每一项都要写清程序名，多子命令的
 *    程序还要写清子命令。
 * 3. **有位置参数就会写东西的子命令，要求其余全部是选项。**
 *    `git branch` 只读，但 `git branch newname` 会**创建分支**；`git tag` 同理。
 *    这类子命令只在「后面全是 `-` 开头的 token」时才算只读。
 *
 * ## 明确的残余风险（写在这里，而不是假装没有）
 *
 * - 它认的是**命令文本**，不是行为。一个只读命令如果被同名程序冒充（PATH 上放了
 *   一个假的 `git.exe`），这里看不出来。沙箱该管这件事，而这个模块不管。
 * - 引号一律不接受（见下），所以 `git log --pretty='%h %s'` 会被判为「证明不了」，
 *   照常问一次。**宁可多问，不可错放。**
 * - `find` / `xargs` / `awk` 这类参数里能塞执行的东西，整体不在表里。
 */

/** 允许的程序。**多子命令的程序一次只放行特定的子命令** */
interface Entry {
  /** 子命令白名单。缺省表示这个程序没有子命令的概念 */
  subcommands?: readonly string[]
  /**
   * 这些子命令只在「其余 token 全部以 `-` 开头」时才算只读。
   * （`git branch` 只读，`git branch newname` 会创建分支）
   */
  requireOptionsOnly?: readonly string[]
}

const PROGRAMS: Record<string, Entry> = {
  git: {
    subcommands: [
      'status',
      'diff',
      'log',
      'show',
      'blame',
      'shortlog',
      'describe',
      'rev-parse',
      'ls-files',
      'ls-tree',
      'cat-file',
      'whatchanged',
      'reflog',
      'grep',
      // ⚠️ 这三个**必须同时出现在 subcommands 里**。
      // 只放进 requireOptionsOnly 是不够的：白名单检查在前面，它们会先被拒掉，
      // 那条「参数全是选项才算只读」的规则根本没机会生效。
      // （这个错我犯过，测试抓出来了。）
      'branch',
      'tag',
      'remote',
    ],
    // 这几个给位置参数就会写：branch/tag 创建，remote 增删
    requireOptionsOnly: ['branch', 'tag', 'remote'],
  },
  ls: {},
  dir: {},
  pwd: {},
  cat: {},
  type: {},
  head: {},
  tail: {},
  wc: {},
  grep: {},
  rg: {},
  echo: {},
  whoami: {},
  hostname: {},
  date: {},
  node: { subcommands: ['--version', '-v'] },
  npm: { subcommands: ['--version', '-v', 'ls', 'list'] },
  pnpm: { subcommands: ['--version', '-v', 'list'] },
  yarn: { subcommands: ['--version', '-v', 'list'] },
  tsc: { subcommands: ['--version', '-v'] },
  python: { subcommands: ['--version', '-V'] },
  python3: { subcommands: ['--version', '-V'] },
  go: { subcommands: ['version', 'env'] },
  cargo: { subcommands: ['--version', '-V'] },
}

/**
 * 出现在任何位置都要否决的选项。
 *
 * 这些都是「让一个只读命令去执行别的东西 / 写到别处」的开关：
 * git 的 `-c` 能改配置从而触发 hook，`--ext-diff` / `--textconv` 会调用外部程序，
 * `--output` 会写文件；`find -exec` 那类直接执行命令。
 */
const DENY_FLAGS = new Set([
  '-c',
  '--exec-path',
  '--upload-pack',
  '--receive-pack',
  '--ext-diff',
  '--textconv',
  '--output',
  '--exec',
  '--execdir',
  '--delete',
  '-delete',
  '--files0-from',
  '--to-command',
  '--filter',
])

/**
 * shell 元字符。
 *
 * ⚠️ 这一条是**整个模块的地基**，不是锦上添花。靠前缀匹配放行 `git status`
 * 意味着 `git status && rm -rf /` 也被放行 —— 那正是同类 CVE 的形态。
 * 所以只要有任何一个出现，就一律判为「证明不了」。
 *
 * 引号也在内：不做引号解析，就不会有引号解析的 bug。
 */
const META = /[|&;<>()`$'"\r\n]/

/** 把命令切成 token。**不做引号处理**（含引号的命令在上面已经被否决了） */
function tokenize(command: string): string[] {
  return command.trim().split(/\s+/).filter(Boolean)
}

/**
 * 取出选项的**名字**，去掉 `=值` 那一段。
 *
 * ⚠️ 这一步不能省，实测漏过：`--output=leak.txt` 是**一个** token，
 * 而按整串去比对黑名单只能匹配到 `--output` —— 于是所有 `--flag=值` 形式的
 * 危险选项全部漏过去了（`--exec-path=`、`--upload-pack=`、`--files0-from=` 同理）。
 * 这是最典型的一类过滤器漏洞：**检查的是名字，喂进来的却是名字加值。**
 */
function flagNameOf(token: string): string {
  const eq = token.indexOf('=')
  return eq === -1 ? token : token.slice(0, eq)
}

export interface ReadOnlyVerdict {
  readOnly: boolean
  /** 判定理由。**要能显示给用户** —— 自动放行必须说得出为什么 */
  reason: string
}

/**
 * 判断一个命令是否**可证明只读**。
 *
 * 返回 false 只表示「证明不了」，不表示「危险」—— 调用方应当照常走询问流程。
 */
export function classifyReadOnly(command: string): ReadOnlyVerdict {
  const trimmed = command.trim()
  if (trimmed === '') return { readOnly: false, reason: '空命令' }

  if (META.test(trimmed)) {
    return {
      readOnly: false,
      reason: '含 shell 元字符 —— 无法保证它只有一条命令，靠前缀放行等于把整条链放行',
    }
  }

  const tokens = tokenize(trimmed)
  const head = tokens[0] ?? ''
  if (head === '') return { readOnly: false, reason: '空命令' }

  const program = PROGRAMS[head.toLowerCase()]
  if (program === undefined) {
    return { readOnly: false, reason: `「${head}」不在只读程序表里` }
  }

  for (const token of tokens.slice(1)) {
    const flag = flagNameOf(token)
    if (DENY_FLAGS.has(flag)) {
      return {
        readOnly: false,
        reason: `选项 ${flag} 会让只读命令去执行别的东西或写到别处`,
      }
    }
  }

  if (program.subcommands === undefined) {
    return { readOnly: true, reason: `${head} 是只读程序，且命令里没有 shell 元字符` }
  }

  const sub = tokens[1]
  if (sub === undefined || !program.subcommands.includes(sub)) {
    // 没有子命令、或子命令不在白名单里 —— 一律证明不了。
    // 这里**刻意**不接受「未知子命令就当只读」：git 的子命令里有太多会写东西的。
    return {
      readOnly: false,
      reason: `「${head}」的子命令「${sub ?? '(无)'}」不在只读白名单里`,
    }
  }

  const rest = tokens.slice(2)
  if (program.requireOptionsOnly?.includes(sub) === true) {
    const positional = rest.filter((t) => !t.startsWith('-'))
    if (positional.length > 0) {
      return {
        readOnly: false,
        reason: `${head} ${sub} 带位置参数会写东西（例如创建分支/标签），本次带了：${positional.join(' ')}`,
      }
    }
  }

  return { readOnly: true, reason: `${head} ${sub} 是只读子命令，且没有元字符与危险选项` }
}

/** 给策略层用的简写 */
export function isProvablyReadOnly(command: string): boolean {
  return classifyReadOnly(command).readOnly
}
