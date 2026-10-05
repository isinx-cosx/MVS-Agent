/*
 * 中途加入：**回合已经在跑之后**，界面才打开这个会话。
 *
 * 这条路是"整段蹦出来"的另一个来源：守护进程早就把 `turn_started` /
 * `step_started` 广播过去了，而这条连接**没见过**它们 —— 于是
 *
 *   · journal 的 `step` 停在 0，闸门也不拦 ⇒ 增量带着 `1:0` 出生（号错，
 *     客户端结算判定不上，同一条回答画两遍）
 *   · 客户端也不知道"这个会话正在跑" ⇒ 在线行根本不开闸（闸在它那边）✗
 *
 * 复现方式（两段，**必须放在同一次 shell 调用里**，否则回合会先跑完）：
 *   1. 先不打开页面，直接给守护进程发一条会跑很久的消息（文本带「慢」——
 *      假端点把每字间隔拉到 400ms）
 *   2. 隔一秒再跑这个探针
 *
 * 判据：
 *   · 在线帧的 `turnStep` 必须是 `1:1`（和落盘事件一致）
 *   · 两条绊线（`结算编号对不上`、`在线帧跑在 step/start 前面`）都不能响
 *   · 回合还没结束时页面上就该有字（`跑到一半时看到正文`）
 *   · 收尾后正文在
 */
;(async () => {
  const console_ = []
  const show = (a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a?.message ?? a))
  const realError = console.error.bind(console)
  console.error = (...a) => {
    console_.push('error: ' + a.map(show).join(' ').slice(0, 300))
    realError(...a)
  }
  const realWarn = console.warn.bind(console)
  console.warn = (...a) => {
    console_.push('warn: ' + a.map(show).join(' ').slice(0, 300))
    realWarn(...a)
  }

  const tick = async () => fetch('/state')
  const state = await (await fetch('/state')).json()
  const running = (state.state.sessions ?? []).find((s) => s.status === 'running')
  if (running === undefined) {
    return JSON.stringify({ 结论: '没有正在跑的会话 —— 见文件头第 1 步' }, null, 1)
  }
  const title = String(running.title ?? '')
  const rows = [...document.querySelectorAll('[class*="sessionRow"]')]
  const row = rows.find((el) => (el.innerText || '').includes(title.slice(0, 6))) ?? rows[rows.length - 1]
  if (row === undefined) return '侧栏没有会话行'
  row.click()
  for (let i = 0; i < 40; i += 1) await tick()

  const follows = globalThis.__REPLICA_FOLLOW__ ?? []
  const sessionId = follows[follows.length - 1]?.sessionId

  let sawTextWhileRunning = false
  let sawTurnFinished = false
  let lastDeltas = -1
  const 采样 = []
  /*
   * ⚠️ **观察窗口要短。** 页面在这个场景下很重（每条在线帧都触发一次 React
   * 重渲染，而会话已经很长），紧密轮询在 `--virtual-time-budget` 下会把预算耗光，
   * 于是 Edge 在表达式返回**之前**就把 DOM dump 走 —— 探针**一句话都不输出**。
   *
   * 而这里要验的东西（帧的 `turnStep`、绊线响不响、在跑时有没有字）**加入后
   * 几秒内就全都可得了**，不需要等到回合结束。所以窗口只留 400 轮。
   */
  for (let i = 0; i < 400; i += 1) {
    await tick()
    const ws = globalThis.__REPLICA_WS_COUNT__ ?? {}
    const deltas = ws['event / model_text_delta'] ?? 0
    if (deltas !== lastDeltas) {
      lastDeltas = deltas
      const body = document.body.innerText || ''
      const isRunning = ws['event / turn_finished'] === undefined
      if (isRunning && body.includes('收到')) sawTextWhileRunning = true
      if (isRunning && deltas > 0 && 采样.length < 4) {
        采样.push({
          增量数: deltas,
          页面长度: body.length,
          含收到: body.includes('收到'),
          含正在跑字样: body.includes('深度求索') || body.includes('进行中'),
          尾部: body.slice(-70),
        })
      }
    }
    if (ws['event / turn_finished'] !== undefined && (ws['event / assistant_message'] ?? 0) > 0) {
      for (let k = 0; k < 20; k += 1) await tick()
      sawTurnFinished = true
      break
    }
  }

  const body = document.body.innerText || ''
  const f = (globalThis.__REPLICA_FOLLOW__ ?? []).find((e) => e.sessionId === sessionId)
  const live = (globalThis.__REPLICA_LIVE__ ?? []).filter(
    (x) => String(x.sessionId) === String(sessionId).slice(0, 8),
  )
  const log = globalThis.__REPLICA_DELIVER__ ?? []
  return JSON.stringify(
    {
      点开时它已经在跑: true,
      看到回合结束: sawTurnFinished,
      在线帧的turnStep: [...new Set(live.map((x) => `${x.frameType}/${x.turnStep}`))],
      /*
       * ★ 每条跟随流开头都会投一帧 `snapshot` —— 所以**快照次数就是重建次数**。
       * 在线行"字消失/只剩片段"多半是客户端判了 `rebaseline` 把流重建了一次。
       */
      快照次数: log.filter((x) => x === 'snapshot').length,
      投递日志: log.slice(-24),
      落盘事件序列: f?.appended ?? [],
      跑到一半时看到正文: sawTextWhileRunning,
      收尾后正文在: body.includes('收到') && body.includes('假端点'),
      跑到一半时的页面: 采样,
      开步记录: globalThis.__REPLICA_STEP_OPEN__ ?? [],
      控制台: console_.slice(-6),
    },
    null,
    1,
  )
})()
