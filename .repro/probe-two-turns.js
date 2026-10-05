/*
 * 同一会话**连发两轮**工具回合 —— 补的是跨回合这一格。
 *
 * 为什么单独验：`turn_started` 会把 `journal.step` 复位成 0，而 `openStep` 是被
 * `closeStep` 清掉的 —— 两个复位点不同源。跨回合时"事件挂哪一步"（`currentStep`）
 * 最可能错位，而错位的表现正是客户端那条
 * `received an update before its start Match`。
 *
 * 判据：第二轮的标注必须是 `@2:1` / `@2:2`，不能出现 `@2:1` 之前有 `@1:2` 之类的串台，
 * 也不能出现 `@1:x` 混进第二轮。
 */
;(async () => {
  const stack = []
  const realError = console.error.bind(console)
  console.error = (...a) => {
    stack.push('error: ' + a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300))
    realError(...a)
  }
  const realWarn = console.warn.bind(console)
  console.warn = (...a) => {
    stack.push('warn: ' + a.map((x) => String(x?.message ?? x)).join(' ').slice(0, 300))
    realWarn(...a)
  }

  const tick = async () => fetch('/state')
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  if (rows[0] === undefined) return '侧栏没有会话行'
  rows[0].click()
  for (let i = 0; i < 30; i += 1) await tick()

  const follows = globalThis.__REPLICA_FOLLOW__ ?? []
  const sessionId = follows[follows.length - 1]?.sessionId
  if (sessionId === undefined) return '没有跟随流'

  const send = (text) =>
    fetch('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user_message', sessionId: sessionId, text: text }),
    })

  /*
   * 等第 n 个回合结束。
   *
   * ⚠️ 判据只能是 **WS 上 `turn_finished` 的计数** —— 页面文字里
   * "1 轮 1 步"这类字样在回合**中途**就会出现，拿它当判据会在第一轮还没跑完时
   * 就返回（第一版就是这么错的：第二轮发早，被守护进程当成"正在跑"处理掉了）。
   */
  const waitTurn = async (n) => {
    for (let i = 0; i < 20000; i += 1) {
      await tick()
      if ((globalThis.__REPLICA_WS_COUNT__ ?? {})['event / turn_finished'] >= n) {
        for (let k = 0; k < 80; k += 1) await tick()
        return true
      }
    }
    return false
  }

  await send('帮我写文件，内容是第一轮。')
  const firstDone = await waitTurn(1)
  const afterFirst = (globalThis.__REPLICA_DELIVER__ ?? []).length

  await send('再帮我写文件，内容是第二轮。')
  const secondDone = await waitTurn(2)

  const all = (globalThis.__REPLICA_DELIVER__ ?? []).slice(-70)
  return JSON.stringify(
    {
      第一轮结束: firstDone,
      第二轮结束: secondDone,
      第一轮之后的投递条数: afterFirst,
      第二轮投递顺序: all.slice(-34),
      控制台: stack.slice(-6),
    },
    null,
    1,
  )
})()
