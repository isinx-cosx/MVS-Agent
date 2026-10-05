/*
 * 直接验「守护进程 → WebSocket」这一段，不经过浏览器。
 *
 * 做法：原生 WS 连上 /ws，watch 一个会话，然后 HTTP 发一条 user_message，
 * 把收到的每一帧按类型计数。判据：
 *
 *   · 有 model_text_delta        → 增量那条路是通的（问题在页面/垫片）
 *   · 一条 event 都没有          → 守护进程根本没广播（问题在服务端）
 */

const BASE = process.env.MVS_BASE ?? 'http://127.0.0.1:3092'

const state = await (await fetch(`${BASE}/state`)).json()
const session = state.state.sessions.find((s) => s.turn === 0) ?? state.state.sessions[0]
console.log('会话', session.sessionId, '标题', session.title, 'turn', session.turn)

const counts = {}
const samples = []
const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`)

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

ws.addEventListener('message', (event) => {
  let frame
  try {
    frame = JSON.parse(event.data)
  } catch {
    counts['(解析失败)'] = (counts['(解析失败)'] ?? 0) + 1
    return
  }
  const key = frame.kind === 'event' ? `event / ${frame.envelope?.event?.type ?? '?'}` : String(frame.kind)
  counts[key] = (counts[key] ?? 0) + 1
  const t = frame.envelope?.event?.type
  if (t !== 'model_text_delta' && t !== 'model_reasoning_delta' && samples.length < 40) {
    samples.push(key + ' ' + JSON.stringify(frame.envelope?.event ?? frame.kind))
  }
})

ws.send(JSON.stringify({ type: 'watch', sessionIds: [session.sessionId] }))
await new Promise((r) => setTimeout(r, 500))

const base = { ...counts }
console.log('订阅后：', JSON.stringify(base))

const send = await fetch(`${BASE}/command`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'user_message',
    sessionId: session.sessionId,
    text: process.env.MVS_TEXT ?? '请简要介绍一下你自己，只输出正文。',
  }),
})
console.log('POST /command →', send.status, (await send.text()).slice(0, 200))

await new Promise((r) => setTimeout(r, 8000))

const delta = {}
for (const [k, v] of Object.entries(counts)) delta[k] = v - (base[k] ?? 0)
console.log('这一轮的帧：', JSON.stringify(delta, null, 1))
console.log('采样（非增量）：')
for (const line of samples) console.log('  ' + line.slice(0, 220))
ws.close()
process.exit(0)
