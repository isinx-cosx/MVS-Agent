(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()

  // 选工作区 → 界面切到会话（首屏默认是 hero）
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
  const last = follow[follow.length - 1] || null

  const editors = [...document.querySelectorAll('[contenteditable="true"]')]
  const modelTriggers = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .map((b) => ({ aria: b.getAttribute('aria-label'), text: norm(b.innerText) }))
    .filter((x) => (x.aria || '').includes('模型') || (x.text || '').includes('模型'))
  const body = norm(document.body.innerText)

  return {
    跟随会话: last === null ? null : {
      sessionId: last.sessionId,
      title: last.title,
      status: last.status,
      messages: last.messages,
      records: last.records,
      cursor: last.cursor,
    },
    输入框数: editors.length,
    输入框: editors.map((e) => ({
      cls: (e.className || '').slice(0, 40),
      placeholder: e.getAttribute('data-placeholder'),
      ariaDisabled: e.getAttribute('aria-disabled'),
    })),
    模型铭牌: modelTriggers,
    页面上有请选择模型: body.includes('请选择模型'),
    页面上有模型名: body.includes('qwen2.5:7b'),
    发送类按钮: [...document.querySelectorAll('button')]
      .map((b) => ({ aria: b.getAttribute('aria-label'), text: norm(b.innerText).slice(0, 20) }))
      .filter((x) => /发送|提交|send/i.test((x.aria || '') + (x.text || ''))),
    RPC: (globalThis.__REPLICA_RPC__ || []).map(
      (r) => r.method + ' | ' + (r.ok ? 'ok' : 'FAIL') + ' | ' + r.detail,
    ),
  }
})()
