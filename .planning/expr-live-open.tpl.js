(async () => {
  const region = () => document.querySelector('[data-phase]')
  const text = () => {
    const el = region()
    return el === null ? [] : (el.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s !== '')
  }
  const TARGET = '__SESSION__'

  const rowsNow = () => [...document.querySelectorAll('.tPVXea_listArea [role="treeitem"]')]
  const group = rowsNow().find((el) => el.getAttribute('aria-expanded') === 'false')
  if (group !== undefined) group.click()
  await new Promise((r) => setTimeout(r, 700))

  const row = rowsNow().find((el) => (el.getAttribute('data-row-key') || '').includes(TARGET))
  let clicked = null
  if (row !== undefined) {
    clicked = (row.innerText || '').trim()
    row.click()
  }
  await new Promise((r) => setTimeout(r, 5000))

  const after = text()
  return {
    点的是: clicked,
    点到了没有: row !== undefined,
    会话区phase: region() === null ? null : region().getAttribute('data-phase'),
    会话区文字: after,
    跟随日志: (globalThis.__REPLICA_FOLLOW__ || [])
      .filter((e) => e.sessionId === TARGET)
      .map((e) => ({
        messages: e.messages,
        records: e.records,
        cursor: e.cursor,
        types: e.types.reduce((a, t) => ((a[t] = (a[t] || 0) + 1), a), {}),
      })),
  }
})()
