(async () => {
  /*
   * ⚠️ 这个探针活在 `--virtual-time-budget=20000` 下面：`setTimeout` 走**虚拟时钟**
   * 并被快进（实测 10 秒虚拟 ≈ 1 秒真实），所以"睡等模型"等不到 —— 预算一烧完
   * 就 dump DOM。虚拟时钟**只在没有未完成网络请求时前进**，所以这里所有等待
   * 都用 `fetch` 驱动：`until()` 每轮打一次 `/state`，几乎不烧虚拟预算。
   *
   * 另外：属性名里有空格的**必须**用方括号写（`out['a b']`），
   * 写成 `out.a b` 是语法错误 —— 而注入脚本一旦解析失败，**一个字都不会输出**，
   * 看着像"页面没加载"。
   */
  const node = document.getElementById('__probe')
  const step = (obj) => {
    if (node !== null) node.textContent = JSON.stringify(obj, null, 1)
  }
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const ping = async () => (await fetch('/state')).json()
  const until = async (predicate, cap = 4000) => {
    for (let i = 0; i < cap; i += 1) {
      const value = predicate()
      if (value !== undefined && value !== null && value !== false) return value
      await ping()
    }
    return undefined
  }

  const flowRows = () =>
    [...document.querySelectorAll('[data-chat-flow-kind]')].map((e) => ({
      kind: e.getAttribute('data-chat-flow-kind'),
      text: norm(e.textContent).slice(0, 70),
    }))

  const out = { 阶段: '开始', 探针节点在: node !== null }
  step(out)

  // 1. 首屏是 hero：等铭牌出现，点它，选工作区（这些等待都不烧虚拟预算）
  const chip = await until(() => {
    const el = document.querySelector('._7sEdaW_workspace')
    return el === null ? undefined : el
  })
  if (chip === null || chip === undefined) return { 结果: '等不到工作区铭牌' }
  if (norm(chip.textContent) === '选择工作区') {
    chip.click()
    const item = await until(() =>
      [...document.querySelectorAll('[role="menuitem"]')].find((e) =>
        norm(e.textContent).includes('MVS Agent'),
      ),
    )
    if (item !== undefined) item.click()
  }

  const follow = globalThis.__REPLICA_FOLLOW__ || []
  const entry = await until(() => (follow.length === 0 ? undefined : follow[follow.length - 1]))
  if (entry === undefined) return { 结果: '等不到会话流' }
  const sessionId = entry.sessionId
  out.会话号 = sessionId
  out.阶段 = '打开会话'
  step(out)

  // 2. 填一句话
  const editor = await until(() => document.querySelector('[contenteditable="true"]'))
  editor.focus()
  const TEXT = '只回复两个字：柠檬'
  document.execCommand('insertText', false, TEXT)
  out.草稿 = norm(editor.textContent)
  step(out)

  // 3. 发送
  const send = await until(() =>
    [...document.querySelectorAll('button')].find(
      (b) => (b.getAttribute('aria-label') || '') === '发送消息',
    ),
  )
  send.click()
  out.阶段 = '已发送'
  step(out)

  // 4. fetch 驱动的等待：看用户消息什么时候出现、回复什么时候出现
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
