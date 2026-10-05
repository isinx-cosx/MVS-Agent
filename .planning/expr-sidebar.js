(async () => {
  const sidebar = document.querySelector('.tPVXea_listArea')
  const outline = sidebar === null ? [] : [...sidebar.querySelectorAll('*')]
    .filter((el) => el.children.length === 0 && (el.innerText || el.textContent || '').trim() !== '')
    .slice(0, 80)
    .map((el) => ({
      tag: el.tagName,
      cls: (el.className || '').toString().slice(0, 48),
      text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 46),
    }))
  const buttons = sidebar === null ? [] : [...sidebar.querySelectorAll('button,[role="treeitem"],[role="row"],[role="option"]')]
    .slice(0, 60)
    .map((el) => ({
      tag: el.tagName,
      role: el.getAttribute('role'),
      cls: (el.className || '').toString().slice(0, 48),
      label: (el.getAttribute('aria-label') || '').slice(0, 50),
      text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50),
    }))
  return {
    侧栏子节点数: sidebar === null ? -1 : sidebar.querySelectorAll('*').length,
    叶子文本: outline,
    可点: buttons,
    会话列表RPC: (globalThis.__REPLICA_RPC__ || []).filter((r) => r.method === 'session/list'),
  }
})()
