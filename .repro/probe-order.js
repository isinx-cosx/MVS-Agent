/*
 * 判定「顺序」：在线增量（transient）和 durable 的 `step/start` 谁先到。
 *
 * 依据（客户端 `dsh-client-ui-chat` 的 assistantDefinition）：
 *
 *   match(step/start)                → role:'start'   ← 节点在这里被**创建**
 *   match(assistant/live-chunk)      → role:'update'  ← 只更新已存在的节点
 *   start: 只在 step/start 上成立，其它类型直接 throw
 *
 * 所以如果增量先到、`step/start` 后到，那些增量会**落在一个还不存在的节点上**
 * —— 不报错、不抛异常，就是什么都不显示，直到 durable 的 assistant/message
 * 到了才整段出现。
 *
 * 采样用真实请求驱动（见 probe-live2.js 顶部的说明）。
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
  const tick = async () => fetch('/state')

  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  if (rows[0] === undefined) return JSON.stringify({ 结论: '侧栏没有会话行' }, null, 1)
  rows[0].click()
  for (let i = 0; i < 30; i += 1) await tick()

  const follows = globalThis.__REPLICA_FOLLOW__ ?? []
  const opened = follows[follows.length - 1]
  if (opened === undefined) return JSON.stringify({ 结论: '没有跟随流' }, null, 1)
  const sessionId = opened.sessionId
  out.会话 = String(sessionId).slice(0, 8)
  out.点开后 = {
    类型: opened.types,
    补进: opened.appended,
    记录数: opened.records,
    游标: opened.cursor,
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

  /* 「事件时间线」：把 WS 计数 + 跟随流补进的每一条，按观察到的先后记下来 */
  const timeline = []
  let seenTurnFinished = false
  let prev = ''
  for (let i = 0; i < 4000 && !seenTurnFinished; i += 1) {
    await tick()
    const ws = globalThis.__REPLICA_WS_COUNT__ ?? {}
    const live = globalThis.__REPLICA_LIVE__ ?? []
    const f = (globalThis.__REPLICA_FOLLOW__ ?? []).find((e) => e.sessionId === sessionId)
    const body = document.body.innerText || ''
    const key = [
      ws['event / turn_started'] ?? 0,
      ws['event / step_started'] ?? 0,
      ws['event / model_text_delta'] ?? 0,
      ws['event / assistant_message'] ?? 0,
      ws['event / turn_finished'] ?? 0,
      live.length,
      f?.appends ?? 0,
      body.includes('收到') ? 'Y' : 'N',
    ].join(',')
    if (key !== prev) {
      timeline.push({
        第几次: i,
        seq: ws,
        跟随流补进条数: f?.appends ?? 0,
        补进类型: (f?.appended ?? []).slice(-6),
        在线帧数: live.length,
        页面含收到: body.includes('收到'),
        页面长度: body.length,
      })
      prev = key
    }
    if (ws['event / turn_finished'] !== undefined) seenTurnFinished = true
  }

  out.时间线 = timeline
  out.看到回合结束 = seenTurnFinished
  out.最终 = {
    WS: { ...(globalThis.__REPLICA_WS_COUNT__ ?? {}) },
    垫片: { ...(globalThis.__REPLICA_ACCEPT__ ?? {}) },
    在线帧数: (globalThis.__REPLICA_LIVE__ ?? []).length,
    跟随流: (globalThis.__REPLICA_FOLLOW__ ?? [])
      .filter((e) => e.sessionId === sessionId)
      .map((e) => ({ 类型: e.types, 补进: e.appended, 条数: e.appends })),
    页面长度: (document.body.innerText || '').length,
    页面含收到: (document.body.innerText || '').includes('收到'),
  }
  out.控制台 = (globalThis.__PROBE_CONSOLE__ ?? []).slice(-15)
  out.页面尾部 = (document.body.innerText || '').slice(-500)
  out.阶段 = '结束'
  return JSON.stringify(out, null, 1)
})()
