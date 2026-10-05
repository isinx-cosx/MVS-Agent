(async () => {
  const main = document.querySelector('main') || document.body
  const text = () => (main.innerText || '').split('\n').filter((s) => s.trim() !== '')

  const before = text()

  const find = (label) =>
    [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].find(
      (el) =>
        (el.getAttribute('aria-label') || '').trim() === label ||
        (el.innerText || '').trim() === label,
    )

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
  await new Promise((r) => setTimeout(r, 4000))

  const after = text()

  // 直接在页面里验那三条硬约束 —— 这是「我发的帧合法吗」的答案
  const journals = (globalThis.__REPLICA_FOLLOW__ || []).map((entry) => {
    const seqs = entry.types.map((_, i) => i)
    return {
      sessionId: entry.sessionId,
      messages: entry.messages,
      records: entry.records,
      cursor: entry.cursor,
      尾seq对得上cursor: entry.records === 0 ? entry.cursor === -1 : entry.cursor === entry.records - 1,
      事件类型: entry.types.reduce((acc, t) => {
        acc[t] = (acc[t] || 0) + 1
        return acc
      }, {}),
      _seqs: seqs.length,
    }
  })

  return {
    主区域_前: before.slice(0, 20),
    主区域_后: after.slice(0, 20),
    还显示选择工作区开始: after.some((s) => s.includes('选择一个工作区开始')),
    会话流: (globalThis.__REPLICA_STREAMS__ || []).filter((r) => r.endpoint === 'session/follow'),
    跟随日志: journals,
    RPC: (globalThis.__REPLICA_RPC__ || []).map((r) => r.method + ':' + (r.ok ? 'ok' : r.detail)).slice(-8),
  }
})()
