/*
 * 抓「收尾时谁把事件流打断」：把 console 的 error/warn 连同**调用栈**一起带回来。
 *
 * 背景：流式已经通了（文字在回合结束前就长出来），但收尾时客户端有一个
 * 事件流订阅者抛 `received non-appended Match N`，那一趟通知就断了 ——
 * 现象是文字先流出来、最后又被撤掉。
 *
 * 光看消息只能知道"某个 context 收到了不递增的 seq"，看栈才知道是
 * 哪一条发布路径（appendLive / settleAssistant / installWindow）造成的。
 */
;(async () => {
  const stack = []
  const push = (kind, args) => {
    try {
      stack.push(
        kind +
          ': ' +
          args
            .map((a) =>
              typeof a === 'object' && a !== null && typeof a.stack === 'string'
                ? a.message + '\n' + a.stack.split('\n').slice(0, 8).join('\n')
                : String(a?.message ?? a),
            )
            .join(' ')
            .slice(0, 1400),
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
  globalThis.addEventListener('unhandledrejection', (event) => push('rejection', [event.reason]))

  const tick = async () => fetch('/state')
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  if (rows[0] === undefined) return '侧栏没有会话行'
  rows[0].click()
  for (let i = 0; i < 30; i += 1) await tick()

  const follows = globalThis.__REPLICA_FOLLOW__ ?? []
  const opened = follows[follows.length - 1]
  if (opened === undefined) return '没有跟随流'
  const sessionId = opened.sessionId

  await fetch('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'user_message',
      sessionId: sessionId,
      text: '请用大约二十个字介绍一下你自己，只输出正文。',
    }),
  })

  const ws0 = { ...(globalThis.__REPLICA_WS_COUNT__ ?? {}) }
  let lenWhileRunning = 0
  for (let i = 0; i < 4000; i += 1) {
    await tick()
    const ws = globalThis.__REPLICA_WS_COUNT__ ?? {}
    const body = document.body.innerText || ''
    if (ws['event / assistant_message'] === undefined && body.includes('收到')) {
      lenWhileRunning = body.length
    }
    if (ws['event / turn_finished'] !== undefined && (ws['event / assistant_message'] ?? 0) > 0) {
      if (i > 0) {
        for (let k = 0; k < 60; k += 1) await tick()
      }
      break
    }
  }

  const body = document.body.innerText || ''
  const f = (globalThis.__REPLICA_FOLLOW__ ?? []).find((e) => e.sessionId === sessionId)
  return JSON.stringify(
    {
      流式时的页面长度: lenWhileRunning,
      收尾后页面长度: body.length,
      收尾后含回复: body.includes('收到'),
      事件序列: f?.appended ?? [],
      在线帧尾: (globalThis.__REPLICA_LIVE__ ?? []).slice(-4),
      控制台: stack.slice(-6),
    },
    null,
    1,
  )
})()
