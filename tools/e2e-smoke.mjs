import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
/**
 * 真浏览器 E2E：连上 CDP，**用真实鼠标事件**在界面上点。
 *
 * 为什么不是 `document.querySelector(...).click()`：那是合成事件，
 * 绕过命中测试和真实事件路径 —— 它证明的是"这个函数能被调用"，
 * 而不是"用户点得到"。这里走 `Input.dispatchMouseEvent`。
 *
 * 跑法：node tools/e2e-smoke.mjs
 * 前置：某个浏览器开着 CDP（默认找 9222），见文件末尾的说明。
 */

const CDP_PORT = process.env['MVS_E2E_PORT'] ?? '9222'
const APP = 'http://127.0.0.1:3080/'

async function findOrOpenTab() {
  const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  /*
   * ★ **先找已经在看应用的那个标签。**
   *
   * 原来这里是 `list.find((t) => t.type === 'page')` —— 直接取**第一个**页面。
   * 只要浏览器里多一个标签（`about:blank` 最常见），就可能驱动错：
   * 界面看起来在跑，而脚本点的其实是另一个空白页。
   * 用户就是这么看出来的：窗口地址栏写着 `about:blank`，里面却是应用。
   */
  const appPage = list.find(
    (t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('http://127.0.0.1:3080'),
  )
  if (appPage) return { tab: appPage, opened: false }

  const anyPage = list.find((t) => t.type === 'page')
  if (anyPage) return { tab: anyPage, opened: true }

  /* 一个页面都没有 → **直接报错**，不要"随便挑一个" */
  throw new Error(`CDP ${CDP_PORT} 上没有可用的页面标签`)
}

function connect(url) {
  const ws = new WebSocket(url)
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data))
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('CDP 连不上')))
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { ready, send, close: () => ws.close() }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const { tab, opened } = await findOrOpenTab()
  const cdp = connect(tab.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  /*
   * ★ **必须给一个真的视口。**
   *
   * 我起隔离实例时用了 `-WindowStyle Minimized`（不想把它弹到用户面前），
   * 结果视口高度只有 **3 像素** —— 于是 `getBoundingClientRect()` 给出的 y
   * 全是负数、`inViewport` 全是 false、**每一次点击都落在页面外**，
   * 而脚本还在报告"元素找到了、点过了"。
   *
   * 用视口模拟补上：不改窗口状态（用户不会看到东西跳出来），
   * 但页面按 1280×900 布局，坐标与命中测试就落在同一个空间里了。
   */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  const evaluate = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? '页面里抛错了')
    return r.result.value
  }

  /**
   * **等条件成立**，而不是睡固定时间。
   *
   * ⚠️ 这条是实测换来的：原来每步 `sleep(1500)` —— 同一个脚本，
   * 一次跑出"两个面板都点开了"、下一次跑出"两个都没开"。
   * 那种 flaky 最坏的地方不是它偶尔失败，而是**它偶尔成功** ——
   * 于是很容易挑一次通过的结果当成结论。
   *
   * 而"没打开"和"还没打开"在固定 sleep 下长得一模一样 ——
   * 只有轮询能把它们分开：等到超时才算失败。
   */
  const waitFor = async (expression, { timeoutMs = 6000, label = expression } = {}) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (await evaluate(expression)) return true
      if (Date.now() > deadline) return false
      await sleep(150)
    }
  }

  /**
   * 拿一个元素中心的视口坐标。
   *
   * ⚠️ **先滚到可见再量** —— 这一条是实测换来的：
   * 侧栏里十来个会话会把「改动」区块顶到可视区之外，
   * 那时 `getBoundingClientRect()` 依然给得出坐标（它给的是相对视口的位置，
   * 可以是负数或超出高度），而**点在那个坐标上等于点在页面外** ——
   * Chromium 丢掉这次点击，脚本却报告"找到了、点过了"。
   *
   * 所以顺带把 `inViewport` 一起报出来：失败时要能看出是"没点着"还是"点在了外面"。
   */
  const rectOf = async (selector) => {
    await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.scrollIntoView({ block: 'center', inline: 'center' }); })()`)
    await sleep(250)
    return evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null; const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      return { x, y, text: (el.textContent || '').trim(),
        inViewport: x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight,
        rect: { top: Math.round(r.top), height: Math.round(r.height) },
        viewport: { h: innerHeight } }; })()`)
  }

  /**
   * **真实鼠标点击**：move → down → up，坐标是视口坐标。
   *
   * ⚠️ **`buttons` 必须带**（它是一个位掩码，1 = 左键按下）。
   * 我第一版没带 —— 于是"按下"事件带着 `buttons: 0` 发出去，
   * Chromium 认为没有按键被按下，**整个点击被忽略**，
   * 而脚本却报告"元素找到了、点过了"。
   *
   * 那种失败最坏的地方是它**看起来像应用坏了**：两个毫不相干的组件
   * （改动面板、模型下拉）同时"点不开" —— 共同的错因在测试工具这边，
   * 不在应用那边。**先怀疑工具，再怀疑被测对象。**
   */
  const clickAt = async (x, y) => {
    const base = { x, y, button: 'left', clickCount: 1 }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base, buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 })
  }

  if (opened) {
    /* 复用来的标签：导航到被测应用 */
    await cdp.send('Page.navigate', { url: APP })
    await sleep(3500)
  } else {
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(2500)
  }

  /*
   * **导航之后自检。** 上一版假设 `Page.navigate` 一定成功 ——
   * 而"驱动错了标签"和"页面没起来"看起来完全一样。这里直接问页面自己是谁。
   */
  const here = await evaluate('location.href')
  if (!here.startsWith('http://127.0.0.1:3080')) {
    throw new Error(`驱动到的不是应用页（当前 ${here}）—— 检查 CDP 端口上是不是有多个标签`)
  }
  const results = {}

  /*
   * ★ **先等应用真的活起来，再点任何东西。**
   *
   * 这是实测换来的：冷 profile 下 789 KB 的包 + 字体要几秒，
   * 而 DOM 已经在那儿了 —— 于是点击打在**还没挂上事件处理器的元素**上，
   * 什么都没发生，而脚本只会说"点了没打开"（它判得没错，是点早了）。
   *
   * 判据选"侧栏里出现了会话项"：那意味着投影已经回来、React 已经渲染完一轮，
   * 比等时间可靠，也比等某个固定选择器具体。
   */
  results.appReady = await waitFor(`document.querySelectorAll('.side-item').length > 0`, {
    timeoutMs: 20000,
  })

  /*
   * ★ **先切到一个有内容的会话。**
   *
   * 这一步是补上来的，因为它前面已经让我误判过两次：
   * 默认打开的那个会话往往是**空的**（新建/刚清空）→
   * `measureOverlap()` 找不到任何消息 → 返回 null → 断言判 false，
   * 看起来像"被盖住了" —— 其实是**没东西可量**。
   *
   * 做法：点侧栏里的会话，点到日志里有内容为止（有限次）。
   */
  const logHasMessages = () =>
    evaluate("document.querySelectorAll('#log > .inner > *').length > 0")
  results.logHadMessagesAtStart = await logHasMessages()
  if (!results.logHadMessagesAtStart) {
    for (let k = 0; k < 6; k++) {
      const picked = await evaluate(`(() => {
        const rows = document.querySelectorAll('#sidebar .side-pick');
        const row = rows[${k}];
        if (!row) return null;
        const r = row.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)
      if (picked === null) break
      await clickAt(picked.x, picked.y)
      if (await waitFor("document.querySelectorAll('#log > .inner > *').length > 0", { timeoutMs: 2500 })) {
        results.pickedSessionIndex = k
        break
      }
    }
  }
  results.logHasMessages = await logHasMessages()
  /* ① 页面真的渲染出来了（不是白屏、不是错误 JSON） */
  results.title = await evaluate('document.title')
  results.hasSidebar = await evaluate("!!document.querySelector('#sidebar')")
  results.hasComposer = await evaluate("!!document.querySelector('#composer')")
  results.bodyText = (await evaluate('document.body.innerText')).slice(0, 80)

  /* ② 「改动」面板：点开 → 应当列出事务与路径 */
  const toggle = await rectOf('.changes-toggle')
  results.toggleFound = toggle !== null
  results.toggleRect = toggle
  if (toggle) {
    await clickAt(toggle.x, toggle.y)
    /* 等它真出现，而不是睡固定时间 —— 见 waitFor 的注释 */
    results.panelOpen = await waitFor(`!!document.querySelector('.changes-body')`)
    results.changeItems = await evaluate("document.querySelectorAll('.change-item').length")
    results.firstPaths = await evaluate(
      "Array.from(document.querySelectorAll('.change-paths')).slice(0,3).map(e => e.textContent.trim())",
    )
    results.toggleText = await evaluate("document.querySelector('.changes-toggle').textContent.trim()")
  }

  /* ③ 模型下拉：点开 → 读标签 → 选另一项 → 标签必须变（今天修的就是这个） */
  const dropdown = await rectOf('#composer .dd:nth-of-type(2) .dd-button')
  results.modelButtonFound = dropdown !== null
  results.modelButtonRect = dropdown
  if (dropdown) {
    results.modelLabelBefore = await evaluate(
      "document.querySelectorAll('#composer .dd')[1].querySelector('.dd-label').textContent.trim()",
    )
    await clickAt(dropdown.x, dropdown.y)
    results.modelPanelOpen = await waitFor(
      `!!document.querySelectorAll('#composer .dd')[1].querySelector('.dd-panel')`,
    )
    /*
     * 挑一个**和当前显示不同的**选项。
     *
     * ⚠️ 只判"没有 `.on`"是不够的 —— 两个供应商可能提供**同名模型**
     *（`qwen3.6` 在 `llama` 下也有）。选到它时确实切了供应商，
     * 但 label 的文字不变 → 会被误判成"没生效"。
     * 判据必须和被测行为对齐：**文字变了才算变了**。
     */
    const target = await evaluate(`(() => {
      const items = document.querySelectorAll('#composer .dd')[1].querySelectorAll('.dd-item');
      for (const el of items) {
        const t = el.textContent.trim();
        if (!el.classList.contains('on') && t !== ${JSON.stringify(results.modelLabelBefore)}) {
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width/2, y: r.top + r.height/2, text: t };
        }
      }
      return null; })()`)
    results.modelTarget = target
    if (target) {
      await clickAt(target.x, target.y)
      /*
       * ★ **等 label 真的变了**，这是整个 E2E 的判据。
       *
       * 原来是 `sleep(2500)` + 读一次 —— 那是 flaky 的来源：
       * "还没更新"和"永远不会更新"读出来一模一样。
       * 而且这一条恰好就是被测行为本身（命令之后界面当场反映出来），
       * 更不能靠猜时间。
       */
      const labelSelector = `document.querySelectorAll('#composer .dd')[1].querySelector('.dd-label').textContent.trim()`
      await waitFor(`${labelSelector} !== ${JSON.stringify(target.text)}`, { timeoutMs: 8000 })
      results.modelLabelAfter = await evaluate(labelSelector)
      results.modelChanged = results.modelLabelAfter !== results.modelLabelBefore
    }
  }

  /*
   * ④ **输入框长高时，正文不能被它盖住。**
   *
   * 这条是用户报过两次的 bug（第一次我以为修好了，第二次才量出根因：
   * `--composer-h` 挂载时量过一次之后就没再更新，于是输入框长到 340px 时
   * 留白还是 162px，最后一条正文被盖住 **159px**）。
   *
   * 判据可量化：**最后一条正文的底边 ≤ 输入框的顶边**。
   * 以前它只存在于"我拿诊断脚本量过" —— 现在每次都会被测。
   */
  const measureOverlap = () =>
    evaluate(`(() => {
      const bottom = document.querySelector('#bottom');
      const inner = document.querySelector('#log > .inner');
      if (!bottom || !inner) return null;
      const msgs = inner.querySelectorAll(':scope > *');
      if (msgs.length === 0) return null;
      const composerTop = bottom.getBoundingClientRect().top;
      const lastBottom = msgs[msgs.length - 1].getBoundingClientRect().bottom;
      return {
        overlapPx: Math.round(lastBottom - composerTop),
        composerH: Math.round(bottom.getBoundingClientRect().height),
        composerVar: document.querySelector('#log').style.getPropertyValue('--composer-h'),
      };
    })()`)

  results.overlapBefore = await measureOverlap()

  /*
   * 把输入框撑到多行。
   *
   * ⚠️ 必须走**原生 setter + input 事件** —— 直接 `el.value = …` 会被
   * React 的受控组件丢掉。第一版诊断就是这么"一个字都没进去"的，
   * 而那会让这条断言**永远通过** —— 比没有断言更糟。
   */
  const filled = await evaluate(`(() => {
    const el = document.querySelector('#composer textarea');
    if (!el) return 0;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, Array.from({ length: 9 }, function (_, i) { return '第 ' + (i + 1) + ' 行内容'; }).join('\\n'));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value.length;
  })()`)
  results.composerFilledChars = filled

  /* 等它真的长高（判据：高度明显变大），而不是睡固定时间 */
  const beforeH = results.overlapBefore === null ? 0 : results.overlapBefore.composerH
  results.composerGrew = await waitFor(
    `Math.round(document.querySelector('#bottom').getBoundingClientRect().height) > ${beforeH + 20}`,
    { timeoutMs: 5000 },
  )
  results.overlapAfter = await measureOverlap()
  results.composerOk =
    results.composerGrew === true &&
    results.overlapAfter !== null &&
    results.overlapAfter.overlapPx <= 0

  /* 收尾：清空输入框，别把测试痕迹留下（下次跑要从同一个起点开始） */
  await evaluate(`(() => {
    const el = document.querySelector('#composer textarea');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`)

  /*
   * ⑤ 存一张截图 —— 美化改动必须**看一眼**，不能只看断言。
   *
   * 断言能证明"没被挡住"，但证明不了"好不好看"。
   * 截图存到 `shots/` 下（那个目录本来就在仓库里），文件名带时间戳。
   */
  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const dir = path.join(process.cwd(), 'shots')
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, `ui-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
    await writeFile(file, Buffer.from(shot.data, 'base64'))
    results.screenshot = file
  } catch (err) {
    results.screenshot = `截图失败：${err.message}`
  }

  console.log(JSON.stringify(results, null, 2))
  /*
   * **收拾干净** —— 原来跑完把窗口留着，用户屏幕上会堆一排测试窗口。
   * `Browser.close` 会关掉这个 CDP 端点背后的整个实例；
   * 万一它不支持（某些嵌入式 Chromium），退回只关标签页。
   */
  try {
    await cdp.send("Browser.close")
  } catch {
    try {
      await cdp.send("Page.close")
    } catch {
      /* 关不掉就只能留着，但不能因此判测试失败 */
    }
  }
  cdp.close()
}

main().catch((err) => {
  console.error('E2E 失败：', err.message)
  process.exit(1)
})

/*
 * 怎么让它能跑：
 *   · 你自己的 Edge 带调试端口启动：msedge.exe --remote-debugging-port=9222
 *   · 或者让驱动起一个隔离实例，再从 <user-data-dir>/DevToolsActivePort 读端口，
 *     用 MVS_E2E_PORT 传进来
 * 脚本**不改**你的浏览器配置，也不碰别的标签页（只挑 127.0.0.1:3080 那张）。
 */
