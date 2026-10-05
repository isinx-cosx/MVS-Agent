/*
 * 复现「完全不流式、最后整段蹦出来」，并同时抓五个断点的计数：
 *
 *   1. 守护进程 → 垫片      __REPLICA_WS_COUNT__（WS 上来了哪些帧）
 *   2. 垫片收下增量         __REPLICA_ACCEPT__（收到几条、订阅者几个）
 *   3. 垫片投递在线帧       __REPLICA_LIVE__（真的发出去了几条）
 *   4. 界面开过跟随流       __REPLICA_FOLLOW__（appends = 增量补进去几条）
 *   5. 客户端画出来没有     body.innerText 里「收到」什么时候出现
 *
 * 判据：如果第 5 步的「含收到」只在最后一两个采样里翻成 true，
 * 而前面几步都有数，那就是**闸门**问题（客户端不认在线行）；
 * 如果第 1 步就没有 model_text_delta，那是守护进程/订阅那一段。
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

  const state = await (await fetch('/state')).json()
  const sessions = state.state.sessions ?? []
  const target = sessions[0]
  if (target === undefined) return JSON.stringify({ 结论: '还没有会话' }, null, 1)
  out.会话 = String(target.sessionId).slice(0, 8)
  out.会话标题 = target.title ?? null

  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  out.会话行数 = rows.length
  const row = rows.find((el) => (el.innerText || '').includes(String(target.title ?? '').slice(0, 5))) ?? rows[0]
  out.点到行 = row !== undefined
  if (row !== undefined) row.click()
  await sleep(4000)

  out.点开后跟随流 = (globalThis.__REPLICA_FOLLOW__ ?? []).map((e) => ({
    会话: String(e.sessionId ?? '').slice(0, 8),
    状态: e.status,
    消息数: e.messages,
    游标: e.cursor,
    记录数: e.records,
    补进条数: e.appends,
  }))
  out.订阅包 = (globalThis.__REPLICA_WATCH__ ?? []).slice(-3)
  out.发送前页面长度 = (document.body.innerText || '').length

  await fetch('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'user_message',
      sessionId: target.sessionId,
      text: '请简要介绍一下你自己，只输出正文。',
    }),
  })
  out.已发送 = true

  const samples = []
  for (let i = 1; i <= 24; i += 1) {
    await sleep(400)
    const body = document.body.innerText || ''
    const live = globalThis.__REPLICA_LIVE__ ?? []
    samples.push({
      第几次: i,
      页面长度: body.length,
      含收到: body.includes('收到'),
      含假端点: body.includes('假端点'),
      WS计数: { ...(globalThis.__REPLICA_WS_COUNT__ ?? {}) },
      垫片收到: { ...(globalThis.__REPLICA_ACCEPT__ ?? {}) },
      在线帧数: live.length,
      在线帧尾: live.slice(-3),
      跟随流补进: (globalThis.__REPLICA_FOLLOW__ ?? []).reduce((n, e) => n + (e.appends ?? 0), 0),
    })
  }

  out.采样 = samples
  out.控制台 = (globalThis.__PROBE_CONSOLE__ ?? []).slice(-15)
  out.落盘记录 = (globalThis.__REPLICA_ASSISTANT__ ?? []).slice(-3)
  out.页面尾部 = (document.body.innerText || '').slice(-400)
  out.阶段 = '结束'
  return JSON.stringify(out, null, 1)
})()
