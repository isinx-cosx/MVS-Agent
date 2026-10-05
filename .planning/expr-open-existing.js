(async () => {
  const main = document.querySelector('main') || document.body
  const text = () => (main.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s !== '')
  const rowsNow = () => [...document.querySelectorAll('.tPVXea_listArea [role="treeitem"]')]

  const before = text()

  // 1. 展开工作区分组（DSH 默认折叠，所以第一次进来只看得见"未分组"那条）
  const group = rowsNow().find((el) => el.getAttribute('aria-expanded') === 'false')
  if (group !== undefined) group.click()
  await new Promise((r) => setTimeout(r, 600))

  // 2. 反复点「展开其余 N 个会话」，直到出现目标会话
  let rounds = 0
  for (; rounds < 12; rounds += 1) {
    if (rowsNow().some((el) => (el.innerText || '').trim().startsWith('你好'))) break
    const more = [...document.querySelectorAll('.tPVXea_listArea button')].find((el) =>
      (el.innerText || '').includes('展开其余'),
    )
    if (more === undefined) break
    more.click()
    await new Promise((r) => setTimeout(r, 500))
  }

  const rows = rowsNow()
  const target = rows.find((el) => (el.innerText || '').trim().startsWith('你好'))
  let clicked = null
  if (target !== undefined) {
    clicked = (target.innerText || '').trim()
    target.click()
  }
  await new Promise((r) => setTimeout(r, 5000))

  const after = text()
  const probe = ['你好！有什么问题我可以帮忙解答或处理吗？', 'C++是什么', 'C++是一种广泛使用的高级编程语言']

  return {
    展开轮数: rounds,
    侧栏行数: rows.length,
    点的是: clicked,
    主区域_前: before.slice(0, 14),
    主区域_后: after.slice(0, 40),
    还显示选择工作区开始: after.some((s) => s.includes('选择一个工作区开始')),
    命中的消息文本: probe.filter((s) => after.some((line) => line.includes(s.slice(0, 12)))),
    跟随日志: (globalThis.__REPLICA_FOLLOW__ || []).map((e) => ({
      sessionId: e.sessionId,
      title: e.title,
      messages: e.messages,
      records: e.records,
      cursor: e.cursor,
      尾seq等于cursor: e.records === 0 ? e.cursor === -1 : e.cursor === e.records - 1,
      类型: e.types.reduce((a, t) => ((a[t] = (a[t] || 0) + 1), a), {}),
    })),
  }
})()
