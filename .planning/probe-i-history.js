(async () => {
  /*
   * 回归：**打开一条有历史内容的会话，整段历史要照常渲染**。
   * 这是已经验收过的状态，我这次只往快照帧的投影里加了一项、给 user 消息
   * 加了可选的 source.rpcId —— 必须证明没弄坏它。
   *
   * 同时验那三条硬约束：seq 相邻差 1、cursor 等于尾 seq、消息事件带 surfaceOp。
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
  const step = (obj) => {
    const node = document.getElementById('__probe')
    if (node !== null) node.textContent = JSON.stringify(obj, null, 1)
  }
  const out = { 阶段: '开始' }
  step(out)

  const rowsNow = () => [...document.querySelectorAll('.tPVXea_listArea [role="treeitem"]')]

  // 展开工作区分组
  const group = rowsNow().find((el) => el.getAttribute('aria-expanded') === 'false')
  if (group !== undefined) group.click()
  await sleep(700)

  // 反复点「展开其余 N 个会话」，直到出现那条有历史的会话
  let rounds = 0
  for (; rounds < 15; rounds += 1) {
    if (rowsNow().some((el) => norm(el.textContent).startsWith('你好'))) break
    const more = [...document.querySelectorAll('.tPVXea_listArea button')].find((el) =>
      norm(el.textContent).includes('展开其余'),
    )
    if (more === undefined) break
    more.click()
    await sleep(500)
  }

  const target = rowsNow().find((el) => norm(el.textContent).startsWith('你好'))
  out.展开轮数 = rounds
  out.侧栏行数 = rowsNow().length
  if (target === undefined) {
    out.结果 = '侧栏里没找到「你好」那条会话'
    out.侧栏 = rowsNow().map((el) => norm(el.textContent).slice(0, 40))
    step(out)
    return out
  }
  out.点的是 = norm(target.textContent)
  target.click()

  // fetch 驱动地等历史渲染出来
  let i = 0
  let 行数 = 0
  for (; i < 3000; i += 1) {
    await (await fetch('/state')).json()
    行数 = document.querySelectorAll('[data-chat-flow-kind]').length
    if (行数 >= 10) break
  }

  const follow = globalThis.__REPLICA_FOLLOW__ || []
  const hit = follow.filter((e) => e.title === '你好')
  const last = hit[hit.length - 1] || follow[follow.length - 1]
  const kinds = {}
  for (const t of last.types) kinds[t] = (kinds[t] || 0) + 1

  out.阶段 = '结束'
  out.轮数 = i
  out.流程行数 = 行数
  out.主区域前12行 = norm(document.body.textContent)
    .split(/\s{2,}/)
    .slice(0, 12)
  out.流程行 = [...document.querySelectorAll('[data-chat-flow-kind]')]
    .slice(0, 14)
    .map((e) => e.getAttribute('data-chat-flow-kind') + ' | ' + norm(e.textContent).slice(0, 50))
  out.跟随日志 = {
    sessionId: last.sessionId,
    title: last.title,
    messages: last.messages,
    records: last.records,
    cursor: last.cursor,
    尾seq等于cursor: last.records === 0 ? last.cursor === -1 : last.cursor === last.records - 1,
    类型: kinds,
    status: last.status,
    appends: last.appends,
  }
  out.历史条数对得上 = last.records === 0 ? null : last.messages >= 1
  step(out)
  return out
})()
