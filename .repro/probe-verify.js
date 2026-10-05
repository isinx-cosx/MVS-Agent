/*
 * 流式渲染的**验收探针**（用真实网络请求驱动时间，理由见 probe-live2.js）。
 *
 * 三件事一起判：
 *   1. **流式**：文字在回合**还没结束**的时候就已经长出来，且随增量递增
 *   2. **顺序**：durable 的边界事件是 turn/start → user/message → step/start
 *      → assistant/message → step/end → turn/end，**没有重复的 step 边界**
 *   3. **收尾**：回合结束后文字**还在**（不是先流出来、最后又被撤掉）
 *
 * 另外把垫片那三个绊线（控制台 error/warn）一起带回来。
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
  out.开流前已有记录 = opened.records

  const text = '请用大约二十个字介绍一下你自己，只输出正文。'
  await fetch('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'user_message', sessionId: sessionId, text: text }),
  })

  /*
   * 「边跑边看」的判据：在 `assistant_message` **还没到**的时候，页面上就已经
   * 有正文了。所以两条曲线一起采：在线帧数 和 页面长度。
   */
  const marks = []
  let streamingWhileRunning = false
  let prevKey = ''
  for (let i = 0; i < 4000; i += 1) {
    await tick()
    const ws = globalThis.__REPLICA_WS_COUNT__ ?? {}
    const live = globalThis.__REPLICA_LIVE__ ?? []
    const f = (globalThis.__REPLICA_FOLLOW__ ?? []).find((e) => e.sessionId === sessionId)
    const body = document.body.innerText || ''
    if (ws['event / assistant_message'] === undefined && live.length > 2 && body.includes('收到')) {
      streamingWhileRunning = true
    }
    const key = [
      ws['event / model_text_delta'] ?? 0,
      live.length,
      f?.appends ?? 0,
      body.length,
    ].join(',')
    if (key !== prevKey) {
      marks.push({ 第几次: i, 正文增量: ws['event / model_text_delta'] ?? 0, 在线帧数: live.length, 跟随流条数: f?.appends ?? 0, 页面长度: body.length, 含收到: body.includes('收到') })
      prevKey = key
    }
    if (ws['event / turn_finished'] !== undefined && (f?.appends ?? 0) > 0) {
      /* 再等几跳，看收尾之后文字有没有被撤掉 */
      for (let k = 0; k < 40; k += 1) await tick()
      break
    }
  }

  const f = (globalThis.__REPLICA_FOLLOW__ ?? []).find((e) => e.sessionId === sessionId)
  const body = document.body.innerText || ''
  out.结论 = {
    边跑边显示正文: streamingWhileRunning,
    收尾后文字还在: body.includes('收到') && body.includes('假端点'),
    收尾后页面长度: body.length,
    事件序列: f?.appended ?? [],
    事件条数: f?.appends ?? 0,
    重复的step_start: (f?.appended ?? []).filter((t) => t === 'step/start').length,
  }
  out.时间线 = marks.filter((m, i) => i === 0 || i === marks.length - 1 || m.第几次 % 1 === 0).slice(-25)
  out.控制台 = (globalThis.__PROBE_CONSOLE__ ?? []).slice(-10)
  out.页面尾部 = body.slice(-260)
  out.阶段 = '结束'
  return JSON.stringify(out, null, 1)
})()
