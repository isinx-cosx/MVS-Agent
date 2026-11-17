/**
 * R8：免审集合的"防误加"测试。
 *
 * `SELF_AUTHORED` 里的工具跳过输出审核 —— 因为它们只回显"自己刚写进去的内容"，
 * 没有从外部读进来的东西。这个前提一旦被打破（有人把读文件的工具加进去），
 * 审核就出现一个静默缺口，而且**不会有任何测试变红**。
 *
 * 所以这里钉两件事：
 *   1. 集合内容就是那 6 个写类工具，多一个少一个都要改这里（强制复核）
 *   2. 读/搜/执行类工具**必须**被扫
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { SELF_AUTHORED, shouldScanOutput } from '../src/guard/review.ts'

test('R8：免审集合恰好是 6 个写类工具（新增条目必须改这个测试）', () => {
  assert.deepEqual(
    [...SELF_AUTHORED].sort(),
    ['create_file', 'delete_file', 'delete_paths', 'edit', 'move_path', 'write_file'],
    '免审集合变了：请确认新条目确实只回显自己写入的内容，再更新这条断言',
  )
})

test('R8：读 / 搜 / 执行 / 联网类工具一律要扫', () => {
  for (const tool of ['read_file', 'grep', 'glob', 'run_command', 'web_fetch', 'web_search', 'use_skill', 'job_output']) {
    assert.equal(shouldScanOutput(tool), true, `${tool} 必须被审核`)
  }
})

test('R8：未知工具默认要扫（默认安全，而不是默认放行）', () => {
  assert.equal(shouldScanOutput('some_new_tool'), true)
})
