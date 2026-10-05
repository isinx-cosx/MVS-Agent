(async () => {
  const find = (label) =>
    [...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].find(
      (el) =>
        (el.getAttribute('aria-label') || '').trim() === label ||
        (el.innerText || '').trim() === label,
    )

  const before = (globalThis.__REPLICA_FOLLOW__ || []).length

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
  await new Promise((r) => setTimeout(r, 3000))

  const created = (globalThis.__REPLICA_FOLLOW__ || []).slice(before)
  const sessionId = created.length === 0 ? null : created[created.length - 1].sessionId

  let sent = null
  if (sessionId !== null) {
    const res = await fetch('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user_message', sessionId, text: '只回答两个字：你好' }),
    })
    sent = { status: res.status, body: await res.text() }
  }
  await new Promise((r) => setTimeout(r, 1500))

  return { 新会话: sessionId, 发命令: sent, 跟随日志: created }
})()
