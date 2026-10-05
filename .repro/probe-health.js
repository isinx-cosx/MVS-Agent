/* 体检：点了会话行之后，跟随流和订阅 socket 到底建起来没有。 */
;(async () => {
  const console_ = []
  const show = (a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a?.message ?? a))
  const realError = console.error.bind(console)
  console.error = (...a) => {
    console_.push('error: ' + a.map(show).join(' ').slice(0, 240))
    realError(...a)
  }
  const realWarn = console.warn.bind(console)
  console.warn = (...a) => {
    console_.push('warn: ' + a.map(show).join(' ').slice(0, 240))
    realWarn(...a)
  }

  const tick = async () => fetch('/state')
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  if (rows[0] !== undefined) rows[0].click()
  for (let i = 0; i < 60; i += 1) await tick()

  const follows = globalThis.__REPLICA_FOLLOW__ ?? []
  return JSON.stringify(
    {
      会话行数: rows.length,
      跟随流条数: follows.length,
      跟随流尾巴: follows.slice(-2).map((e) => ({
        会话: String(e.sessionId ?? '').slice(0, 8),
        状态: e.status,
        记录数: e.records,
        补进条数: e.appends,
      })),
      订阅包: (globalThis.__REPLICA_WATCH__ ?? []).slice(-3),
      WS计数: { ...(globalThis.__REPLICA_WS_COUNT__ ?? {}) },
      开步记录: globalThis.__REPLICA_STEP_OPEN__ ?? [],
      控制台: console_.slice(-6),
    },
    null,
    1,
  )
})()
