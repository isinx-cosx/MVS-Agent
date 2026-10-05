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
  await new Promise((r) => setTimeout(r, 2500))

  const created = (globalThis.__REPLICA_FOLLOW__ || []).slice(before)
  const sessionId = created.length === 0 ? null : created[created.length - 1].sessionId
  const textAfterCreate = text()

  let sent = null
  if (sessionId !== null) {
    const res = await fetch('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user_message', sessionId, text: '只回答两个字：你好' }),
    })
    sent = { status: res.status, body: await res.text() }
  }
  await new Promise((r) => setTimeout(r, 4000))

  const journal = (globalThis.__REPLICA_FOLLOW__ || []).find((e) => e.sessionId === sessionId)
  return {
    新会话: sessionId,
    发命令: sent,
    建完后的会话区文字: textAfterCreate,
    发完之后的会话区文字: text(),
    会话区phase: region() === null ? null : region().getAttribute('data-phase'),
    这条流的增量: journal === undefined ? null : { appends: journal.appends, appended: journal.appended },
    快照记录数: journal === undefined ? null : journal.records,
  }
})()
