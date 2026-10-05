/**
 * 一次性清理：把**探针建出来的空会话**删掉。
 *
 * ## 为什么需要这一步
 *
 * 每跑一次「选一个工作区」的探针，前端就会 `session/create` —— 于是探针
 * 每验一次，会话库里就多一条空会话。我这一轮跑了十几次，加上子代理的，
 * 一共堆了 68 条（原本只有 11 条）。
 *
 * ## ⚠️ 判据必须**两个条件同时成立** —— 我第一版只用了标题，那是错的
 *
 * 第一版判据是「标题属于探针造的那几个」。跑完 dry-run 才发现：
 * **用户原来那 11 条里有 10 条标题也是「新会话」**（他自己建了没用）。
 * 只按标题删，会把这 10 条一起卷走 —— 而那正是「看着像垃圾、其实是别人的东西」。
 *
 * 所以加上**日期**这一条：`createdAt` 在 `--since` 之后（默认今天）。
 * 用户那些是之前建的，两个条件不会同时成立。
 *
 * 判据的选择原则：**宁可漏删，不可误删。** 漏掉的垃圾看得见，误删的东西看不见。
 *
 * 删除是 `delete_session`，守护进程把它移到 `state/trash/sessions` —— **可恢复**。
 *
 * 用法：
 *   node tools/cleanup-probe-sessions.mjs                     # 只看，不删
 *   node tools/cleanup-probe-sessions.mjs --confirm           # 真删（从今天起）
 *   node tools/cleanup-probe-sessions.mjs --since 2026-10-03  # 指定起始日期
 */

const B = process.env.MVS_ORIGIN ?? 'http://127.0.0.1:3092'
const confirm = process.argv.includes('--confirm')
const sinceArg = process.argv[process.argv.indexOf('--since') + 1]
const since = process.argv.includes('--since') && sinceArg ? sinceArg : new Date().toISOString().slice(0, 10)

/** 探针造出来的标题。**加了新探针就往这里补一条** */
const PROBE_TITLES = new Set(['新会话', '只回答两个字：你好'])

const state = await (await fetch(`${B}/state`)).json()
const sessions = state?.state?.sessions ?? []

const isProbe = (s) =>
  PROBE_TITLES.has(s.title ?? '') && String(s.createdAt ?? '') >= since

const doomed = sessions.filter(isProbe)
const kept = sessions.filter((s) => !isProbe(s))

console.log(`  会话总数   ${sessions.length}`)
console.log(`  起始日期   ${since} 之后建的才算`)
console.log(`  探针产物   ${doomed.length}`)
console.log(`  保留       ${kept.length}`)
console.log('')
console.log(`  保留的 ${kept.length} 条（**这些是你的**，一条都不动）：`)
for (const s of kept) {
  console.log(`    ${s.createdAt}  ${String(s.sessionId).slice(0, 8)}  ${(s.title ?? '').slice(0, 30)}`)
}

if (!confirm) {
  console.log('')
  console.log('  只看了，没删。要真删：node tools/cleanup-probe-sessions.mjs --confirm')
  process.exit(0)
}

console.log('')
let done = 0
let failed = 0
for (const s of doomed) {
  try {
    const res = await fetch(`${B}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'delete_session', sessionId: s.sessionId }),
    })
    const body = await res.json()
    if (body?.ok === true) done += 1
    else {
      failed += 1
      console.log(`    ✗ ${String(s.sessionId).slice(0, 8)}  ${body?.message ?? res.status}`)
    }
  } catch (error) {
    failed += 1
    console.log(`    ✗ ${String(s.sessionId).slice(0, 8)}  ${error.message}`)
  }
}

console.log(`  删掉 ${done} 条，失败 ${failed} 条`)
console.log('  它们在 ~/.mvs-agent/trash/sessions 里，可以恢复（注意没有 state 那一层）')
