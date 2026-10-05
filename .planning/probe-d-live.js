(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  /*
   * 每一步都往探针那个 pre 里写一次。
   *
   * 为什么不是最后写一次就完：浏览器的 `--virtual-time-budget` 到点就 dump，
   * 而 dump 时如果 async 那段还没跑完，pre 是空的 —— 现象是**一个字都没有**，
   * 看着像页面没加载。分步写的话，哪怕被截断也能看到它走到哪一步了。
   */
  const step = (obj) => {
    const node = document.getElementById('__probe')
    if (node !== null) node.textContent = JSON.stringify(obj, null, 1)
  }

  const flows = () =>
    [...document.querySelectorAll('[data-chat-flow-kind]')].map(
      (e) => e.getAttribute('data-chat-flow-kind') + ' | ' + norm(e.innerText).slice(0, 60),
    )
  const assistantText = () =>
    [...document.querySelectorAll('[data-chat-flow-kind]')]
      .filter((e) => e.getAttribute('data-chat-flow-kind') !== 'user')
      .map((e) => norm(e.innerText))
      .join(' ~ ')

  const out = { 阶段: '开始' }
  step(out)

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
  const entry = follow[follow.length - 1]
  const sessionId = entry.sessionId
  out.会话号 = sessionId
  out.阶段 = '打开会话'
  out.发前结构 = flows()
  step(out)

  const editor = document.querySelector('[contenteditable="true"]')
  editor.focus()
  const TEXT = '只回复两个字：菠萝'
  document.execCommand('insertText', false, TEXT)
  await sleep(300)
  out.草稿 = norm(editor.innerText)

  const rpcBefore = (globalThis.__REPLICA_RPC__ || []).length
  const send = [...document.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') || '') === '发送消息',
  )
  send.click()
  out.阶段 = '已发送'
  step(out)

  let 轮数 = 0
  let 看到用户消息时 = null
  let 看到回复时 = null
  for (; 轮数 < 80; 轮数 += 1) {
    await sleep(250)
    const res = await fetch('/projection?sessionId=' + encodeURIComponent(sessionId))
    const p = (await res.json()).projection
    if (看到用户消息时 === null && flows().some((f) => f.startsWith('user') && f.includes('菠萝'))) {
      看到用户消息时 = 轮数
    }
    const asst = assistantText()
    if (看到用户消息时 !== null && /菠萝/.test(asst)) {
      看到回复时 = 轮数
      break
    }
    out.轮数 = 轮数
    out.守护进程状态 = p.status
    out.守护进程消息数 = (p.messages || []).length
    out.发后结构 = flows()
    step(out)
    if (p.status !== 'running' && 轮数 > 4) break
  }

  await sleep(1200)
  out.轮数 = 轮数
  out.看到用户消息时_轮 = 看到用户消息时
  out.看到回复时_轮 = 看到回复时
  out.阶段 = '结束'
  out.发后结构 = flows()
  out.回复文本 = assistantText().slice(0, 200)
  out.新增RPC = (globalThis.__REPLICA_RPC__ || [])
    .slice(rpcBefore)
    .map((r) => r.method + ' | ' + (r.ok ? 'ok' : 'FAIL') + ' | ' + r.detail)
  out.跟随日志 = follow.map((e) => ({
    sessionId: e.sessionId,
    messages: e.messages,
    status: e.status,
    cursor: e.cursor,
    appends: e.appends,
    appended: e.appended,
  }))
  step(out)
  return out
})()
