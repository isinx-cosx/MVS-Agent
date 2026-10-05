(async () => {
  const region = () => document.querySelector('[data-phase]')
  const text = () => {
    const el = region()
    return el === null ? [] : (el.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s !== '')
  }

  const find = (label) =>
    [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].find(
      (el) =>
        (el.getAttribute('aria-label') || '').trim() === label ||
        (el.innerText || '').trim() === label,
    )

  const followCountBefore = (globalThis.__REPLICA_FOLLOW__ || []).length

  // 点「选择工作区」→ 选一个工作区 → 新建会话
  const hero = find('选择工作区')
  if (hero !== undefined) {
    hero.click()
    await new Promise((r) => setTimeout(r, 800))
    const menu = document.querySelector('[role="menu"]')
    const item =
      menu === null
        ? undefined
        : [...menu.querySelectorAll('[role="menuitem"],button')].find(
            (el) => !(el.innerText || '').includes('添加工作区'),
          )
    if (item !== undefined) item.click()
  }
  await new Promise((r) => setTimeout(r, 3500))

  const created = (globalThis.__REPLICA_FOLLOW__ || []).slice(followCountBefore)
  const sessionId = created.length === 0 ? null : created[created.length - 1].sessionId
  const phaseAfterCreate = region() === null ? null : region().getAttribute('data-phase')
  const textAfterCreate = text()

  // 直接往守护进程发一条用户消息（界面上的输入框发不出去 —— `session/send` 那一族
  // RPC 垫片还没实现，那是另一件事）。这条命令走的是**真实**的模型调用。
  let sent = null
  if (sessionId !== null) {
    const res = await fetch('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user_message', sessionId, text: '只回答两个字：你好' }),
    })
    sent = { status: res.status, body: await res.text() }
  }

  // 分几次采样，看界面上是不是**一条条长出来**的
  const samples = []
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 4000))
    samples.push({ 第几秒: (i + 1) * 4, phase: region() === null ? null : region().getAttribute('data-phase'), 文字: text().slice(-6) })
  }

  return {
    新建的会话: sessionId,
    建完后的phase: phaseAfterCreate,
    建完后的文字: textAfterCreate,
    发命令结果: sent,
    跟随日志: (globalThis.__REPLICA_FOLLOW__ || []).slice(followCountBefore).map((e) => ({
      sessionId: e.sessionId,
      messages: e.messages,
      records: e.records,
      cursor: e.cursor,
      类型: e.types.reduce((a, t) => ((a[t] = (a[t] || 0) + 1), a), {}),
    })),
    采样: samples,
  }
})()
