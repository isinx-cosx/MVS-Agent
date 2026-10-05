/**
 * 复刻页的逻辑层 —— **我们自己写的代码**。
 *
 * ## 它是什么
 *
 * 页面本身是 DSH 渲染结果的静态快照（DOM 与 CSS 原样搬来，只做了品牌替换）。
 * 这个文件给那一页加上**行为**：读我们自己的守护进程，把真实数据画进侧栏。
 *
 * ## 它不是什么（这一点很重要）
 *
 * 它**不实现 DSH 的协议**。不认识 `Remote`、`mux`、`session/list` 那些东西，
 * 也不引 DSH 的任何模块。它只会说我们自己的三种话：
 *
 *     GET  /state            工作区 + 会话
 *     POST /command          命令（open_workspace 等）
 *     POST /pick-directory   弹出原生目录选择框
 *
 * 上一轮我做过相反的事 —— 跑 DSH 的前端、用垫片实现它的 RPC/mux 协议。
 * 那是「抄 DSH 的逻辑」，方向错了，那套东西已经退到 `/app/` 且不再作为门面。
 *
 * ## 为什么吐 DSH 的类名
 *
 * 因为视觉要沿用这一页。DSH 的 CSS 是按**类名 + 嵌套**写的：
 *
 *     .tPVXea_groupSection > * + *            ← 靠子元素相邻关系
 *     ._7VDZUG_projectRow ._7VDZUG_slot       ← 靠嵌套
 *
 * 另发明一套结构，那 548 KB 样式一条都不会生效。
 * **类名是视觉，代码是我们的。**
 *
 * 结构不是我凭 JSX 猜的 —— 是从 DSH 真实渲染出来的 DOM 里读的
 * （`tools/dom-around.mjs` 那个工具就是为这件事写的）。
 *
 * ## 图标不自己画
 *
 * 画面里已经有 DSH 渲染出来的真实图标节点（文件夹、箭头）。渲染前**从占位行上
 * 克隆**下来复用 —— 这样它们和这一页的其它图标是同一批字节，
 * 不会出现「差不多但不一样」。
 *
 * ## 当前范围
 *
 * 只做**添加工作区**。会话行、输入框、消息流都还没有 —— 见文件末尾的说明。
 */

;(() => {
  /** 同源。垫片不写死端口，因为它永远跟页面同源 */
  const HOST = ''
  const SVG_NS = 'http://www.w3.org/2000/svg'

  // ── 1. 我们自己的三种话 ──────────────────────────────────────────────

  async function getState() {
    const res = await fetch(`${HOST}/state`, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`/state 返回 HTTP ${res.status}`)
    return (await res.json()).state
  }

  async function post(path, body) {
    const res = await fetch(`${HOST}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    try {
      return await res.json()
    } catch {
      return {}
    }
  }

  async function getJson(path) {
    const res = await fetch(`${HOST}${path}`, { headers: { accept: 'application/json' } })
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, body }
  }

  /**
   * 发一条命令。
   *
   * ⚠️ **被拒绝时必须说出来。** 服务端的 `#applyCommand` 会回 `{ok:false, message}`，
   * 静默吞掉它就变成「点了没反应」—— 而那是最难查的一类问题。
   */
  async function sendCommand(payload) {
    const body = await post('/command', payload)
    if (body?.ok === true) return { ok: true }
    return { ok: false, message: typeof body?.message === 'string' ? body.message : '命令被拒绝' }
  }

  // ── 2. DOM 小工具 ────────────────────────────────────────────────────

  function el(tag, className) {
    const node = document.createElement(tag)
    if (className !== undefined) node.className = className
    return node
  }

  /** 这一页里现有图标的副本。渲染前从占位行上克隆，见文件头 */
  let icons = null

  /**
   * 加号图标 —— **这个是自己画的**。
   *
   * 那一页里没有「添加」这个动作，所以没有现成图标可克隆。
   * 用 `currentColor` 描边，这样它跟着按钮的语义色走（深色主题也自动对）。
   */
  function plusIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg')
    for (const [key, value] of Object.entries({
      width: '16',
      height: '16',
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
      'stroke-width': '1',
    })) {
      svg.setAttribute(key, value)
    }
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', 'M8 3.2v9.6M3.2 8h9.6')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-linecap', 'round')
    svg.appendChild(path)
    return svg
  }

  // ── 3. 侧栏那两块地方 ────────────────────────────────────────────────

  const sidebar = document.querySelector('[data-slot="sidebar.workspaces"]')
  const tree = sidebar?.querySelector('.tPVXea_list') ?? null
  const headerActions = sidebar?.querySelector('.tPVXea_headerActions') ?? null

  if (tree === null || headerActions === null) {
    /*
     * 找不到锚点就**什么都不做**，但要出声。
     *
     * 这一页是构建产物，DSH 换个版本这些类名就可能变。静默失效会表现成
     * 「这一页坏了但看不出为什么」，而日志里一句话就能定位。
     */
    console.warn('[mvs] 复刻页的结构和预期不符，逻辑层没有挂载', { tree, headerActions })
    return
  }

  /**
   * **展开**的工作区路径。
   *
   * ⚠️ 记「展开的」而不是「折叠的」—— 因为默认应该是**折叠**。
   *
   * 快照里 DSH 渲染出来的行是 `aria-expanded="false"`，也就是折叠态
   * （它只在用户点开时才展开）。所以要照它的视觉，默认就得是折叠。
   *
   * 我第一版写成了「折叠的集合」，于是空集合 = 全部展开 ——
   * 箭头方向就和快照里相反了。空集合的默认值很容易写反，
   * 所以这里让**变量名直接说出默认值**。
   */
  const expanded = new Set()

  // ── 4. 渲染工作区 ────────────────────────────────────────────────────

  /**
   * 从占位行上把真实图标克隆下来，之后占位行会被清掉。
   *
   * 之所以要「先克隆再清」而不是自己画：这些图标是 DSH 渲染出来的真实字节，
   * 自己画一个「差不多」的，在这套视觉里会比空着更显眼。
   */
  function captureIcons() {
    if (icons !== null) return
    const row = tree.querySelector('._7VDZUG_projectRow')
    if (row === null) return
    icons = {
      folder: row.querySelector('._7VDZUG_folder svg')?.cloneNode(true) ?? null,
      arrow: row.querySelector('._7VDZUG_chevron svg')?.cloneNode(true) ?? null,
    }
  }

  function workspaceSection(workspace) {
    const isExpanded = expanded.has(workspace.path)

    /*
     * 外层结构逐层照 DSH：
     *   div.tPVXea_groupSection          ← 一个工作区分组
     *   └ span._root_38jqx_3             ← 行的包裹（CSS 里对它定位）
     *     └ div._7VDZUG_projectRow       ← 行本身
     *
     * `--dsh-workspace-indent` 是这一页 CSS 消费的缩进变量。顶层写 0px，
     * 和占位行一致。
     */
    const group = el('div', 'tPVXea_groupSection')
    group.style.setProperty('--dsh-workspace-indent', '0px')

    const holder = el('span', '_root_38jqx_3')
    const row = el('div', '_7VDZUG_projectRow')

    /*
     * `data-row-key` 是 DSH 给行起的稳定键。我们照它的格式写 —— 将来要做
     * 「记住哪些分组展开过」时，它就是这个状态该挂的地方。
     */
    row.dataset.rowKey = `workspace:${workspace.path}`
    row.setAttribute('role', 'treeitem')
    row.setAttribute('aria-expanded', String(isExpanded))
    /*
     * ⚠️ 明确设成 false，不省。DSH 的行是 `draggable="true"`（它能拖动排序），
     * 而拖动**会抢走点击** —— 我们还没做排序，留着它只会让点行变得时灵时不灵。
     */
    row.draggable = false
    row.addEventListener('click', () => toggleWorkspace(workspace.path))

    const folder = el('span', '_7VDZUG_slot _7VDZUG_folder')
    if (icons?.folder !== null && icons?.folder !== undefined) {
      folder.appendChild(icons.folder.cloneNode(true))
    }

    const chevron = el('span', '_7VDZUG_slot _7VDZUG_chevron')
    if (icons?.arrow !== null && icons?.arrow !== undefined) {
      const arrow = icons.arrow.cloneNode(true)
      // `_7VDZUG_arrowOpen` 是这一页 CSS 里控制箭头朝向的那一支
      arrow.classList.toggle('_7VDZUG_arrowOpen', isExpanded)
      chevron.appendChild(arrow)
    }

    const text = el('span', '_7VDZUG_projectText')
    const title = el('span', '_7VDZUG_title')
    title.textContent = workspace.name
    // 名字可能被截断，路径放进 title 属性，鼠标停一下就能看全
    title.title = workspace.path
    text.appendChild(title)

    row.append(folder, chevron, text)
    holder.appendChild(row)
    group.appendChild(holder)

    return group
  }

  function toggleWorkspace(path) {
    if (expanded.has(path)) expanded.delete(path)
    else expanded.add(path)
    renderWorkspaces(lastWorkspaces)
  }

  /** 最近一次读到的状态。折叠只是重画，不必再问一遍服务端 */
  let lastWorkspaces = []

  /**
   * 常驻的「添加工作区」行。
   *
   * ## 为什么不能只靠头部那个图标按钮
   *
   * DSH 的 CSS 里，工作区那一节的头部动作区是被藏起来的：
   *
   *     .tPVXea_headerActions      { opacity:1; visibility:visible; max-width:60px }
   *     .tPVXea_headerActionsHidden{ opacity:0; visibility:hidden; max-width:0 }
   *
   * 也就是**悬停那一节才显示**（`视图选项` 也一样）。对次要动作这是合理的，
   * 但「添加工作区」是**主要**动作 —— 工作区列表为空时它是**唯一的出路**。
   *
   * 我第一版只在头部加了那个图标，结果实测：按钮 `opacity: 0`，看不见。
   * 而空态提示还写着「点上面的 ＋ 添加一个」——**指着一个看不见的东西**。
   * 用户打开一看：「主界面没有变」。
   *
   * 所以加这一行：常驻可见、就在列表末尾、用树自己的行样式。
   * 空列表时它是唯一的入口，非空时它是顺手的入口。
   */
  function addRow() {
    /*
     * 放在 `tPVXea_list` **外面**（是它的兄弟）。
     *
     * `tPVXea_list` 是 `role="tree"`，里面只该有 treeitem；这一行是个按钮，
     * 塞进去会破坏可访问性语义。放外面视觉上仍然接着列表的下沿。
     */
    const row = el('div', '_7VDZUG_projectRow mvs-add-row')
    row.setAttribute('role', 'button')
    row.setAttribute('tabindex', '0')
    row.setAttribute('aria-label', '添加工作区')
    row.title = '添加工作区'
    row.addEventListener('click', () => void addWorkspace())
    // 键盘也要能用 —— 它是个 button，只接 click 等于只有鼠标能用
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      void addWorkspace()
    })

    const slot = el('span', '_7VDZUG_slot _7VDZUG_folder')
    slot.appendChild(plusIcon())

    const text = el('span', '_7VDZUG_projectText')
    const title = el('span', '_7VDZUG_title')
    title.textContent = '添加工作区'
    text.appendChild(title)

    row.append(slot, text)
    return row
  }

  function renderWorkspaces(workspaces) {
    captureIcons()
    lastWorkspaces = workspaces

    tree.textContent = ''
    if (workspaces.length === 0) {
      // 空的时候不需要额外的提示文字 —— 下面那一行「添加工作区」就是提示，
      // 而且它本身可点。写一句「点上面的 ＋」只会指着一个看不见的东西。
      tree.appendChild(hint('还没有工作区。'))
    } else {
      for (const workspace of workspaces) tree.appendChild(workspaceSection(workspace))
    }

    /*
     * 常驻的添加入口挂在**列表的父节点**上（`tPVXea_list` 的兄弟），
     * 这样它在空和非空两种情况下都在、位置也一致。见 `addRow` 的说明。
     */
    const holder = tree.parentElement
    if (holder !== null) {
      holder.querySelector('.mvs-add-row')?.remove()
      holder.appendChild(addRow())
    }
  }

  // ── 5. 提示 ──────────────────────────────────────────────────────────

  /**
   * 一句提示。
   *
   * 用页面自己的语义色 token，所以深浅主题都自动对。
   * 这几行是**唯一**新增的样式 —— 页面里没有「一句提示」这种东西可以复用。
   */
  function showMessage(text, isError) {
    if (messageNode !== null) messageNode.remove()
    const node = el('div', 'mvs-glue-message')
    node.style.color = `var(--dsw-alias-${isError ? 'state-error-primary' : 'label-tertiary'})`
    node.textContent = text
    tree.prepend(node)
    messageNode = node
  }

  function clearMessage() {
    if (messageNode === null) return
    messageNode.remove()
    messageNode = null
  }

  let messageNode = null

  /**
   * 一句中性提示（不是错误）。
   *
   * 和 `showMessage` 共用同一套样式，但**不覆盖**已有的错误信息 ——
   * 空态提示不该把「刚才添加失败」那句话挤掉。
   */
  function hint(text) {
    const node = el('div', 'mvs-glue-message')
    node.style.color = 'var(--dsw-alias-label-tertiary)'
    node.textContent = text
    return node
  }

  // ── 6. 添加工作区 ────────────────────────────────────────────────────

  let adding = false

  /**
   * 把所有「添加工作区」的入口一起置忙。
   *
   * 现在有两个入口（头部图标 + 列表末尾那一行），它们必须**同时**禁用 ——
   * 只禁一个的话，原生目录框开着的时候点另一个会再弹一个。
   * 所以状态统一从这里走，而不是各个入口自己管自己。
   */
  function setBusy(busy) {
    adding = busy
    for (const node of document.querySelectorAll('.mvs-add-row, [aria-label="添加工作区"]')) {
      if (node instanceof HTMLButtonElement) node.disabled = busy
      else {
        node.setAttribute('aria-disabled', String(busy))
        node.style.pointerEvents = busy ? 'none' : ''
        node.style.opacity = busy ? '0.5' : ''
      }
    }
  }

  /**
   * 添加工作区。
   *
   * 三步，而且**每一步都可能被人取消或拒绝**，所以三步都要说清楚：
   *
   *   1. 弹原生目录选择框 —— 用户可能取消（那不是错误，静静结束）
   *   2. `open_workspace` —— 服务端可能拒绝（那就把话原样带出来）
   *   3. 重画 —— 让新工作区真的出现
   *
   * ⚠️ 第 2 步和第 1 步是**分开**的两件事，这是有意的：
   * 「能选目录」不等于「能读那个目录」。选只是拿回一个字符串，
   * 真正授予访问权的是 `open_workspace`，而它会写审计记录。
   */
  async function addWorkspace() {
    if (adding) return
    setBusy(true)
    clearMessage()

    try {
      /*
       * 先问能力，再决定形态 —— 这是从 DSH 学来的那一层。
       *
       *   native —— 让服务端开系统对话框（它在**守护进程那台机器的屏幕上**）
       *   browse —— 我们自己在页面里画一个目录浏览器
       *
       * 为什么必须有第二种：通过 SSH 或从别的机器打开界面时，
       * 系统对话框开在远端屏幕上，操作者**看不见**。他会看到「点了没反应」，
       * 而服务端正开着框在等一个看不见的人点。那时失败的不是机制，是**形态**。
       */
      const capability = await pickerCapability()
      if (capability.kind === 'unknown') {
        // 未知能力 → 藏起来，不是让它失败。见 `picker.ts` 的说明
        setBusy(false)
        hideAddAffordances()
        showMessage(`这个环境不支持添加工作区：${capability.reason}`, true)
        return
      }

      const picked =
        capability.kind === 'native' ? await pickViaNative() : await pickViaBrowse()

      if (picked === null) return // 用户取消，那不是错误
      if (typeof picked.error === 'string' && picked.error !== '') {
        showMessage(picked.error, true)
        return
      }

      const result = await sendCommand({ type: 'open_workspace', path: picked.path })
      if (!result.ok) {
        showMessage(result.message, true)
        return
      }
      await refresh()
    } catch (error) {
      showMessage(`添加工作区失败：${error?.message ?? error}`, true)
    } finally {
      setBusy(false)
    }
  }

  // ── 6b. 能力 ────────────────────────────────────────────────────────

  /** 启动时问一次就缓存起来 —— 服务端也是启动时算定的，两边一致 */
  let capability = null

  async function pickerCapability() {
    if (capability !== null) return capability
    try {
      const { status, body } = await getJson('/picker')
      if (status !== 200 || body === null || typeof body.kind !== 'string') {
        capability = { kind: 'unknown', reason: `/picker 返回了 HTTP ${status}` }
      } else {
        capability = body
      }
    } catch (error) {
      capability = { kind: 'unknown', reason: `${error?.message ?? error}` }
    }
    return capability
  }

  function hideAddAffordances() {
    for (const node of document.querySelectorAll('.mvs-add-row, [aria-label="添加工作区"]')) {
      node.remove()
    }
  }

  /** native 形态：让服务端开系统对话框。**它开在守护进程那台机器的屏幕上** */
  async function pickViaNative() {
    const picked = await post('/pick-directory')
    if (picked?.cancelled === true) return null
    if (typeof picked?.error === 'string' && picked.error !== '') return { error: picked.error }
    if (typeof picked?.path !== 'string' || picked.path === '') return null
    return { path: picked.path }
  }

  /** browse 形态：页面里画的目录浏览器 */
  async function pickViaBrowse() {
    const start = lastWorkspaces[0]?.path
    return await openBrowse(start)
  }

  // ── 6c. 目录浏览器 ──────────────────────────────────────────────────

  /**
   * 页面里画的目录选择器。
   *
   * ## 为什么用它自己的弹层类
   *
   * 页面里已经有一整套弹层词汇（`_root_o6lrb_6` 覆盖层 / `_mask_o6lrb_18` 遮罩 /
   * `_dialog_o6lrb_33` / `_header_o6lrb_71` / `_title_o6lrb_79` /
   * `_button_1rv3m_2`），主题、深色、模糊、动效、焦点环全在里面。
   * 自己写一套等于把这些又漏掉一次 —— 而复用之后它**天生**和这一页一致。
   *
   * 目录行复用侧栏的 `_7VDZUG_projectRow`：它本来就是「一行可点的东西」，
   * 有 hover 底色和 `cursor:pointer`，连文件夹图标都能一起克隆过来。
   *
   * ## 只用 `/picker/dirs` 一个接口
   *
   * 列举、进目录、回上级、跳盘符 —— 全是同一个请求换一个 `path`。
   * 没有额外状态，所以也就没有「界面显示的和实际的不一致」这类问题。
   *
   * @param start - 从哪开始。没有就给盘符列表
   * @returns 选中的路径；取消时 null
   */
  function openBrowse(start) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        document.removeEventListener('keydown', onKey)
        overlay.remove()
        resolve(value)
      }

      const onKey = (event) => {
        if (event.key === 'Escape') finish(null)
      }

      /*
       * ⚠️ 这两行内联 `opacity: 1` 只是**兜底**，真正起作用的是上面样式表里那条
       * `.mvs-picker …{animation:none!important}` —— 因为 CSS 动画会盖过内联声明。
       * 留着它们是因为「元素被插入时就已经是可见的」，理论上能少一帧闪烁。
       */
      const overlay = el('div', '_root_o6lrb_6 mvs-picker')
      overlay.setAttribute('role', 'presentation')

      /*
       * ⚠️ 这两处显式的 `opacity: 1` **不是多余的一行**。
       *
       * 页面里这个弹层的可见性**完全依赖一条 CSS 动画**：
       *
       *     ._dialog_o6lrb_33 { animation: _modalEnter_o6lrb_1 … }
       *     @keyframes _modalEnter_o6lrb_1 { 0% { opacity: 0 } to { opacity: 1 } }
       *
       * 动画正常跑完没问题。但**动画是唯一的可见性来源**，于是任何让它不跑的情况
       * 都留下一个 opacity:0 的弹层 —— 用户看到的是「点了没反应」：
       *
       *   · 无头渲染 + `--virtual-time-budget`：动画时钟不推进，冻在 0%
       *     —— 我就是这么发现的（探针报 `opacity=0`，可文字和几何全对）
       *   · 标签页在后台时被插入
       *   · 用户装了禁用动画的扩展
       *
       * 内联 `opacity: 1` 兜住这些；动画在跑时**优先级更高**，所以淡入不受影响。
       * 它同时也是「我能验证这一页」的前提 —— 不加，无头截图永远空白，
       * 而我会以为弹层根本没做出来。
       */
      const mask = el('div', '_mask_o6lrb_18')
      mask.setAttribute('aria-hidden', 'true')
      mask.style.opacity = '1'
      // 点遮罩关闭 —— 弹层的常规期待，不做会让人以为卡住了
      mask.addEventListener('click', () => finish(null))

      const dialog = el('div', '_dialog_o6lrb_33')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      dialog.setAttribute('aria-label', '添加工作区')
      // 页面给的是 380px，装不下目录列表。只改宽度这一处
      dialog.style.width = 'min(560px, 100%)'
      dialog.style.opacity = '1'

      const content = el('div', '_content_o6lrb_63')

      const header = el('div', '_header_o6lrb_71')
      const title = el('h2', '_title_o6lrb_79')
      title.textContent = '添加工作区'
      const close = el('button', '_close_o6lrb_87')
      close.type = 'button'
      close.setAttribute('aria-label', '关闭')
      close.textContent = '✕'
      close.addEventListener('click', () => finish(null))
      header.append(title, close)

      /** 当前位置那一行：上级 + 路径 */
      const bar = el('div', '_description_o6lrb_106')
      bar.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:0 24px;margin-bottom:8px;' +
        'font-family:var(--ds-font-family-code);font-size:12px;' +
        'color:var(--dsw-alias-label-secondary);word-break:break-all'

      /** 目录列表 */
      const list = el('div')
      list.style.cssText =
        'flex:1;min-height:0;overflow-y:auto;padding:0 12px;margin-bottom:8px;' +
        'display:flex;flex-direction:column;gap:1px'

      const footer = el('div')
      footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;padding:0 24px'

      const cancel = el('button', '_button_1rv3m_2 _md_1rv3m_23')
      cancel.type = 'button'
      cancel.textContent = '取消'
      cancel.addEventListener('click', () => finish(null))

      const confirm = el('button', '_button_1rv3m_2 _primary_1rv3m_36 _md_1rv3m_23')
      confirm.type = 'button'
      confirm.textContent = '选择这个目录'
      confirm.disabled = true

      footer.append(cancel, confirm)
      content.append(header, bar, list, footer)
      dialog.append(content)
      overlay.append(mask, dialog)
      document.body.appendChild(overlay)
      document.addEventListener('keydown', onKey)

      /** 当前停在哪。确认按钮用它，所以它和界面永远是同一份数据 */
      let current = null

      function renderFailure(message) {
        list.textContent = ''
        const row = el('div', 'mvs-glue-message')
        row.style.color = 'var(--dsw-alias-state-error-primary)'
        row.textContent = message
        list.appendChild(row)
        confirm.disabled = true
      }

      async function load(target) {
        list.textContent = ''
        const loading = el('div', 'mvs-glue-message')
        loading.style.color = 'var(--dsw-alias-label-tertiary)'
        loading.textContent = '读取中…'
        list.appendChild(loading)

        const query = target === undefined || target === null ? '' : `?path=${encodeURIComponent(target)}`
        const { status, body } = await getJson(`/picker/dirs${query}`)

        if (status !== 200 || body === null || !Array.isArray(body.entries)) {
          renderFailure(body?.message ?? `读取目录失败（HTTP ${status}）`)
          return
        }

        current = body.path
        confirm.disabled = false

        // 位置那一行：上级按钮 + 当前路径
        bar.textContent = ''
        if (body.parent !== null) {
          const up = el('button', '_button_1rv3m_2 _md_1rv3m_23')
          up.type = 'button'
          up.textContent = '↑ 上级'
          up.addEventListener('click', () => void load(body.parent))
          bar.appendChild(up)
        }
        const where = el('span')
        where.textContent = body.path
        bar.appendChild(where)

        list.textContent = ''

        // 盘符（或者 `/`）—— 一路点「上级」要很多次，给一条捷径
        for (const root of body.roots) {
          if (root === body.path) continue
          list.appendChild(dirRow(root, root, () => void load(root)))
        }

        if (body.entries.length === 0) {
          const none = el('div', 'mvs-glue-message')
          none.style.color = 'var(--dsw-alias-label-tertiary)'
          none.textContent = '（这一层没有子目录）'
          list.appendChild(none)
        }

        for (const entry of body.entries) {
          list.appendChild(dirRow(entry.name, entry.path, () => void load(entry.path)))
        }

        if (body.truncated === true) {
          const more = el('div', 'mvs-glue-message')
          more.style.color = 'var(--dsw-alias-label-tertiary)'
          more.textContent = '（目录太多，只列了前一部分）'
          list.appendChild(more)
        }
      }

      /** 一行目录。结构和侧栏的工作区行一致，所以样式直接生效 */
      function dirRow(name, target, onOpen) {
        const row = el('div', '_7VDZUG_projectRow')
        row.setAttribute('role', 'button')
        row.setAttribute('tabindex', '0')
        row.title = target

        const slot = el('span', '_7VDZUG_slot _7VDZUG_folder')
        if (icons?.folder !== null && icons?.folder !== undefined) {
          slot.appendChild(icons.folder.cloneNode(true))
        }
        const text = el('span', '_7VDZUG_projectText')
        const label = el('span', '_7VDZUG_title')
        label.textContent = name
        text.appendChild(label)

        row.append(slot, text)
        row.addEventListener('click', onOpen)
        row.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onOpen()
        })
        return row
      }

      confirm.addEventListener('click', () => {
        if (current !== null) finish({ path: current })
      })

      // 没有起点就先问盘符：`/picker/dirs` 不带参数会回 400，
      // 所以给一个必然存在的起点。Windows 上先试 C:\，其它平台 `/`
      void load(start ?? (navigator.platform.startsWith('Win') ? 'C:\\' : '/'))
    })
  }

  function installAddButton() {
    /*
     * 加在 `tPVXea_headerActions` 里 —— 那是「工作区」这一节的头部动作区，
     * 里面已经有「视图选项」。用同一个类 `tPVXea_iconButton`，所以外观一致。
     *
     * 放**前面**（prepend）：添加是这一节最主要的动作，排在视图选项之前更顺手。
     *
     * ⚠️ **它平时是看不见的**（和「视图选项」一样，DSH 给整个动作区加了
     * `tPVXea_headerActionsHidden`，悬停那一节才显示）。所以它**不是**主要入口 ——
     * 主要入口是列表末尾那一行常驻的「添加工作区」（见 `addRow`）。
     * 这里留着是因为悬停时它顺手，而且和「视图选项」并排很自然。
     */
    const wrap = el('span', '_root_4ub78_1')
    const button = el('button', 'tPVXea_iconButton tPVXea_wide')
    button.type = 'button'
    button.setAttribute('aria-label', '添加工作区')
    button.title = '添加工作区'
    button.appendChild(plusIcon())
    button.addEventListener('click', (event) => {
      // 头部这一块可能有自己的点击处理，别让它顺带触发
      event.stopPropagation()
      void addWorkspace()
    })
    wrap.appendChild(button)
    headerActions.prepend(wrap)
  }

  // ── 7. 启动 ──────────────────────────────────────────────────────────

  /**
   * 我们这一层需要的那一点样式。
   *
   * 只加**现有的类没法表达**的东西。其余一律复用页面里的类，所以主题切换、
   * 深色模式、圆角、间距都不用我们操心 —— 那些都是页面自己的 token 在管。
   *
   * 具体两件事：
   *   · 那些提示文字的颜色（错误用错误色，中性用三级色）
   *   · 「添加工作区」那一行要和**真的工作区行**区分开 ——
   *     它是动作，不是数据。用二级色 + hover 底色说明这一点。
   */
  function installStyles() {
    if (document.getElementById('mvs-glue-styles') !== null) return
    const style = document.createElement('style')
    style.id = 'mvs-glue-styles'
    style.textContent = `
      .mvs-glue-message {
        padding: 6px 12px 8px;
        font-size: 12px;
        line-height: 18px;
        word-break: break-all;
      }
      .mvs-add-row { margin-top: 2px; }
      .mvs-add-row ._7VDZUG_title { color: var(--dsw-alias-label-secondary); }
      .mvs-add-row:hover { background: var(--dsw-alias-interactive-bg-hover); }

      /*
       * 目录选择弹层：**关掉页面那条入场动画**。
       *
       * 页面里弹层的可见性完全依赖一条 CSS 动画：
       *
       *     ._dialog_o6lrb_33 { animation: _modalEnter_o6lrb_1 … }
       *     @keyframes _modalEnter_o6lrb_1 { 0% { opacity: 0 } to { opacity: 1 } }
       *
       * 于是「弹层可见」这件事被押在「动画一定会跑完」上。任何让它不跑的情况
       * 都留下一个 opacity:0 的弹层 —— 用户看到的是「点了没反应」：
       *
       *   · 无头渲染 + --virtual-time-budget：动画时钟不推进，冻在 0%
       *     （我就是这么发现的：文字、几何全对，只有 opacity 是 0）
       *   · 标签页在后台时被插入
       *   · 装了禁用动画的扩展
       *
       * ⚠️ **!important 在这里是必需的，不是偷懒。**
       * 我先是试着在内联样式里写 opacity: 1，**没用** —— 按层叠规则，
       * CSS 动画会盖过普通的内联声明。只有作者样式表里的 !important
       * 才排在动画之上。所以必须写成规则，而且必须带 !important。
       *
       * 代价是这个弹层没有淡入（页面自己的弹层有）。换到的是**它一定会出现** ——
       * 对一个「用户点了必须看到东西」的界面来说，这个交换是值的。
       *
       * 遮罩那条动画挂在 ::after 伪元素上，内联样式够不到它，所以更要写规则。
       */
      .mvs-picker ._dialog_o6lrb_33,
      .mvs-picker ._mask_o6lrb_18::after {
        animation: none !important;
        opacity: 1 !important;
      }
    `
    document.head.appendChild(style)
  }

  async function refresh() {
    try {
      const state = await getState()
      renderWorkspaces(Array.isArray(state?.workspaces) ? state.workspaces : [])
    } catch (error) {
      /*
       * 读不到就**清空并说明**，不要留着占位内容。
       *
       * 页面初版里有两条假工作区（deepseek-harness / ui-theme）。连不上时
       * 留着它们，用户会以为自己真的有那两个工作区 —— 那比空白更糟。
       */
      tree.textContent = ''
      showMessage(`读不到守护进程的状态：${error?.message ?? error}`, true)
    }
  }

  function start() {
    installStyles()
    installAddButton()
    void refresh()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()

/*
 * ── 这一层现在做到哪、还没做什么 ─────────────────────────────────────
 *
 * 做了：
 *   · 读 /state，把侧栏的占位工作区换成真实的
 *   · 「添加工作区」：目录选择框 → open_workspace → 重画
 *   · 工作区行可折叠（默认折叠，和 DSH 一致）
 *
 * 还没做（按需要的顺序）：
 *   · **会话行** —— 结构已经拿到了（`_7VDZUG_sessionRow`），但内容区还没有
 *     第二态可用（现在只有「没有会话」时那个 hero）。先有第二态再渲染会话行，
 *     否则点进去看到的是没变化的内容区，比不做更让人困惑。
 *   · 工作区行的 hover 动作（重命名 / 移除）—— 占位行上有两个按钮，我们还没有对应命令
 *   · 搜索、视图选项、拖拽排序 —— 占位行上有入口，都还没接
 */
