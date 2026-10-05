/*
 * 验「思考 → 正文换块」。
 *
 * 判据（这一条最容易静默错：块类型不跟着增量走时，正文会被追加进思考那个块里，
 * 界面上看起来"有字"，只是**分类错了**）：
 *
 *   1. 两个**独立**的块：`block-start` 一次是 `reasoning`、一次是 `text`
 *   2. 思考那段落在 index 0、正文落在 index 1（index 递增，不共用）
 *   3. 回合还没结束时，页面上就同时能看到"思考在长"和"正文在长"
 *   4. 收尾后两段都还在（思考块 + 正文块）
 *
 * 配合 `.repro/fake-reasoning-server.mjs`（:8788）用。
 */
;(async () => {
  const console_ = []
  const show = (a) =>
    typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a?.message ?? a)
  const realError = console.error.bind(console)
  console.error = (...a) => {
    console_.push('error: ' + a.map(show).join(' ').slice(0, 400))
    realError(...a)
  }
  const realWarn = console.warn.bind(console)
  console.warn = (...a) => {
    console_.push('warn: ' + a.map(show).join(' ').slice(0, 400))
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

  await fetch('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'user_message', sessionId: sessionId, text: '笼子里有鸡和兔，请回答。' }),
  })

  let sawThinkingWhileRunning = false
  let sawAnswerWhileRunning = false
  for (let i = 0; i < 12000; i += 1) {
    await tick()
    const ws = globalThis.__REPLICA_WS_COUNT__ ?? {}
    const body = document.body.innerText || ''
    const running = ws['event / turn_finished'] === undefined
    if (running && body.includes('先看看')) sawThinkingWhileRunning = true
    if (running && body.includes('答案是')) sawAnswerWhileRunning = true
    if (ws['event / turn_finished'] !== undefined && (ws['event / assistant_message'] ?? 0) > 0) {
      for (let k = 0; k < 60; k += 1) await tick()
      break
    }
  }

  const live = globalThis.__REPLICA_LIVE__ ?? []
  const body = document.body.innerText || ''
  const blocks = live
    .filter((x) => x.frameType === 'chunk' && x.chunkType === 'block-start')
    .map((x) => `${x.turnStep}#${x.index}:${x.blockType}`)
  const deltas = live
    .filter((x) => x.frameType === 'chunk' && (x.chunkType === 'reasoning-delta' || x.chunkType === 'text-delta'))
    .map((x) => `${x.chunkType}#${x.index}`)

  return JSON.stringify(
    {
      块顺序: blocks,
      增量落在哪些块: [...new Set(deltas)],
      跑到一半时: { 看到思考: sawThinkingWhileRunning, 看到正文: sawAnswerWhileRunning },
      收尾后: {
        思考还在: body.includes('先看看'),
        正文还在: body.includes('答案是'),
        /*
         * ⚠️ 「思考看不见」要先分清**真丢了**还是**折叠了** ——
         * 界面把思考画成一个可折叠的块，折叠时它的字**不在 innerText 里**。
         * 所以按 innerHTML 再查一次，并把落盘消息自己的块列出来对照。
         */
        思考在DOM里: (document.body.innerHTML || '').includes('先看看'),
      },
      落盘消息的块: (globalThis.__REPLICA_ASSISTANT__ ?? []).map((x) => x.contentBlocks),
      开步记录: globalThis.__REPLICA_STEP_OPEN__ ?? [],
      WS计数: { ...(globalThis.__REPLICA_WS_COUNT__ ?? {}) },
      垫片计数: { ...(globalThis.__REPLICA_ACCEPT__ ?? {}) },
      控制台: console_.slice(-6),
    },
    null,
    1,
  )
})()
