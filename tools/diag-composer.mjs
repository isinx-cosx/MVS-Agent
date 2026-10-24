/**
 * 诊断：输入框长高之后，正文底部到底被盖住多少像素。
 *
 * 为什么要有这个文件：用户报了两次「正文被输入框挡住」，而我第一次的修法
 * （底部留白 + 贴底时跟着挪）显然没修完 —— 那就**不能再靠猜**。
 * 这里把三个数直接量出来：
 *
 *   1. 输入框（`#bottom`）的顶边在视口的哪个 y
 *   2. 最后一条消息的底边在哪个 y
 *   3. 两者的重叠 = 2 - 1（正值 = 被盖住这么多像素）
 *
 * 顺带把 `--composer-h` 的实际值和 CSS 里那笔留白也算出来 ——
 * 如果是"留白比输入框矮"，数字会直接指出来。
 *
 * 跑法：MVS_E2E_PORT=9333 node tools/diag-composer.mjs
 */

const CDP_PORT = process.env['MVS_E2E_PORT'] ?? '9222'
const APP = 'http://127.0.0.1:3080/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
if (!page) throw new Error('没有可用标签页')

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(String(ev.data))
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m.result)
    pending.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
})
await send('Page.navigate', { url: APP })
await sleep(4000)

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

/** 量一次：输入框顶边、最后一条正文的底边、以及 CSS 里那笔留白 */
const measure = () =>
  evaluate(`(() => {
    const bottom = document.querySelector('#bottom');
    const log = document.querySelector('#log');
    const inner = document.querySelector('#log > .inner');
    if (!bottom || !log || !inner) return { error: '找不到元素' };
    const composerTop = bottom.getBoundingClientRect().top;
    const msgs = inner.querySelectorAll(':scope > *');
    const last = msgs.length > 0 ? msgs[msgs.length - 1].getBoundingClientRect().bottom : null;
    const cs = getComputedStyle(log);
    return {
      composerTop: Math.round(composerTop),
      lastMessageBottom: last === null ? null : Math.round(last),
      overlapPx: last === null ? null : Math.round(last - composerTop),
      composerH: Math.round(bottom.getBoundingClientRect().height),
      varComposerH: log.style.getPropertyValue('--composer-h') || '(未设置)',
      paddingBottom: cs.paddingBottom,
      scrollTop: Math.round(log.scrollTop),
      scrollMax: Math.round(log.scrollHeight - log.clientHeight),
      atBottom: log.scrollHeight - log.scrollTop - log.clientHeight < 32,
    };
  })()`)

const before = await measure()
console.log('撑高之前：', JSON.stringify(before))

/*
 * 让输入框长到多行。
 *
 * ⚠️ 第一版用 `Input.dispatchKeyEvent` 打回车 —— **一个字都没进去**：
 * 前后量到的 `composerH` 一模一样（151px），于是"撑高之后"那一行**等同于没测**。
 * 原因是没有给 keyDown 带 `text`（Chromium 靠它插入字符）。
 *
 * 换成 React 认得的写法：走**原生 setter** 改 value + 派发 input 事件
 *（直接 `el.value = ...` 会被 React 的受控组件丢掉 —— 这是 React 的老规矩）。
 */
const filled = await evaluate(`(() => {
  const el = document.querySelector('#composer textarea');
  if (!el) return 0;
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(el, Array.from({ length: 9 }, (_, i) => '第 ' + (i + 1) + ' 行内容').join('\\n'));
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return el.value.length;
})()`)
console.log('（往输入框里放了', filled, '个字符，等它长高）')
await sleep(1200)

const after = await measure()
console.log('撑高之后：', JSON.stringify(after))

const verdict = (m) =>
  m.overlapPx === null
    ? '量不到（没有消息）'
    : m.overlapPx > 0
      ? ` 被盖住 ${m.overlapPx}px`
      : ` 没被盖（还差 ${-m.overlapPx}px）`
console.log('\n结论：')
console.log('  撑高之前', verdict(before))
console.log('  撑高之后', verdict(after))
console.log(
  `  输入框高 ${after.composerH}px，而 CSS 变量 --composer-h = ${after.varComposerH}，padding-bottom = ${after.paddingBottom}`,
)
ws.close()
