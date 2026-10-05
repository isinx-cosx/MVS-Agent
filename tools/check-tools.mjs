/**
 * 给 tools/ 下所有 .mjs 做语法自检。
 *
 * ## 为什么需要这条命令
 *
 * 我在工具脚本里反复犯同一个错：**在模板字符串的注释里写反引号**，
 * 于是模板被提前撕开、后面的内容变成代码。这个坑我踩了**八次**。
 *
 * 症状很烦：报错指向模板字符串的**开头那一行**，而真正的问题在几百行之后的
 * 注释里。每次都要重新找一遍。
 *
 * `node --check` 能抓到它 —— 所以把「能抓到」变成「每次都会跑」。
 *
 * ## ⚠️ 为什么用文件接 stderr，而不是管道
 *
 * 这个沙箱里 **`spawnSync` 配 `stdio:'pipe'` 会 EPERM**（实测：
 * `status=null`、`error.code='EPERM'`、`stderr` 是 `null`）。而管道一坏，
 * 表现是**全部 32 个工具都报「✗」但一行错误信息都没有** ——
 * 那看起来像「工具全坏了」，其实是检查器自己收不到输出。
 *
 * 所以这里把子进程的 stderr 接到一个**临时文件**上（fd 重定向不受那条限制），
 * 跑完再读回来。stdout 直接丢掉 —— `--check` 成功时它一个字都不输出。
 *
 * 用法：node tools/check-tools.mjs
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

const files = readdirSync(HERE)
  .filter((name) => name.endsWith('.mjs'))
  .sort()

/** 每条都把 stderr 写到这里再读回来。用 pid 命名，免得并发时互相踩 */
const errFile = join(tmpdir(), `mvs-toolcheck-${process.pid}.log`)

let failed = 0
try {
  for (const name of files) {
    const fd = openSync(errFile, 'w')
    let status
    try {
      status = spawnSync(process.execPath, ['--check', join(HERE, name)], {
        stdio: ['ignore', 'ignore', fd],
      }).status
    } finally {
      closeSync(fd)
    }

    if (status === 0) {
      console.log(`  ✓ ${name}`)
      continue
    }

    failed += 1
    console.log(`  ✗ ${name}`)
    /*
     * 把报错的最后几行打出来 —— 开头几行是堆栈噪声。
     *
     * ⚠️ `status === null` 意味着**进程没跑起来**（EPERM 之类），
     * 而不是「语法错了」。这两种要分开说，否则又会走回上面那个歧路。
     */
    if (status === null) {
      console.log('      子进程没起来（沙箱拒绝？）—— 不是语法问题')
      continue
    }
    const lines = readFileSync(errFile, 'utf8').trim().split('\n')
    console.log(`      ${lines.slice(-4).join('\n      ')}`)
  }
} finally {
  rmSync(errFile, { force: true })
}

console.log('')
if (failed === 0) {
  console.log(`  ${files.length} 个工具全部通过`)
} else {
  console.log(`  ${failed} / ${files.length} 个有问题`)
  process.exit(1)
}
