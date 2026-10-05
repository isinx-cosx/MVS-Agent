(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()

  const call = async (method, payload) => {
    const res = await fetch('/api/' + method, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'probe-' + method, method: method, payload: payload }),
    })
    const body = await res.json()
    return { http: res.status, rpcId回显对: body.rpcId === 'probe-' + method, result: body.result }
  }

  const chip = document.querySelector('._7sEdaW_workspace')
  if (chip !== null && norm(chip.innerText) === '选择工作区') {
    chip.click()
    await sleep(900)
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((e) =>
      norm(e.innerText).includes('MVS Agent'),
    )
    if (item !== undefined) item.click()
    await sleep(3000)
  }
  const follow = globalThis.__REPLICA_FOLLOW__ || []
  const sessionId = follow[follow.length - 1].sessionId

  const wrap = (request) => ({ args: { request: request } })

  const out = { 会话号: sessionId }

  // 1. 模型目录的真实返回
  out.modelCatalog = await call('session/modelCatalog', { args: {} })

  // 2. 切模型：应当**如实报错**
  out.selectModel = await call(
    'session/selectModel',
    wrap({ sessionId: sessionId, provider: 'mvs', model: 'gpt-5' }),
  )

  // 3. image 块：应当明确报「不支持」，不能静默丢
  out.prompt_image = await call(
    'session/prompt',
    wrap({
      requestId: 'p-img',
      sessionId: sessionId,
      mode: 'queue',
      content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
    }),
  )

  // 4. file 块
  out.prompt_file = await call(
    'session/prompt',
    wrap({
      requestId: 'p-file',
      sessionId: sessionId,
      mode: 'queue',
      content: [{ type: 'file', receiptId: 'r-1' }],
    }),
  )

  // 5. 不存在的会话
  out.prompt_未知会话 = await call(
    'session/prompt',
    wrap({
      requestId: 'p-nope',
      sessionId: '00000000-0000-0000-0000-000000000000',
      mode: 'queue',
      content: [{ type: 'text', text: 'hi' }],
    }),
  )

  // 6. 多块 text 要**拼起来**；同时这一发会让会话进入 running
  out.prompt_多块 = await call(
    'session/prompt',
    wrap({
      requestId: 'p-multi',
      sessionId: sessionId,
      mode: 'queue',
      content: [
        { type: 'text', text: '第一块' },
        { type: 'text', text: '第二块' },
      ],
    }),
  )

  // 7. 正在跑的时候再发：守护进程其实收不了，必须**在返回前**报错
  out.prompt_正忙 = await call(
    'session/prompt',
    wrap({
      requestId: 'p-busy',
      sessionId: sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: '第三句' }],
    }),
  )

  out.多块是否拼成一条 = await (async () => {
    const res = await fetch('/projection?sessionId=' + encodeURIComponent(sessionId))
    const p = (await res.json()).projection
    const users = (p.messages || []).filter((m) => m.role === 'user').map((m) => m.content)
    return { 用户消息: users, 最后一条: users[users.length - 1] }
  })()

  return out
})()
