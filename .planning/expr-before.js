(async () => {
  const main = document.querySelector('main') || document.body
  const sidebar = document.querySelector('.tPVXea_listArea')
  const rows = [...document.querySelectorAll('[role="button"],button,a')]
    .map((el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      label: (el.getAttribute('aria-label') || '').trim(),
      text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40),
      cls: (el.className || '').toString().slice(0, 60),
    }))
    .filter((r) => r.text !== '' || r.label !== '')
    .slice(0, 60)

  return {
    主区域文字: (main.innerText || '').split('\n').filter((s) => s.trim() !== '').slice(0, 20),
    侧栏文字: (sidebar === null ? '' : sidebar.innerText || '').split('\n').filter((s) => s.trim() !== '').slice(0, 30),
    可点项: rows,
    流: (globalThis.__REPLICA_STREAMS__ || []).map((r) => r.endpoint || r.sent),
    RPC: (globalThis.__REPLICA_RPC__ || []).map((r) => r.method + ':' + (r.ok ? 'ok' : r.detail)),
  }
})()
