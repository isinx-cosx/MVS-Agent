/**
 * 从守护进程里找出**真的有消息**的会话，并打印它的消息形状。
 * 用途：垫片要按 `SessionProjection.messages` 造 DSH 事件，先把真实数组看一眼。
 *
 * 用法：node .planning/find-sessions.mjs [条数上限]
 */
const ORIGIN = process.env.MVS_ORIGIN ?? 'http://127.0.0.1:3092'
const top = Number(process.argv[2] ?? 40)

const state = await (await fetch(`${ORIGIN}/state`)).json()
const sessions = state.state.sessions.slice(0, top)

const rows = []
for (const s of sessions) {
  try {
    const res = await fetch(`${ORIGIN}/projection?sessionId=${encodeURIComponent(s.sessionId)}`)
    if (!res.ok) continue
    const { projection } = await res.json()
    rows.push({ sessionId: s.sessionId, title: s.title, lastSeq: projection.lastSeq, messages: projection.messages })
  } catch (error) {
    rows.push({ sessionId: s.sessionId, error: String(error) })
  }
}

rows.sort((a, b) => (b.messages?.length ?? 0) - (a.messages?.length ?? 0))
for (const row of rows.slice(0, 12)) {
  console.log(`${String(row.messages?.length ?? '?').padStart(3)} 条  lastSeq=${row.lastSeq}  ${row.sessionId}  ${row.title}`)
}

const best = rows.find((r) => (r.messages?.length ?? 0) > 0)
if (best !== undefined) {
  console.log(`\n===== 消息最多的：${best.sessionId}（${best.messages.length} 条）=====`)
  console.log(JSON.stringify(best.messages.slice(0, 6), null, 2))
}
