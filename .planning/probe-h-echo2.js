(async () => {
  /*
   * 与 probe-e-live2 同一套（那套实测能稳定跑通），只在结尾多算几个指标：
   * 用户消息在 DOM 里到底有几行 —— 这是"本地回声气泡撤掉了没有"的判据。
   *
   * ⚠️ 属性名里有空格必须用方括号。
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const step = (obj) => {
    const node = document.getElementById('__probe')
    if (node !== null) node.textContent = JSON.stringify(obj, null, 1)
  }
  const flowRows = () =>
    [...document.querySelectorAll('[data-chat-flow-kind]')].map((e) => ({
      kind: e.getAttribute('data-chat-flow-kind'),
      text: norm(e.textContent).slice(0, 70),
    }))

  const out = { 阶段: '开始' }
  step(out)

  const chip = document.querySelector('._7sEdaW_workspace')
  if (chip !== null && norm(chip.textContent) === '选择工作区') {
    chip.click()
    await sleep(900)
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((e) =>
      norm(e.textContent).includes('MVS Agent'),
    )
    if (item !== undefined) item.click()
    await sleep(3000)
  }

  const follow = globalThis.__REPLICA_FOLLOW__ || []
  const entry = follow[follow.length - 1]
  const sessionId = entry.sessionId
  out.会话号 = sessionId
  out.阶段 = '打开会话'
  step(out)

  const editor = document.querySelector('[contenteditable="true"]')
  editor.focus()
  const TEXT = '只回复两个字：柠檬'
  document.execCommand('insertText', false, TEXT)
  await sleep(400)
  out.草稿 = norm(editor.textContent)
  if (out.草稿 === '') {
    editor.dispatchEvent(
      new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: TEXT,
        bubbles: true,
        cancelable: true,
      }),
    )
    await sleep(400)
    out.草稿改用beforeinput后 = norm(editor.textContent)
  }

  const send = [...document.querySelectorAll('button')].find(
    (b) => (b.getAttribute('aria-label') || '') === '发送消息',
  )
  out.发送按钮禁用 = send.disabled
  send.click()
  out.阶段 = '已发送'
  step(out)

  /*
   * 没有 sleep 的循环：虚拟时钟只在没有未完成网络请求时前进，
   * 所以用 fetch 当节拍器能撑住比预算长得多的**真实**时间。
   */
  let i = 0
  let 用户消息时 = null
  let 回复时 = null
  const vstart = Date.now()
  for (; i < 40000; i += 1) {
    await (await fetch('/projection?sessionId=' + encodeURIComponent(sessionId))).json()
    const rows = flowRows()
    if (用户消息时 === null && rows.some((r) => r.kind === 'user' && r.text.includes('柠檬'))) {
      用户消息时 = i
    }
    const asst = rows
      .filter((r) => r.kind !== 'user')
      .map((r) => r.text)
      .join(' ')
    if (用户消息时 !== null && /柠檬/.test(asst)) {
      回复时 = i
      break
    }
    if (i % 20 === 0) {
      out.轮数 = i
      out.虚拟已用毫秒 = Date.now() - vstart
      out.发后结构 = rows
      step(out)
    }
    if (Date.now() - vstart > 25000) break
  }

  const rows = flowRows()
  out.轮数 = i
  out.虚拟已用毫秒 = Date.now() - vstart
  out.看到用户消息时_轮 = 用户消息时
  out.看到回复时_轮 = 回复时
  out.阶段 = '结束'
  out.流程行 = rows
  out['含这句话的 user 行数'] = rows.filter((r) => r.kind === 'user' && r.text.includes('柠檬')).length
  out['含这句话的所有行数'] = rows.filter((r) => r.text.includes('柠檬')).length
  out.跟随日志增量 = entry.appended
  out.跟随日志追加次数 = entry.appends
  step(out)
  return out
})()
