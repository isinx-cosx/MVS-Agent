/*
 * 页面侧流式渲染判据（**用真实网络请求驱动时间**）。
 *
 * ⚠️ 不能用 `sleep()` 采样：探针跑在 `--virtual-time-budget` 下，虚拟时钟在没有
 * 未完成网络请求时会**一口气快进**，于是 24 × 400ms 的循环在几毫秒内跑完 ——
 * 守护进程那时还没开始推增量。现象是"什么都没收到"，而那是**测量假象**。
 * 每一次迭代都 `await fetch('/state')`，时钟才会跟着真实时间走。
 *
 * 判据（五个断点各自的数）：
 *   1. WS 上来了哪些帧          __REPLICA_WS_COUNT__
 *   2. 垫片收下几条增量         __REPLICA_ACCEPT__
 *   3. 垫片投出几条在线帧       __REPLICA_LIVE__
 *   4. 跟随流补进几条           __REPLICA_FOLLOW__[].appends
 *   5. 界面什么时候出现正文      body.innerText 里「收到」
 */
;(async () => {
  if (globalThis.__PROBE_CONSOLE__ === undefined) {
    globalThis.__PROBE_CONSOLE__ = []
    const push = (kind, args) => {
      try {
        globalThis.__PROBE_CONSOLE__.push(
          kind + ': ' + args.map((a) => String(a?.message ?? a)).join(' ').slice(0, 300),
        )
      } catch {
        /* 钩子自己别炸 */
      }
    }
    const realError = console.error.bind(console)
    console.error = (...args) => {
      push('error', args)
      realError(...args)
    }
    const realWarn = console.warn.bind(console)
    console.warn = (...args) => {
      push('warn', args)
      realWarn(...args)
    }
    globalThis.addEventListener('error', (event) => push('uncaught', [event.message]))
    globalThis.addEventListener('unhandledrejection', (event) =>
      push('rejection', [String(event.reason?.message ?? event.reason)]),
    )
  }

  const out = { 阶段: '开始' }
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i += 1) await fetch('/state')
  }

  const state = await (await fetch('/state')).json()
  const sessions = state.state.sessions ?? []
  out.守护进程会话数 = sessions.length

  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  out.侧栏会话行数 = rows.length
  if (rows[0] !== undefined) rows[0].click()
  await tick(20)

  const follows = globalThis.__REPLICA_FOLLOW__ ?? []
  out.点开后跟随流 = follows.map((e) => ({
    会话: String(e.sessionId ?? '').slice(0, 8),
    状态: e.status,
    消息数: e.messages,
    记录数: e.records,
    补进条数: e.appends,
  }))
  const opened = follows[follows.length - 1]
  if (opened === undefined) {
    out.结论 = '点了会话行但界面没开任何跟随流 —— 这一步就断了'
    return JSON.stringify(out, null, 1)
  }
  const sessionId = opened.sessionId
  out.发的会话 = String(sessionId).slice(0, 8)

  out.发送前 = {
    页面长度: (document.body.innerText || '').length,
    订阅包: (globalThis.__REPLICA_WATCH__ ?? []).slice(-2),
  }

  await fetch('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'user_message',
      sessionId: sessionId,
      text: '请简要介绍一下你自己，只输出正文。',
    }),
  })

  const samples = []
  let sawTurnFinished = false
  for (let i = 1; i <= 400 && !sawTurnFinished; i += 1) {
    await tick(1)
    const body = document.body.innerText || ''
    const live = globalThis.__REPLICA_LIVE__ ?? []
    const ws = globalThis.__REPLICA_WS_COUNT__ ?? {}
    if (ws['event / turn_finished'] !== undefined) sawTurnFinished = true
    samples.push({
      第几次: i,
      页面长度: body.length,
      含收到: body.includes('收到'),
      助手事件: ws['event / assistant_message'] ?? 0,
      正文增量: ws['event / model_text_delta'] ?? 0,
      垫片收到正文: (globalThis.__REPLICA_ACCEPT__ ?? {})['收到正文增量'] ?? 0,
      在线帧数: live.length,
      在线帧尾: live.slice(-2),
      跟随流补进: (globalThis.__REPLICA_FOLLOW__ ?? []).reduce((n, e) => n + (e.appends ?? 0), 0),
    })
  }

  /* 只留「有变化」的那些采样，否则 400 行没法看 */
  const compact = []
  let lastKey = ''
  for (const s of samples) {
    const key = [s.含收到, s.正文增量, s.垫片收到正文, s.在线帧数, s.跟随流补进, s.助手事件].join('|')
    if (key !== lastKey) {
      compact.push(s)
      lastKey = key
    }
  }
  out.采样数 = samples.length
  out.变化点 = compact
  out.最后一采样 = samples[samples.length - 1] ?? null
  out.WS计数 = { ...(globalThis.__REPLICA_WS_COUNT__ ?? {}) }
  out.垫片计数 = { ...(globalThis.__REPLICA_ACCEPT__ ?? {}) }
  out.在线帧明细 = (globalThis.__REPLICA_LIVE__ ?? []).slice(0, 12)
  out.控制台 = (globalThis.__PROBE_CONSOLE__ ?? []).slice(-15)
  out.页面尾部 = (document.body.innerText || '').slice(-300)
  out.阶段 = '结束'
  return JSON.stringify(out, null, 1)
})()
