/*
 * 多步回合的验收：假端点在「写文件」时先要一次工具调用，工具跑完再发第二次模型调用。
 *
 * 这条路要同时满足三件事，而它们互相牵制：
 *   1. 每个模型调用一个 step —— 第二次调用必须是 **新** step，不能吞
 *   2. `tool/result` 属于**它请求时那个 step**（第一步），不能落到第二步里去
 *   3. 边界不能重：不能出现 `step/end 1` 之后又 `step/start 1`
 *
 * 期望的事件序列（DSH 的形状）：
 *   turn/start · user/message
 *   step/start(1) · assistant/message · tool/call · tool/result · step/end(1)
 *   step/start(2) · assistant/message · step/end(2)
 *   turn/end
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
                ? a.message + '\n' + a.stack.split('\n').slice(0, 22).join('\n')
                : String(a?.message ?? a),
            )
            .join(' ')
            .slice(0, 3000),
      )
    } catch {
      /* 钩子自己别炸 */
    }
  }
  const realError = console.error.bind(console)
  console.error = (...a) => {
    push('error', a)
    realError(...a)
  }
  const realWarn = console.warn.bind(console)
  console.warn = (...a) => {
    push('warn', a)
    realWarn(...a)
  }
  globalThis.addEventListener('unhandledrejection', (e) => push('rejection', [e.reason]))

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
      text: '帮我写文件，内容是测试。',
    }),
  })

  let sawTextWhileRunning = false
  for (let i = 0; i < 8000; i += 1) {
    await tick()
    const ws = globalThis.__REPLICA_WS_COUNT__ ?? {}
    const body = document.body.innerText || ''
    if (ws['event / turn_finished'] === undefined && body.includes('写文件')) sawTextWhileRunning = true
    if (ws['event / turn_finished'] !== undefined) {
      for (let k = 0; k < 80; k += 1) await tick()
      break
    }
  }

  const body = document.body.innerText || ''
  const f = (globalThis.__REPLICA_FOLLOW__ ?? []).find((e) => e.sessionId === sessionId)
  const seq = f?.appended ?? []
  return JSON.stringify(
    {
      事件序列: seq,
      /*
       * ★ 投递顺序 —— 在线帧和落盘事件**合在一条线上**。
       * 判据：`frame start@1:2` / `frame block-start@1:2` 必须晚于 `event step/start`（第二步那条）。
       */
      投递顺序: (globalThis.__REPLICA_DELIVER__ ?? []).slice(-60),
      在线帧的turnStep: [
        ...new Set((globalThis.__REPLICA_LIVE__ ?? []).map((x) => x.frameType + '/' + x.turnStep)),
      ],
      step_start数: seq.filter((t) => t === 'step/start').length,
      step_end数: seq.filter((t) => t === 'step/end').length,
      工具结果位置: seq.indexOf('tool/result'),
      第二个step位置: seq.lastIndexOf('step/start'),
      收尾后页面长度: body.length,
      收尾后含最终答复: body.includes('文件已经写好了'),
      控制台: stack.slice(-8),
    },
    null,
    1,
  )
})()
