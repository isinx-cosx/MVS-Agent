(async () => {
  const region = () => document.querySelector('[data-phase]')
  const text = () => {
    const el = region()
    return el === null ? [] : (el.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s !== '')
  }
  const TARGET = '2828d5a6-b23c-4222-bd67-b08e61fd800f'
  const rowsNow = () => [...document.querySelectorAll('.tPVXea_listArea [role="treeitem"]')]
  const found = () => rowsNow().find((el) => (el.getAttribute('data-row-key') || '').includes(TARGET))

  const phaseBefore = region() === null ? null : region().getAttribute('data-phase')

  // 1. 展开工作区分组（DSH 默认折叠）
  const group = rowsNow().find((el) => el.getAttribute('aria-expanded') === 'false')
  if (group !== undefined) group.click()
  await new Promise((r) => setTimeout(r, 200))

  /*
   * 2. 把侧栏翻到底。侧栏是分页的（一次 8 行 + 一个「展开其余 N 个会话」），
   * 而目标会话比较老，所以要一直点。
   *
   * ⚠️ 每次等待必须**很短**：探针是用 `--virtual-time-budget=20000` 跑的，
   * 等待会被快进，但**总额度是 20 秒虚拟时间**。等太久整个探针会在超时前
   * 写不出结果，现象是"页面没加载"（其实页面好好的）。第一版我每次等 400ms、
   * 循环 40 次，正好把额度用光。
   */
  let rounds = 0
  for (; rounds < 30; rounds += 1) {
    if (found() !== undefined) break
    const more = [...document.querySelectorAll('.tPVXea_listArea button')].find((el) =>
      (el.innerText || '').includes('展开其余'),
    )
    if (more === undefined) break
    more.click()
    await new Promise((r) => setTimeout(r, 32))
  }

  const target = found()
  if (target !== undefined) target.click()
  await new Promise((r) => setTimeout(r, 3000))

  const after = text()
  const probe = ['你好！有什么问题我可以帮忙解答或处理吗？', 'C++是什么', '写一段C++代码', '5 轮 10 步']
  return {
    翻页轮数: rounds,
    侧栏行数: rowsNow().length,
    找到目标行: target !== undefined,
    会话区phase_前: phaseBefore,
    会话区phase_后: region() === null ? null : region().getAttribute('data-phase'),
    会话区文字_后: after,
    还显示选择工作区开始: after.some((s) => s.includes('选择一个工作区开始')),
    命中的内容: probe.filter((s) => after.some((line) => line.includes(s))),
  }
})()
