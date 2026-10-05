(async () => {
  const sidebar = document.querySelector('.tPVXea_listArea')
  if (sidebar === null) return { err: '没有侧栏' }
  const items = [...sidebar.querySelectorAll('[role="treeitem"]')].map((el) => ({
    cls: (el.className || '').toString(),
    level: el.getAttribute('aria-level'),
    expanded: el.getAttribute('aria-expanded'),
    selected: el.getAttribute('aria-selected'),
    text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40),
    html: el.outerHTML.slice(0, 400),
  }))
  return {
    treeitem数: items.length,
    items: items.slice(0, 6),
    整个侧栏HTML长度: sidebar.innerHTML.length,
    侧栏HTML头: sidebar.innerHTML.slice(0, 1500),
  }
})()
