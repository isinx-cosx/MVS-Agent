/**
 * 传输层：只负责"怎么和守护进程说话"，不含任何界面逻辑。
 *
 * 协议就五样，全部来自 `src/host`：
 *
 *   GET  /state                                  工作区与会话列表
 *   GET  /projection?sessionId=…                 一个会话的完整投影（**唯一真相**）
 *   POST /command                                命令（发消息、中止、建会话）
 *   WS   /ws                                     宿主事件推送（**只是提示**）
 *      └ 连上后先发 {type:'watch', sessionIds:[…]} —— 订阅是按"连接"记的
 */

export interface WorkspaceSummary {
  path: string
  name: string
  sessionCount: number
  lastOpenedAt?: string
}

export interface SessionSummary {
  sessionId: string
  workspace: string
  title: string
  status: string
  alert?: string
  turn: number
  step: number
  interruptedTool?: string
  createdAt: string
  updatedAt: string
}

export interface ToolCallSummary {
  name?: string
  id?: string
  /**
   * 参数（JSON 字符串）。**投影里本来就有**，只是界面一直没用。
   *
   * 有它才能显示"这条工具到底干了什么"（`run_command g++ …`、`write_file x.cpp`），
   * 而不是一句光秃秃的"调用工具 X"。
   */
  argsJson?: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: unknown
  /** 思维链。界面用它渲染可折叠的思考块 */
  reasoning?: string
  toolCalls?: ToolCallSummary[]
  toolCallId?: string
}

export interface InterruptedCall {
  callId?: string
  tool?: string
  argsJson?: string
}

export interface Projection {
  sessionId: string
  workspace: string
  model: string
  /** 当前会话的权限模式：`read-only` / `workspace-write` / `full-access` */
  mode: string
  status: string
  turn: number
  step: number
  messages: ChatMessage[]
  contextTokens: number
  contextWindowTokens: number
  /** 预算（daemon 按窗口与保留量算出来的），只用于显示，界面不拿它设限 */
  contextBudgetTokens?: number
  /**
   * **最近一次**模型调用的用量（不是历史）。只有引擎才知道的两件事从这里来：
   * 提示缓存命中率、真实的 token/秒。端点不给时**整个字段缺席** —— 那是"不知道"，
   * 不是"没命中"。
   */
  lastUsage?: {
    inputTokens: number
    outputTokens: number
    cachedTokens?: number
    tokensPerSecond?: number
  }
  interruptedCall?: InterruptedCall | null
  /**
   * 有一次工具调用**正在等人批准**。
   *
   * ⚠️ 这个字段从第一天就在投影里，而界面一直没渲染它 —— 后果是：在
   * `workspace-write` 模式下，需要审批的工具会让整轮对话**静默停住**
   * （状态变成 `awaiting-approval`，所以连"正在生成"都不显示），用户看不到
   * 任何解释。（之前没暴露，是因为会话都在 `full-access` 下跑，压根不触发审批。）
   */
  pendingApproval?: {
    approvalId: string
    callId: string
    tool: string
    argsJson: string
    message: string
  } | null
  /**
   * 抗疲劳熔断器的状态。
   *
   * 它是一道**单向门**：命中之后 `allow` 规则的批准权被剥夺（之后的写文件与执行命令
   * 都会被降级成"要你确认"），只有人明确复位才解除。所以界面必须同时给出
   * **原因**（计数）和**出口**（复位按钮）—— 否则用户只会觉得软件突然变烦，
   * 然后去点更多次"允许"，恰好是熔断器想阻止的那件事。
   */
  fatigue?: { active: boolean; consecutiveBlocks: number; totalBlocks: number }
}

/** 宿主事件。字段按需取，未知类型一律忽略 —— 不认识的类型不该让界面崩 */
export interface HostEvent {
  type: string
  text?: string
  reasoning?: string
  message?: string
  tool?: string
  turn?: number
  step?: number
}

type ServerFrame =
  | { kind: 'event'; envelope: { sessionId: string; event: HostEvent } }
  | { kind: 'projection'; sessionId?: string }
  | { kind: 'state' }
  | { kind: string }

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  return (await res.json()) as T
}

/**
 * 发一个 POST 并把响应体读回来。
 *
 * 只在**需要返回值**的地方用（开目录框要拿用户选中的路径）。发命令走下面的
 * `postCommand`：那个把 `ok:false` 变成异常，因为命令的语义是"你做没做成"。
 */
async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    /* 尽量把服务端的说明带出来 —— 它比状态码有用得多 */
    const detail = (await res.json().catch(() => ({}))) as { message?: string; error?: string }
    throw new Error(detail.message ?? detail.error ?? `${url} → HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

/**
 * 配置里**设置页用得到的**那几项。
 *
 * ⚠️ 只声明我们真会显示的字段，而且**都是只读展示**。
 *
 * ⚠️⚠️ `apiKey` 是**掩码**（形如 `sk-…7dae`），不是真密钥。设置页可以显示它，
 * 但**绝不能把它写回配置** —— 那会把真密钥覆盖成一串点。配置层有一条测试专门
 * 守这件事（"打码占位符不能被写回文件"）。这一批只读，所以现在没有这个风险；
 * 等开始编辑配置时必须回到这条规则上来。
 */
export interface ConfigSummary {
  model: {
    baseUrl: string
    model: string
    models?: string[]
    apiKey?: string
    apiKeyIsPlaintext?: boolean
    /**
     * 生成参数。**只在设过时才有** —— 设置页据此把"没设"显示成空框，
     * 而不是显示 0（0 是合法且完全不同的取值 ✓）。
     */
    temperature?: number
    maxTokens?: number
  }
  activeProvider?: string
  permissions?: { defaultMode?: string }
  paths?: { home?: string; config?: string }
  providers?: Record<
    string,
    {
      baseUrl?: string
      model?: string
      label?: string
      apiKey?: string
      /** 这个供应商下可选的模型 —— 输入框下面那个模型下拉框靠它 */
      models?: string[]
      /* 生成参数：设置页按**当前供应商**预填，所以要按供应商带出来 */
      temperature?: number
      maxTokens?: number
    }
  >
}

export interface StateResponse {
  state: {
    workspaces: WorkspaceSummary[]
    sessions: SessionSummary[]
    config?: ConfigSummary
    /** 上下文窗口与它的**出处**（daemon 从引擎探测来的，不是猜的） */
    window?: { tokens: number; source: string }
  }
}

export function getState(): Promise<StateResponse> {
  return getJSON('/state')
}

/**
 * 路径选择：**照搬 DSH 的那套**，不是我们自己发明的。
 *
 * 三个端点都在 `src/host/server.ts` 里，守卫与语义都由它决定：
 *
 *   GET  /picker            能力判定：`native`（系统对话框）还是 `browse`（页面内浏览）
 *   POST /pick-directory    开系统对话框，**等用户选完才返回**（上限 5 分钟）
 *   GET  /picker/dirs       browse 后端的目录列表（缺参时列主目录）
 *   POST /picker/mkdir      browse 后端建子目录
 *
 * ## 为什么必须先问能力，而不是直接开框
 *
 * 系统对话框开在**守护进程那台机器**的屏幕上。远程（SSH）启动时，操作者在另一台
 * 机器前 —— 直接开框的结果是**一片沉默**：界面点了没反应，而服务端正开着框等一个
 * 看不见的人点。这个错在本地开发时永远不会出现。
 *
 * 所以 `reason` 与 `error` 两个字段**是设计成直接给用户看的**，界面应当原样显示，
 * 不要替换成"操作失败"这种废话。
 */
export interface PickerCapability {
  kind: 'native' | 'browse'
  reason: string
}

export interface PickResult {
  /** 选中的绝对路径；取消时为 null */
  path: string | null
  cancelled: boolean
  error?: string
}

export function getPicker(): Promise<PickerCapability> {
  return getJSON('/picker')
}

export function pickDirectory(): Promise<PickResult> {
  return postJSON<PickResult>('/pick-directory', {})
}

/**
 * 取消息的纯文本。
 *
 * `content` 有两种形态：普通字符串，或分块数组（多模态那块）。界面只画文本，
 * 所以两种都要能处理 —— 否则遇到分块消息会渲染成 `[object Object]`。
 */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        const text = (part as { text?: unknown } | null)?.text
        return typeof text === 'string' ? text : ''
      })
      .join('')
  }
  return ''
}

export function getProjection(sessionId: string): Promise<{ projection: Projection }> {
  return getJSON(`/projection?sessionId=${encodeURIComponent(sessionId)}`)
}

/**
 * 发一条命令。
 *
 * ⚠️ **命令的返回值必须当真。** 守护进程在"什么都没发生"时也可能回 `ok:true`
 * （我们撞过：会话处于 interrupted 状态，发消息不启动回合，只丢一个 error 事件），
 * 所以真正的失败判定要同时看 `ok` 与事件流里的 `error`。
 *
 * 返回值**带回来**而不是丢掉：有几条命令的结果是有用的
 * （`create_session` 回新会话 id、`acknowledge_interrupted` 之类只回 ok）。
 */
export async function postCommand(
  command: Record<string, unknown>,
): Promise<{ ok?: boolean; message?: string; sessionId?: string }> {
  const res = await fetch('/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command),
  })
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; sessionId?: string }
  if (res.ok && body.ok !== false) return body
  throw new Error(body.message ?? `${String(command.type)} → HTTP ${res.status}`)
}

/**
 * 写 daemon 配置（`POST /model-config`）。
 *
 * ## 什么时候才允许调它
 *
 * **只有用户明确按了一次"保存"** ✓ —— 这是这个项目的第一条硬规则：
 * `~/.mvs-agent/config.json` 只能因为用户的一次配置动作而改变。任何"顺手写回"
 * "同步一下""为了让界面好看"都不允许碰它。
 *
 * ## 字段语义（界面的"空 = 不改"规则就靠这个）
 *
 *   · **不传**  → 不改这个字段（界面里留空走这条 ✓）
 *   · `null`   → **清掉**（显式动作，界面里是那个 ×）
 *   · 有值     → 设成这个值
 *
 * ⚠️ **掩码绝不能走这条路回写。** `apiKey` 的掩码只用于显示；真要用它覆盖，
 * 用户存的那把密钥就变成了一串星号。配置层有测试专门守这条。
 */
export async function postModelConfig(
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch('/model-config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const text = await res.text()
  try {
    return JSON.parse(text) as { ok: boolean; message?: string }
  } catch {
    /* 回的不是 JSON 时**把原文带出来** —— 只说"保存失败"等于什么都没说 */
    return {
      ok: false,
      message: `守护进程回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`,
    }
  }
}

export interface SessionSocketHandlers {
  onEvent: (event: HostEvent) => void
  /** 投影变了 —— 调用方应重新拉一次 `/projection`（真相） */
  onChanged: () => void
  onStatus: (text: string) => void
}

/** 命令的返回值形状（HTTP 与 WS 两条路一样） */
export interface CommandResult {
  ok?: boolean
  message?: string
  sessionId?: string
}

/**
 * 在会话的 WebSocket 上发一条命令。`null` = **没能走这条路**（socket 没开、或超时），
 * 调用方应当回落到 HTTP。
 *
 * ## 为什么命令要走 WS，而不是一直用 HTTP
 *
 * 逐 token 增量是**唯一**被"订阅过没有"过滤的事件，而订阅是客户端另外声明的。
 * HTTP 那条路**不知道**是哪个连接在发消息，所以服务端没法替它订阅 ——
 * 于是"打开会话 → 发消息"这件事存在一个窗口：消息发出去了，订阅还没到，
 * 那一轮的增量被整段丢掉（现象：第一轮不流式、后面就好了）。
 *
 * 走 WS 之后这个窗口**从构造上消失**：服务端收到命令就顺手把该会话登记进
 * 这条连接的订阅集合（`server.ts` 的 `#handleClientMessage` 里有那一段）。
 */
export type CommandSender = (command: Record<string, unknown>) => Promise<CommandResult | null>

/**
 * 订阅一个会话的宿主事件。
 *
 * 返回断开函数与**命令发送器**。断了会自动重连并**重新 watch**：订阅是按连接记的，
 * 不重发的话重连之后一条增量都收不到（这个坑在旧垫片上踩过）。
 */
export function connectSession(
  sessionId: string,
  handlers: SessionSocketHandlers,
): { dispose: () => void; command: CommandSender } {
  let socket: WebSocket | null = null
  let retry = 0
  let timer: number | undefined
  let closed = false

  /** 等回执的命令：id → 回调。回执带同一个 id，超时就删掉（不让它永远挂着） */
  const pending = new Map<string, (result: CommandResult | null) => void>()
  const COMMAND_TIMEOUT_MS = 15_000

  const command: CommandSender = (input) => {
    const ws = socket
    if (ws === null || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null)

    const id = `c${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise<CommandResult | null>((resolve) => {
      const done = (result: CommandResult | null): void => {
        pending.delete(id)
        resolve(result)
      }
      pending.set(id, done)
      window.setTimeout(() => {
        if (pending.has(id)) done(null)
      }, COMMAND_TIMEOUT_MS)
      ws.send(JSON.stringify({ ...input, id }))
    })
  }

  const open = (): void => {
    if (closed) return
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${scheme}//${location.host}/ws`)
    socket = ws

    ws.addEventListener('open', () => {
      retry = 0
      handlers.onStatus('已连接')
      ws.send(JSON.stringify({ type: 'watch', sessionIds: [sessionId] }))
      handlers.onChanged()
    })

    ws.addEventListener('message', (ev) => {
      let frame: ServerFrame
      try {
        frame = JSON.parse(String(ev.data)) as ServerFrame
      } catch {
        return
      }
      if (frame.kind === 'event') {
        const envelope = (frame as { envelope: { sessionId: string; event: HostEvent } }).envelope
        if (envelope.sessionId !== sessionId) return
        handlers.onEvent(envelope.event)
        return
      }
      /* 命令回执：把它交给等在它上面的那个 promise */
      if (frame.kind === 'commandResult') {
        const result = frame as { id?: string; ok?: boolean; message?: string; sessionId?: string }
        const resolve = result.id === undefined ? undefined : pending.get(result.id)
        if (resolve !== undefined) {
          resolve({ ok: result.ok, message: result.message, sessionId: result.sessionId })
        }
        return
      }
      if (frame.kind === 'projection') handlers.onChanged()
    })

    ws.addEventListener('close', () => {
      /* 连接没了，挂在它上面的命令全部作废（调用方会回落 HTTP） */
      for (const [id, resolve] of pending) {
        pending.delete(id)
        resolve(null)
      }
      if (closed) return
      handlers.onStatus('连接断开，重连中…')
      const wait = Math.min(1000 * 2 ** retry, 10000)
      retry += 1
      timer = window.setTimeout(open, wait)
    })

    ws.addEventListener('error', () => {
      /* 出错后浏览器一定会再发 close，重连逻辑放在那里，避免两处各连一次 */
    })
  }

  open()

  return {
    dispose: () => {
      closed = true
      if (timer !== undefined) window.clearTimeout(timer)
      socket?.close()
    },
    command,
  }
}
