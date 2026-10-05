/*
 * 确认「同一会话同时开着几条跟随流」—— 这是"帧跑在某条流自己的 step/start 前面"的前提。
 *
 * `pushLiveFrame` 把一帧**一次性发给所有投递者**，而每条流的落盘记录是**它自己**的
 * push 去取的（要等一次 /projection 往返）。于是慢的那条流会先拿到帧。
 */
;(async () => {
  const tick = async () => fetch('/state')
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  if (rows[0] === undefined) return '侧栏没有会话行'
  rows[0].click()
  for (let i = 0; i < 30; i += 1) await tick()

  const follows = globalThis.__REPLICA_FOLLOW__ ?? []
  const sessionId = follows[follows.length - 1]?.sessionId
  if (sessionId === undefined) return '没有跟随流'

  await fetch('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'user_message', sessionId: sessionId, text: '笼子里有鸡和兔，请回答。' }),
  })

  for (let i = 0; i < 12000; i += 1) {
    await tick()
    const ws = globalThis.__REPLICA_WS_COUNT__ ?? {}
    if (ws['event / turn_finished'] !== undefined && (ws['event / assistant_message'] ?? 0) > 0) {
      for (let k = 0; k < 60; k += 1) await tick()
      break
    }
  }

  const log = globalThis.__REPLICA_DELIVER__ ?? []
  const snaps = log.map((x, i) => (x === 'snapshot' ? i : -1)).filter((i) => i >= 0)
  return JSON.stringify(
    {
      投递日志条数: log.length,
      快照出现的位置: snaps,
      快照次数: snaps.length,
      跟随流登记: (globalThis.__REPLICA_FOLLOW__ ?? []).map((e) => ({
        会话: String(e.sessionId ?? '').slice(0, 8),
        记录数: e.records,
        补进条数: e.appends,
      })),
      我发的会话: String(sessionId).slice(0, 8),
      开步记录: globalThis.__REPLICA_STEP_OPEN__ ?? [],
      投递日志: log.slice(-26),
    },
    null,
    1,
  )
})()
