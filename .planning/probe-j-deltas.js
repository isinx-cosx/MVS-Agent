(async () => {
  /*
   * 任务 3 的前置事实核查：守护进程**到底有没有**把"模型正在输出的增量文本"推出来？
   *
   * 结论的判据必须是**线上收到的帧**，不是读代码。做法：
   *   - 用**同源 iframe 里那个原生 WebSocket**（新 realm，没有垫片的包装）
   *   - 订阅会话，然后从页面发一轮
   *   - 把收到的**每一帧**（不按 sessionId 过滤）记下来，连同 error/close
   *
   * 循环全部用 fetch 驱动：探针活在 `--virtual-time-budget=20000` 下，虚拟时钟
   * 只在没有未完成网络请求时前进，`await` 一个 WebSocket 事件会被跳过。
   */
  const step = (obj) => {
    const node = document.getElementById('__probe')
    if (node !== null) node.textContent = JSON.stringify(obj, null, 1)
  }
  const ping = () => fetch('/state').then((r) => r.json())

  const out = { 阶段: '开始' }
  step(out)

  const follow = globalThis.__REPLICA_FOLLOW__ || []
  const sessionId = follow[follow.length - 1].sessionId
  out.会话号 = sessionId

  const frame = document.createElement('iframe')
  frame.style.display = 'none'
  document.body.appendChild(frame)
  const NativeWebSocket = frame.contentWindow.WebSocket

  const frames = []
  const events = []
  const ws = new NativeWebSocket('ws://' + location.host + '/ws')
  ws.addEventListener('open', () => events.push('open'))
  ws.addEventListener('error', () => events.push('error'))
  ws.addEventListener('close', (e) => events.push('close ' + e.code))
  ws.addEventListener('message', (e) => {
    let f
    try {
      f = JSON.parse(e.data)
    } catch {
      frames.push({ 解析失败: String(e.data).slice(0, 60) })
      return
    }
    if (frames.length < 400) frames.push(f)
  })

  let i = 0
  for (; i < 4000; i += 1) {
    await ping()
    if (ws.readyState === 1) break
  }
  out.阶段 = 'WS 已连'
  out.WS状态 = ws.readyState
  out.连接事件 = events.slice()
  step(out)
  if (ws.readyState !== 1) {
    out.结果 = 'WS 连不上'
    step(out)
    return out
  }

  ws.send(JSON.stringify({ type: 'watch', sessionIds: [sessionId] }))
  for (let k = 0; k < 60; k += 1) await ping()
  out.订阅后的帧 = frames.map((f) => f.kind ?? '(无 kind)').slice(0, 20)
  out.订阅后帧数 = frames.length
  step(out)

  // 记下订阅确认帧（watch 会立刻回一份投影），后面用它的条数当分界
  const base = frames.length

  await fetch('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'user_message',
      sessionId: sessionId,
      text: '请用大约三十个字介绍一下你自己，只输出正文。',
    }),
  })
  out.阶段 = '已发命令'
  step(out)

  for (i = 0; i < 60000; i += 1) {
    await ping()
    if (
      frames
        .slice(base)
        .some((f) => f?.envelope?.event?.type === 'turn_finished')
    ) {
      break
    }
    if (i % 40 === 0) {
      out.轮数 = i
      out.这一轮收到的帧数 = frames.length - base
      out.这一轮的帧种类 = [
        ...new Set(frames.slice(base).map((f) => f.kind + ' / ' + (f.envelope?.event?.type ?? ''))),
      ]
      step(out)
    }
  }

  const mine = frames.slice(base)
  const kinds = {}
  for (const f of mine) {
    const key = (f.kind ?? '?') + ' / ' + (f.envelope?.event?.type ?? f.kind ?? '?')
    kinds[key] = (kinds[key] || 0) + 1
  }
  const deltas = mine
    .map((f) => f?.envelope?.event)
    .filter((e) => e?.type === 'model_text_delta')
    .map((e) => e.text)

  out.阶段 = '结束'
  out.轮数 = i
  out.连接事件 = events.slice()
  out.这一轮的帧种类 = kinds
  out.增量帧数 = deltas.length
  out.增量拼起来 = deltas.join('')
  out.前12个增量 = deltas.slice(0, 12)
  out.增量帧的seq = [
    ...new Set(
      mine.filter((f) => f?.envelope?.event?.type === 'model_text_delta').map((f) => f.envelope.seq),
    ),
  ]
  const res = await fetch('/projection?sessionId=' + encodeURIComponent(sessionId))
  const msgs = (await res.json()).projection.messages
  const last = msgs[msgs.length - 1]
  out.最终回复 = last.role + ': ' + String(last.content).slice(0, 120)
  step(out)
  return out
})()
