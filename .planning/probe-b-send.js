(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()

  const projectionOf = async (sessionId) => {
    const res = await fetch('/projection?sessionId=' + encodeURIComponent(sessionId))
    const body = await res.json()
    const p = body.projection
    const msgs = p.messages || []
    return {
      status: p.status,
      model: p.model,
      messages: msgs.length,
      last: msgs.length === 0 ? null : msgs[msgs.length - 1].role + ':' + String(msgs[msgs.length - 1].content).slice(0, 40),
    }
  }

  // 1. 打开一条会话（首屏是 hero，选一次工作区）
  const chip = document.querySelector('._7sEdaW_workspace')
  if (chip !== null && norm(chip.innerText) === '选择工作区') {
    chip.click()
    await sleep(900)
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((e) =>
      norm(e.innerText).includes('MVS Agent'),
    )
    if (item !== undefined) item.click()
    await sleep(4000)
  }

  const follow = globalThis.__REPLICA_FOLLOW__ || []
  const last = follow[follow.length - 1]
  const sessionId = last.sessionId

  const before = await projectionOf(sessionId)

  // 2. 往输入框填一句话
  const editor = document.querySelector('[contenteditable="true"]')
  editor.focus()
  const TEXT = '只回复两个字：你好'
  let 填法 = 'execCommand'
  document.execCommand('insertText', false, TEXT)
  await sleep(400)
  if (norm(editor.innerText) === '') {
    填法 = 'beforeinput'
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: TEXT,
        bubbles: true,
        cancelable: true,
      }),
    )
    await sleep(400)
  }
  const 草稿 = norm(editor.innerText)

  const rpcBefore = (globalThis.__REPLICA_RPC__ || []).length

  // 3. 点「发送消息」
  const send = [...document.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') || '') === '发送消息',
  )
  if (send === undefined) return { 结果: '找不到发送按钮' }
  const 发送按钮禁用 = send.disabled
  send.click()

  await sleep(2500)
  const 发后草稿 = norm(editor.innerText)
  const 新增RPC = (globalThis.__REPLICA_RPC__ || []).slice(rpcBefore).map(
    (r) => r.method + ' | ' + (r.ok ? 'ok' : 'FAIL') + ' | ' + r.detail + ' | ' + (r.payload || ''),
  )
  const after = await projectionOf(sessionId)
  const 对话区 = (document.body.innerText || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  return {
    会话号: sessionId,
    填法: 填法,
    草稿: 草稿,
    发送按钮禁用: 发送按钮禁用,
    发送后草稿: 发后草稿,
    新增RPC: 新增RPC,
    守护进程_发前: before,
    守护进程_发后: after,
    界面里出现这句话: 对话区.some((s) => s.includes('只回复两个字')),
    界面里出现你好: 对话区.some((s) => s === '你好' || s.includes('你好')),
    界面尾部: 对话区.slice(-14),
  }
})()
