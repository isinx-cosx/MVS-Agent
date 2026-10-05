/**
 * 测试的运行前钩子（`node --test --import ./test/setup.mjs …`）。
 *
 * ## 解决的问题
 *
 * 测试夹具会把状态写进**真实的家目录**（`~/.mvs-agent`）：恢复层的快照、会话日志、
 * 配置文件。两个后果，一好一坏都不轻：
 *
 *   · 在受限沙箱下**整片失败** —— `EPERM: mkdir '~/.mvs-agent/recovery/…'`
 *     （而失败的样子像是"代码坏了"，不是"环境不让写"）
 *   · 在不受限时**动真实数据** ✗ —— 测试会往你的真实状态里塞东西
 *
 * ## 为什么是 `--import` 而不是在每个测试文件里设
 *
 * `node --test` 默认**并行跑各测试文件**，而 `--test-isolation=none` 让它们同处
 * 一个进程 —— 于是"每个文件自己设一个临时家目录"会互相覆盖 ✗。
 * 用 `--import` 在**一切测试模块加载之前**设一次，全程只用一个临时家目录 ✓。
 *
 * ## 为什么放在系统临时目录，不放在 `test/` 里
 *
 * 放进仓库就会变成又一批 `.tmp-*` 残留 ✗（我们刚清掉 284 个 ✓）。
 * 放系统临时目录 + 退出时清理，就不会污染仓库。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = mkdtempSync(path.join(os.tmpdir(), 'mvs-test-home-'))
process.env['MVS_HOME'] = home

/*
 * 退出时清掉。用同步删除：`exit` 事件里没有机会等异步操作完成。
 * 删不掉也不算失败（临时目录本来就允许留下），所以吞掉异常。
 */
process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    /* 临时目录而已，留着不影响正确性 */
  }
})
