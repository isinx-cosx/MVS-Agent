/**
 * 死循环提示 —— **只提示，不拦**。
 *
 * ## 为什么只做提示
 *
 * 「这是不是死循环」在一般情况下不可判定（停机问题）；而能静态认出来的形态，
 * 恰好也是**合法长驻程序**的形态：`npm run dev`、`vite --watch`、`jest --watch`、
 * `python -m http.server` 全都长这样。一条会拦 dev server 的规则，用户三天内就会关掉。
 *
 * 所以这里的定位非常窄：**抓 AI 顺手写出来的忙等**（`while(true)` 里没有 sleep、
 * 没有 I/O），在工具结果里附一句提醒，让它自己加个退出条件或给个 timeout。
 *
 * ## 只在哪儿生效
 *
 * 只检查**本次写入的内容**（`write_file` / `create_file` 的正文、`run_command` 里
 * `node -e` 那种内联脚本）。不去审仓库里的老代码 —— 那是 linter 的活，而且老代码里
 * 合法的长循环到处都是。
 */

export interface LoopWarning {
  /** 命中的行号（1 基） */
  line: number
  /** 人话说明 */
  message: string
}

/** 有这些关键字时不算"忙等"：它在等 I/O 或显式让出时间片 */
const YIELDS = ['await ', 'sleep', 'setTimeout', 'setInterval', 'setImmediate', 'pause', 'readline', 'yield', 'chrono', 'time.sleep']

/** 明显是"跑很久"的循环上限，例如 `for (let i = 0; i < 1e9; i++)` */
const HUGE_BOUND = /(?:<|<=|!=)\s*(\d[\d_]{6,}|1e\d+)/i

const LOOP_STARTS = [
  /while\s*\(\s*(?:true|1)\s*\)/i,
  /while\s+True\s*:/i,
  /for\s*\(\s*;\s*;\s*\)/i,
  /do\s*\{/i,
  /loop\s*\{/i,
]

/**
 * 扫一段代码，返回值得提醒的地方。
 *
 * 判定规则（刻意宽松）：命中"看起来是循环"的开头，且**同一个块里没有让出点**。
 * 块的范围用朴素的花括号/缩进估计 —— 宁可不报，也不要在普通代码上乱叫。
 */
export function lintTightLoops(code: string): LoopWarning[] {
  const lines = code.split('\n')
  const warnings: LoopWarning[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const isLoop = LOOP_STARTS.some((re) => re.test(line))
    if (!isLoop) continue

    /* 往后看 12 行找让出点：这是"紧循环 vs 事件循环"的分界 */
    const window = lines.slice(index, Math.min(lines.length, index + 12)).join('\n')
    const hasYield = YIELDS.some((token) => window.includes(token))
    if (hasYield) continue

    warnings.push({
      line: index + 1,
      message:
        `第 ${index + 1} 行看起来是**紧循环**（没有 await / sleep / I/O）—— ` +
        '它可能一直不退出，把 CPU 占满。如果这是给跑一遍用的脚本，建议加一个退出条件或 `--timeout`。',
    })
    if (warnings.length >= 3) break
  }

  /* `for (let i = 0; i < 1e9; i++)` 这种：不是死循环，但会跑很久 */
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!/\bfor\s*\(/.test(line)) continue
    const bound = HUGE_BOUND.exec(line)
    if (bound === null) continue
    warnings.push({
      line: index + 1,
      message:
        `第 ${index + 1} 行的循环上限很大（${bound[1]}）—— 它可能要跑很久。` +
        '如果只是想跑一遍，给个明确的步数或加超时。',
    })
    if (warnings.length >= 3) break
  }

  return warnings
}

/** 把提醒拼成一段附在工具结果后面的文字（没有命中就返回 null） */
export function loopWarningNote(code: string): string | null {
  const warnings = lintTightLoops(code)
  if (warnings.length === 0) return null
  return ['⚠ 可能的死循环（只是提醒，不阻止执行）：', ...warnings.map((w) => `- ${w.message}`)].join('\n')
}

/** 这个文件扩展名值不值得检查 */
export function isScriptPath(rel: string): boolean {
  return /\.(?:js|mjs|cjs|ts|tsx|jsx|py|sh|bash|ps1|rb|go|rs)$/i.test(rel)
}
