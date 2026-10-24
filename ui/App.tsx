/**
 * 界面：**上面是对话，下面是一个输入框。**
 *
 * 这一层刻意很薄 —— 所有状态机在 `useSession` 里，这里只负责画。
 *
 * 两个刻意的设计：
 *
 *   · **思考块进行中默认展开、结束后收起。** 旧那套界面思考默认折叠，于是
 *     "思考不显示"看起来像流式坏了。展开与否应当跟着状态走，不该让用户去找。
 *   · **只在用户本来就在底部时才自动滚动**，否则他往上翻历史会被不断拽回来。
 */

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import {
  textOf,
  getPicker,
  pickDirectory,
  postCommand,
  postModelConfig,
  type ChatMessage,
  type SessionSummary,
  type ToolCallSummary,
  type TransactionSummary,
  type WorkspaceSummary,
} from './client.ts'
import { isAtBottom, stickDelta } from './stick.ts'
import { displayedModel, selectedModel } from './model-choice.ts'
import { Markdown } from './markdown.tsx'
import { SettingsPage } from './Settings.tsx'
import { resetSettings, updateSettings, useSettings } from './settings.ts'
import { shortTime, useIndex } from './useIndex.ts'
import { useJitter } from './useJitter.ts'
import { useSession, type LiveBlock } from './useSession.ts'

/** 诊断读数只在 `?debug` 时出现 —— 平时不占地方，也不参与布局 */
const DEBUG = new URLSearchParams(location.search).has('debug')

/**
 * 三种权限模式。
 *
 * 标签必须短（它要待在输入框里），但**后果写在 tooltip 里** ——
 * "只读 / 可写 / 完全放行"这种抽象词最容易让人误判自己交出去了什么。
 */
const MODES = [
  { value: 'read-only', label: '只读', hint: '只允许读：任何写入与命令都会被拒绝' },
  { value: 'workspace-write', label: '工作区', hint: '只允许改工作区内的文件；工作区外一律拒绝' },
  { value: 'full-access', label: '完全放行', hint: '不再限制范围 —— 等于把这台机器的权限交给模型' },
] as const

/** 压成一行并截断 —— 给人看的摘要，不是给机器解析的 */
function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine
}

/**
 * 从工具参数里挑一句最能说明"它要干什么"的话。
 *
 * 用途有两个：审批卡片（人要据此决定允不允许）和工具调用块的一行摘要。
 * 按常见工具的"主角字段"挑，挑不到再退回第一个非空字符串 —— 目标是**永远有话说**，
 * 而不是精确解析每一家的参数形状。
 */
function summarizeArgs(argsJson: string | undefined): string {
  if (argsJson === undefined) return ''
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return ''
  }
  for (const key of ['command', 'path', 'query', 'pattern', 'url']) {
    const value = args[key]
    if (typeof value === 'string' && value !== '') return clip(value)
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value !== '') return clip(value)
  }
  return ''
}

function prettyJson(raw: string | undefined): string {
  if (raw === undefined) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    /* 参数不是合法 JSON 时**原样显示** —— 不能因为格式化失败就把内容吞掉 */
    return raw
  }
}

/**
 * 自己写的下拉框。
 *
 * ## 为什么不用原生 `<select>`
 *
 * 它的**弹层由操作系统画** —— 字体、行高、间距、圆角、分组标题，我们一个都改不了。
 * 而它旁边就摆着另一个控件，两者并排时差别最明显。
 *
 * ## 代价要一样一样补回来
 *
 * 原生 `<select>` 白送的东西，自己写就都得自己实现：
 *   · 点外部关闭（少了它，下拉框会一直挂在页面上）
 *   · Esc 关闭、↑↓ 打开（少了键盘用户只能靠鼠标）
 *   · `role="listbox"` / `role="option"` / `aria-selected` / `aria-expanded`
 *     （少了屏幕阅读器读不出这是个可选项列表）
 *   · 当前项要**看得出来** —— 这里用底色 + 左侧粗边，**不用 符号**
 *     （这个界面里不用对勾/叉号当标记）
 *
 * ⚠️ 箭头用**字形**（`▾`）不用 SVG —— 这个项目踩过：SVG 加号在用户屏幕上
 * 一个像素都没画出来，换成字形就好了。
 */
interface DropdownItem {
  key: string
  label: string
  hint?: string
  selected?: boolean
  onPick: () => void
}

function Dropdown({
  label,
  title,
  groups,
  disabled = false,
}: {
  label: string
  title: string
  groups: { title?: string; items: DropdownItem[] }[]
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (boxRef.current !== null && !boxRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className={open ? 'dd open' : 'dd'} ref={boxRef}>
      <button
        type="button"
        className="dd-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        title={title}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <span className="dd-label">{label}</span>
        <span className="dd-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open ? (
        <div className="dd-panel" role="listbox">
          {groups.map((group, index) => (
            <div className="dd-group" key={group.title ?? index}>
              {group.title === undefined ? null : <div className="dd-group-title">{group.title}</div>}
              {group.items.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={item.selected === true}
                  className={item.selected === true ? 'dd-item on' : 'dd-item'}
                  title={item.hint ?? item.label}
                  onClick={() => {
                    setOpen(false)
                    item.onPick()
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * **改动与撤销。**
 *
 * 这个面板回答两个问题，而且是**按这个顺序**：
 *
 *   1. **这一步改了什么？**（路径列表）—— 每小时都要问几十次
 *   2. 要不要**撤回这一条**？—— 一年问几次
 *
 * 顺序不能反：原来的设计把路径留到"按了撤销之后的报告里"，
 * 可用户得先看见改了什么，才谈得上决定要不要撤。
 *
 * ## 为什么放在侧栏、而不是输入框里
 *
 * 输入框那一块你定过规矩：**内容要少、要被顶上去，不许往里塞东西**。
 * 而看改动是"一边看对话一边看"的事 —— 侧栏正好在那儿，且它是可折叠的。
 *
 * ## 只撤单条，没有"全部撤回"
 *
 * 这是刻意的，不是没做：`guard.ts:65-70` 写着有后台作业在跑时，
 * 「动作前 → 动作后」这个时间窗的归属**无法确定** —— 而"整会话回滚"正是
 * 归属最不确定的那个粒度。**宁可少一个按钮，也不提供一个会删错东西的按钮**。
 */
function ChangesPanel({
  transactions,
  onLoad,
  onRevert,
  reverting,
}: {
  transactions: TransactionSummary[] | null
  onLoad: () => void
  onRevert: (txnId: string) => void
  reverting: string | null
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)

  /* 打开时才拉 —— 投影只带计数，路径按需要 */
  useEffect(() => {
    if (open && transactions === null) onLoad()
  }, [open, transactions, onLoad])

  const total = transactions === null ? 0 : transactions.length

  return (
    <section className="side-section changes">
      <button
        type="button"
        className="changes-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="name">改动{transactions === null ? '' : `（${total}）`}</span>
        <span className="dd-caret" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open ? (
        <div className="changes-body">
          {transactions === null ? (
            <p className="side-empty">读取中…</p>
          ) : total === 0 ? (
            <p className="side-empty">这个会话还没有产生改动</p>
          ) : (
            transactions.map((txn) => {
              /* 三种变化分开列 —— 混在一起看不出"是新增还是覆盖" */
              const groups: { label: string; paths: string[] }[] = [
                { label: '新增', paths: txn.paths?.added ?? [] },
                { label: '修改', paths: txn.paths?.modified ?? [] },
                { label: '删除', paths: txn.paths?.removed ?? [] },
              ]
              const changed = groups.reduce((sum, g) => sum + g.paths.length, 0)
              return (
                <div className="change-item" key={txn.id}>
                  <div className="change-head" title={txn.summary}>
                    <span className="change-tool">{txn.tool}</span>
                    <span className="change-count">
                      {txn.added > 0 ? `+${txn.added} ` : ''}
                      {txn.modified > 0 ? `~${txn.modified} ` : ''}
                      {txn.removed > 0 ? `-${txn.removed}` : ''}
                    </span>
                  </div>

                  {txn.paths === undefined ? (
                    <div className="set-hint">（没带路径）</div>
                  ) : changed === 0 ? (
                    <div className="set-hint">这次调用没有留下净改动</div>
                  ) : (
                    groups
                      .filter((g) => g.paths.length > 0)
                      .map((g) => (
                        <div className="change-group" key={g.label}>
                          <span className="change-kind">{g.label}</span>
                          <span className="change-paths">{g.paths.join('、')}</span>
                        </div>
                      ))
                  )}

                  {confirming === txn.id ? (
                    <div className="side-confirm">
                      <span>撤回这次改动？</span>
                      <button
                        type="button"
                        className="side-mini danger"
                        onClick={() => {
                          setConfirming(null)
                          onRevert(txn.id)
                        }}
                      >
                        撤回
                      </button>
                      <button type="button" className="side-mini" onClick={() => setConfirming(null)}>
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="side-mini"
                      disabled={reverting !== null || changed === 0}
                      title={
                        changed === 0
                          ? '这次调用没有留下净改动，没有可撤回的东西'
                          : '把这几个文件还原到这次调用之前的状态'
                      }
                      onClick={() => setConfirming(txn.id)}
                    >
                      {reverting === txn.id ? '撤回中…' : '撤回这次'}
                    </button>
                  )}
                </div>
              )
            })
          )}
        </div>
      ) : null}
    </section>
  )
}

/**
 * 一次工具调用：**默认收起，一行说清它干了什么；展开看参数与结果。**
 *
 * ## 为什么值得做
 *
 * 工具调用是这个 agent 真正"做了什么"的地方，而原来的界面只有一句
 * "调用工具 X" —— 参数和结果都看不见。更要紧的是：**参数一直都在投影里**
 * （`argsJson`），是我们的类型没声明、界面把它扔掉了。
 *
 * 一个看不见动作的 agent 界面，用户就只能靠信任。而信任不该是唯一的选择。
 *
 * 用 `useState` 而不是 `<details>`：这是**我们自己在控制**开合，不涉及
 * "React 每次重渲染把 open 属性同步回去"那个坑（思考块踩过）。
 */
function ToolCallBlock({ call, result }: { call: ToolCallSummary; result?: ChatMessage }) {
  const [open, setOpen] = useState(false)
  const summary = summarizeArgs(call.argsJson)
  const output = result === undefined ? '' : textOf(result.content)
  const waiting = result === undefined

  return (
    <div className={waiting ? 'tool-call waiting' : 'tool-call'}>
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => setOpen((open) => !open)}
      >
        <svg className="chev" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="tool-name">{call.name ?? '工具'}</span>
        <span className="tool-summary">{waiting ? '执行中…' : summary}</span>
      </button>

      {open ? (
        <div className="tool-body">
          {call.argsJson === undefined ? null : (
            <pre className="tool-pre">{prettyJson(call.argsJson)}</pre>
          )}
          {waiting ? (
            <div className="tool-empty">还没有结果</div>
          ) : output === '' ? (
            <div className="tool-empty">（没有输出）</div>
          ) : (
            <pre className="tool-pre out">{output}</pre>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 侧栏宽度：默认值、上下限、以及记住它的键 */
const SIDEBAR_DEFAULT = 236
const SIDEBAR_MIN = 180
const SIDEBAR_MAX = 480
const SIDEBAR_KEY = 'mvs.sidebarWidth'

function clampWidth(px: number): number {
  /* 窗口很窄时不能让侧栏吃掉一半以上 —— 上限跟着窗口走 */
  const max = Math.min(SIDEBAR_MAX, Math.round(window.innerWidth * 0.5))
  /*
   * ⚠️ **必须取整。** 拖拽给的是亚像素值（`306.4000915527344`），不取整它会被原样
   * 存进 localStorage、再原样显示在设置页里 —— 一个拖出来的小数在界面上裸奔。
   * 宽度也不需要亚像素精度。
   */
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(px, max)))
}

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY)
    const value = raw === null ? Number.NaN : Number.parseFloat(raw)
    return Number.isFinite(value) ? clampWidth(value) : SIDEBAR_DEFAULT
  } catch {
    /* 隐私模式下 localStorage 会直接抛 —— 那就用默认值，不该因此起不来 */
    return SIDEBAR_DEFAULT
  }
}

function storeWidth(px: number): void {
  try {
    localStorage.setItem(SIDEBAR_KEY, String(px))
  } catch {
    /* 记不住就算了，不该为此报错 */
  }
}

/**
 * 当前在看哪个对话。
 *
 * 记住它，刷新之后回到同一个对话 —— 否则每次刷新都会被丢回"最近的会话"，
 * 而"最近"在你刚翻了别的对话之后恰恰不是你所在的那个。
 *
 * ⚠️ 这个 id 可能已经失效（对话被删了）。**失效的兜底在 `useSession` 里**
 * （先探一次投影，不在了就退回自动挑选并说明），这里不做判断 ——
 * 两处各判一次必然会漂。
 */
const SESSION_KEY = 'mvs.sessionId'

function readStoredSession(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

function storeSession(id: string): void {
  try {
    localStorage.setItem(SESSION_KEY, id)
  } catch {
    /* 同上 */
  }
}

/**
 * 思考块。
 *
 * ## 两条行为都是刻意的
 *
 * **一、思考期间默认展开，结束后自动收起。** 旧那套界面思考默认折叠，于是
 * "思考不显示"看起来像流式坏了；展开与否应当跟着状态走，不该让用户去找。
 *
 * **二、内容要跟着最新的一行走。** 这块有 `max-height`，超出后内部滚动 ——
 * 若不主动滚到底，看到的就是**开头那几句**，新内容全在视野之外，表现成
 * "界面上不动"。这里在内容变化时把它滚到底；但**用户一旦往上翻就不再抢**，
 * 免得他正在读的东西被不断拽走。
 *
 * `open` 用 ref 直接设、不走 React 的 `open` 属性：后者每次重渲染都会把它同步回
 * `active`，于是用户在流式期间手动收起会被下一个增量顶开。只有 `active` 变化时
 * 才动它，手动操作就留得住。
 */
function ThinkBlock({ reasoning, active }: { reasoning: string; active: boolean }) {
  const details = useRef<HTMLDetailsElement>(null)
  const text = useRef<HTMLDivElement>(null)
  /** 是否跟随底部。用户往上翻就置 false，滚回底部再恢复 */
  const stick = useRef(true)

  /*
   * 这两个也放 layout 阶段：展开状态与内部滚动都应当在**绘制之前**定好，
   * 否则会先画一帧"收起 / 停在顶部"的样子再纠正 —— 同一种中间态抖动。
   */
  useLayoutEffect(() => {
    const el = details.current
    if (el !== null) el.open = active
  }, [active])

  useLayoutEffect(() => {
    const el = text.current
    if (el === null || !active || !stick.current) return
    el.scrollTop = el.scrollHeight
  }, [reasoning, active])

  return (
    <details className="think" ref={details}>
      <summary>{active ? '思考中…' : `思考（${reasoning.length} 字）`}</summary>
      <div
        className="text"
        ref={text}
        onScroll={(event) => {
          const el = event.currentTarget
          /* 离底部 24px 以内算"还在跟随" */
          stick.current = isAtBottom(el)
        }}
      >
        {reasoning}
      </div>
    </details>
  )
}

/** 一条已落盘的消息。`memo` 是为了流式期间不要把这些重画一遍 */
const Message = memo(function Message({
  message,
  results,
}: {
  message: ChatMessage
  /** 工具调用 id → 它的返回。由上层按 `toolCallId` 配好 */
  results: Map<string, ChatMessage>
}) {
  /*
   * ⚠️ **这个 hook 必须在任何提前 return 之前调用。**
   * 下面"系统消息直接不显示"那一支会 return null —— 如果 hook 写在它后面，
   * 不同类型消息之间的 hook 顺序就会变，React 会直接报错。
   */
  const settings = useSettings()

  if (message.role === 'system') return null

  if (message.role === 'tool') {
    return (
      <div className="msg tool">
        <div className="body">[工具返回] {textOf(message.content)}</div>
      </div>
    )
  }

  if (message.role === 'user') {
    return (
      <div className="msg user">
        <div className="body">{textOf(message.content)}</div>
      </div>
    )
  }

  return (
    <div className="msg assistant">
      {message.reasoning !== undefined && message.reasoning.trim() !== '' ? (
        <ThinkBlock reasoning={message.reasoning} active={false} />
      ) : null}
      {/*
        工具调用：每一次都是一个可展开的块（参数 + 它的返回）。
        返回靠 `toolCallId` 配对 —— 配不上的那种（孤儿返回）由上层单独显示，不在这里。
      */}
      {(message.toolCalls ?? []).map((call, index) => (
        <ToolCallBlock
          key={call.id ?? `${call.name ?? 'call'}-${index}`}
          call={call}
          result={call.id === undefined ? undefined : results.get(call.id)}
        />
      ))}
      {/* 正文走 Markdown；思考与工具返回保持纯文本（它们不是给人读的排版） */}
      <Markdown
        text={textOf(message.content)}
        highlight={settings.highlight}
        math={settings.math}
        images={settings.images}
      />
    </div>
  )
})

/**
 * 正在生成的那一块 —— 流式渲染就发生在这里。
 *
 * 下面那行计数是"如实显示"的一部分：模型绕圈时，光看文字在长很难判断是
 * **在推进**还是**在重复**，而字数与时长是最直接的判据。
 *
 * ⚠️ 时长从**这块挂载**算起。页面在一轮中途被刷新的话，它从刷新那一刻起算，
 * 会比真实时长小 —— 要精确就得把这个时间戳放进状态里，现在不值得。
 */
function LiveMessage({ live }: { live: LiveBlock }) {
  const settings = useSettings()
  const startedAt = useRef(Date.now())
  const [, tick] = useState(0)

  useEffect(() => {
    if (!live.active) return
    const id = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [live.active])

  const seconds = Math.max(0, Math.floor((Date.now() - startedAt.current) / 1000))

  return (
    <div className="msg assistant">
      {live.reasoning === '' ? null : (
        <ThinkBlock reasoning={live.reasoning} active={live.active} />
      )}
      {/*
        正文。
        这里**不放光标**：`▍` 是行内元素，一行快满时它会换到下一行、撑出一行高度，
        下一个字来了又收回去 —— 每帧差一行，就是整页小幅抖动。
        生成中的提示交给下面那行计数，它不参与正文重排。
      */}
      <Markdown
        text={live.text}
        highlight={settings.highlight}
        math={settings.math}
        images={settings.images}
      />
      <div className="meta">
        思考 {live.reasoning.length} 字 · 正文 {live.text.length} 字 · 已跑 {seconds}s
      </div>
    </div>
  )
}

/**
 * 左侧栏：对话**按工作区分组**。
 *
 * ⚠️ **这一步只搭界面，还没有接线。** 所有行点了都**什么都不做**（除分组折叠）。
 *
 * daemon 侧的命令其实都已经存在（`open_workspace` / `close_workspace` /
 * `create_session` / `rename_session` / `delete_session`），这里的字段就是按那些
 * 命令的形状摆的 —— 接线时只要在对应位置补一次 `postCommand`，不用返工。
 *
 * ## 折叠规则
 *
 * 默认**只展开当前会话所在的那个工作区**，其余收起。186 个会话全摊开就没法看了。
 *
 * 一旦用户自己点过任何一个分组，就完全按他的意思来（`expanded !== null`）——
 * 不再回到"自动展开当前工作区"。这比"每次刷新都重置你的选择"要可预期。
 *
 * ## 分组依据
 *
 * `sessions[].workspace` 是工作区**路径**，`workspaces[].path` 是同一把钥匙。
 * 对不上的会话（工作区被关掉、目录被移走）不能丢 —— 单独归到"其他"，
 * 否则界面上会凭空少掉一些对话，而那是最难查的一类问题。
 */
function Sidebar({
  workspaces,
  sessions,
  current,
  error,
  asideRef,
  width,
  drawerOpen,
  onCloseDrawer,
  transactions,
  onLoadChanges,
  onRevert,
  reverting,
  onAddWorkspace,
  onOpenSettings,
  onCreateSession,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onDeleteWorkspace,
  creating,
  busy,
  actionError,
}: {
  workspaces: WorkspaceSummary[]
  sessions: SessionSummary[]
  current: string | null
  error: string | null
  asideRef: RefObject<HTMLElement | null>
  width: number
  /** 窄屏抽屉是否展开。宽屏时这个值不起作用（CSS 只在窄屏读它） */
  drawerOpen: boolean
  /** 关掉抽屉（选中会话、点遮罩、按 Esc 都会调它） */
  onCloseDrawer: () => void
  /* ── 改动与撤销 ── */
  transactions: TransactionSummary[] | null
  onLoadChanges: () => Promise<void>
  onRevert: (txnId: string) => void
  reverting: string | null
  onAddWorkspace: () => void
  onOpenSettings: () => void
  /** 在指定工作区下新建对话 */
  onCreateSession: (workspace: string) => void
  /** 点某条对话就切过去 */
  onSelectSession: (sessionId: string) => void
  /** 重命名一条对话 */
  onRenameSession: (sessionId: string, title: string) => void
  /** 删除一条对话（日志进回收站） */
  onDeleteSession: (sessionId: string) => void
  /** 删除一个工作区（**连同它的全部对话**；磁盘上的项目文件不动） */
  onDeleteWorkspace: (path: string) => void
  /** 正在为哪个工作区建（`null` 表示没有在建）—— 用来显示忙碌态 */
  creating: string | null
  busy: boolean
  actionError: string | null
}) {
  const [expanded, setExpanded] = useState<Set<string> | null>(null)
  /** 正在改名的会话；`null` = 没有 */
  const [renaming, setRenaming] = useState<string | null>(null)
  /**
   * 正在等二次确认的那一项（会话 id 或工作区路径）。
   *
   * 两者共用一个状态是安全的：会话是 UUID、工作区是路径，不会撞。
   * 共用的好处是"同一时刻只可能有一个待确认项"这件事由类型保证。
   */
  const [confirming, setConfirming] = useState<string | null>(null)

  const currentWorkspace = sessions.find((s) => s.sessionId === current)?.workspace ?? null

  const byUpdated = (a: SessionSummary, b: SessionSummary): number => b.updatedAt.localeCompare(a.updatedAt)

  /*
   * `groups` 以前是每次渲染都重算的 —— 十几个会话时无所谓，但一叠加"搜索"，
   * 每敲一个字都会把所有会话重新分组 + 全表过滤一遍，而**打字引起卡顿时的表现
   * 就是"界面在抖"**（这个项目在抖动上栽过，所以这里顺着一起修了）。
   */
  const groups = useMemo(() => {
    const known = new Set(workspaces.map((w) => w.path))
    const orphans = sessions.filter((s) => !known.has(s.workspace))
    return [
      ...workspaces.map((w) => ({
        key: w.path,
        name: w.name === '' ? w.path : w.name,
        rows: sessions.filter((s) => s.workspace === w.path).sort(byUpdated),
      })),
      ...(orphans.length === 0
        ? []
        : [{ key: '__orphans__', name: '其他', rows: orphans.sort(byUpdated) }]),
    ]
  }, [workspaces, sessions])

  /*
   * ── 搜索与条数上限 ────────────────────────────────────────────────────
   *
   * 为什么要有上限：`updatedAt` 排序意味着**最旧的永远在下面**，而列表越长，
   * 想找的东西就越难碰到 —— 一个工作区攒到上百条对话时，侧栏会变成一片滚动条。
   *
   * 三件事一起做才成立：
   *   1. 默认每组只显示最近几条
   *   2. 该组还有更多时，明确写出"还有几条"（**不能悄悄截断** —— 那会让人
   *      以为对话丢了）
   *   3. 搜索时**显示全部匹配**，并且**自动展开**命中的组
   *      （否则匹配项藏在一个收起来的分组里，搜索结果看起来是空的）
   */
  const PER_GROUP = 6
  const [query, setQuery] = useState('')
  /** 被用户点开"显示全部"的那些分组 */
  const [showAllGroups, setShowAllGroups] = useState<ReadonlySet<string>>(new Set())

  const trimmedQuery = query.trim().toLowerCase()

  /** 一组里真正要显示的会话，以及"被折叠掉多少条" */
  const visibleRows = (
    groupKey: string,
    rows: SessionSummary[],
  ): { visible: SessionSummary[]; hidden: number } => {
    if (trimmedQuery !== '') {
      /* 搜索时给出全部匹配 —— 搜索的意义就是"把藏在下面的东西捞出来" */
      const matched = rows.filter(
        (s) =>
          (s.title === '' ? '未命名对话' : s.title).toLowerCase().includes(trimmedQuery) ||
          s.sessionId.toLowerCase().includes(trimmedQuery),
      )
      return { visible: matched, hidden: 0 }
    }
    if (showAllGroups.has(groupKey) || rows.length <= PER_GROUP) {
      return { visible: rows, hidden: 0 }
    }
    return { visible: rows.slice(0, PER_GROUP), hidden: rows.length - PER_GROUP }
  }

  const totalMatches = trimmedQuery === '' ? sessions.length : groups.reduce(
    (sum, g) => sum + visibleRows(g.key, g.rows).visible.length,
    0,
  )

  /**
   * 把"当前工作区默认展开"这个隐式默认变成显式集合。
   *
   * `expanded === null` 表示用户还没碰过折叠，一切都按默认来；一旦要改动其中
   * 任何一项，就先把默认状态固化下来，再改那一项 —— 否则第一下点击会把别的
   * 分组也一起翻掉。
   */
  const materialize = (prev: Set<string> | null): Set<string> =>
    new Set(prev ?? groups.filter((g) => g.key === currentWorkspace).map((g) => g.key))

  const isOpen = (key: string): boolean => {
    /*
     * 搜索期间**一律展开**。
     *
     * 匹配项如果藏在一个收起来的分组里，搜索结果看起来就是空的 —— 而"搜了却没有"
     * 会让人以为对话真的没了。配合下面"没命中的组不渲染"，这里直接展开就不会有噪音。
     */
    if (trimmedQuery !== '') return true
    return expanded === null ? key === currentWorkspace : expanded.has(key)
  }

  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = materialize(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const addSession = (key: string): void => {
    /* 先展开再让上层去建 —— 新会话按 `updatedAt` 排在最上面，展开才看得见它出现 */
    setExpanded((prev) => {
      const next = materialize(prev)
      next.add(key)
      return next
    })
    onCreateSession(key)
  }

  return (
    <aside id="sidebar" ref={asideRef} style={{ width }} data-open={drawerOpen}>
      <section className="side-section">
        <h2>工作区</h2>

        {/*
          会话搜索。

          只在**真的会用到**的时候出现（会话总数超过一屏）—— 三个对话时摆一个搜索框
          是噪音；而对话一多，找一个旧对话的成本会突然变得很高。
        */}
        {sessions.length > PER_GROUP ? (
          <div className="side-search">
            <input
              type="search"
              value={query}
              placeholder="搜索对话…"
              aria-label="搜索对话"
              onChange={(event) => setQuery(event.target.value)}
            />
            {query === '' ? null : (
              <button type="button" className="side-mini" title="清空搜索" onClick={() => setQuery('')}>
                ×
              </button>
            )}
          </div>
        ) : null}

        {/* 搜了但一条都没有：说清楚，而不是给一片空白 */}
        {trimmedQuery !== '' && totalMatches === 0 ? (
          <p className="side-empty">没有匹配「{query.trim()}」的对话</p>
        ) : null}

        {groups.map((group) => {
          const { visible, hidden } = visibleRows(group.key, group.rows)
          /* 搜索期间，没有命中的分组不渲染 —— 免得一屏都是空分组 */
          if (trimmedQuery !== '' && visible.length === 0) return null
          return (
          <div className="side-group" key={group.key}>
            {/*
              头部是 div 包两个 button，不是"button 里面再放 button" —— 后者是非法
              HTML，浏览器会把它拆开，点击行为也就跟着乱了。
            */}
            <div className="side-group-head">
              <button
                type="button"
                className="side-group-toggle"
                aria-expanded={isOpen(group.key)}
                title={group.key}
                onClick={() => toggle(group.key)}
              >
                <svg className="chev" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
                  <path d="M3 1l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="name">{group.name}</span>
                <span className="count">{group.rows.length}</span>
              </button>

              {/*
                在这个工作区下新建对话。
                `__orphans__`（对不上工作区的那些）不给加号 —— 它不是一个真的工作区，
                没有可以往里建的目录。
              */}
              {group.key === '__orphans__' ? null : (
                <button
                  type="button"
                  className="side-group-add"
                  title="在这个工作区新建对话"
                  disabled={creating === group.key}
                  onClick={() => addSession(group.key)}
                >
                  {creating === group.key ? (
                    <span className="add-busy">…</span>
                  ) : (
                    /*
                     * 用**文字加号**而不是 SVG。
                     *
                     * SVG 版本（12px、1.6px 描边、弱色）在用户屏幕上一个像素都没画出来，
                     * 而同一个页面里的 SVG 箭头却是好的 —— 我没能定位到原因，那就换成
                     * 一个不可能画不出来的形式：字形由字体渲染，不依赖描边、viewBox、
                     * `currentColor` 这些环节。
                     */
                    <span className="add-plus" aria-hidden="true">
                      +
                    </span>
                  )}
                </button>
              )}

              {/*
                **删除这个工作区。**

                ⚠️ 它是删除，不是"关闭"：工作区**连同它名下的全部对话**都会从索引里
                消失，而且没有界面能把它们找回来（日志会挪进状态目录的 trash/sessions，
                那是给手工捞的，不是给用户点的）。磁盘上的项目文件一个字节都不动。

                所以：名字直说、后果写在 tooltip 里、并且**必须点两次**。
              */}
              {group.key === '__orphans__' ? null : confirming === group.key ? (
                <div className="side-confirm">
                  <span>
                    删除「{group.name}」及其 {group.rows.length} 条对话？
                  </span>
                  <button
                    type="button"
                    className="side-mini danger"
                    onClick={() => {
                      setConfirming(null)
                      onDeleteWorkspace(group.key)
                    }}
                  >
                    删除
                  </button>
                  <button type="button" className="side-mini" onClick={() => setConfirming(null)}>
                    取消
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="side-group-add danger"
                  title="删除这个工作区：它和它名下的全部对话都会从列表里消失（项目文件不动，日志进回收站）"
                  onClick={() => setConfirming(group.key)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              )}
            </div>

            {isOpen(group.key) ? (
              <ul className="side-list inset">
                {visible.map((s) => (
                  <li key={s.sessionId}>
                    {/*
                      ⚠️ 行是 `div` 包多个 button，不是"button 里再放 button" ——
                      后者是非法 HTML，浏览器会拆开它（工作区分组头踩过同一个坑）。
                    */}
                    <div className={s.sessionId === current ? 'side-item active' : 'side-item'}>
                      {confirming === s.sessionId ? (
                        /* 删除要点两次，而且**把后果写在按钮上** */
                        <div className="side-confirm">
                          <span>删除这条对话？</span>
                          <button
                            type="button"
                            className="side-mini danger"
                            onClick={() => {
                              setConfirming(null)
                              onDeleteSession(s.sessionId)
                            }}
                          >
                            删除
                          </button>
                          <button type="button" className="side-mini" onClick={() => setConfirming(null)}>
                            取消
                          </button>
                        </div>
                      ) : renaming === s.sessionId ? (
                        <input
                          className="side-rename"
                          defaultValue={s.title}
                          autoFocus
                          placeholder="给它起个名字"
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              const value = event.currentTarget.value.trim()
                              setRenaming(null)
                              if (value !== '') onRenameSession(s.sessionId, value)
                            } else if (event.key === 'Escape') {
                              setRenaming(null)
                            }
                          }}
                          onBlur={() => setRenaming(null)}
                        />
                      ) : (
                        <>
                          <button
                            type="button"
                            className="side-pick"
                            title={s.title === '' ? s.sessionId : s.title}
                            onClick={() => onSelectSession(s.sessionId)}
                          >
                            <span className="dot" data-status={s.status} />
                            <span className="name">{s.title === '' ? '未命名对话' : s.title}</span>
                            <span className="time">{shortTime(s.updatedAt)}</span>
                          </button>
                          <button
                            type="button"
                            className="side-mini"
                            title="重命名这条对话"
                            onClick={() => setRenaming(s.sessionId)}
                          >
                            改
                          </button>
                          <button
                            type="button"
                            className="side-mini danger"
                            title="删除这条对话：它会从列表里消失，日志挪进状态目录的 trash/sessions（磁盘上的项目文件不受影响）"
                            onClick={() => setConfirming(s.sessionId)}
                          >
                            删
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                ))}
                {group.rows.length === 0 ? <li className="side-empty">还没有对话</li> : null}
                {/*
                  **被折叠掉的那几条必须说出来。**
                  悄悄截断会让人以为对话丢了；而这个按钮同时是"我要看全部"的出口。
                */}
                {hidden > 0 ? (
                  <li>
                    <button
                      type="button"
                      className="side-more"
                      title={`这个工作区还有 ${hidden} 条更早的对话`}
                      onClick={() => setShowAllGroups((prev) => new Set(prev).add(group.key))}
                    >
                      还有 {hidden} 条更早的 · 显示全部
                    </button>
                  </li>
                ) : null}
              </ul>
            ) : null}
          </div>
          )
        })}

        {groups.length === 0 ? <div className="side-empty">还没有工作区</div> : null}
      </section>

      <ChangesPanel
        transactions={transactions}
        onLoad={() => void onLoadChanges()}
        onRevert={onRevert}
        reverting={reverting}
      />

      <div className="side-foot">
        {error === null ? null : <div className="side-error">{error}</div>}
        {/*
          动作失败的原因原样显示 —— `picker.ts` / `directory-picker.ts` 里那些
          说明字段**是设计成给用户看的**，换成"操作失败"就白写了。
        */}
        {actionError === null ? null : <div className="side-error">{actionError}</div>}
        <button type="button" className="side-action" onClick={onOpenSettings}>
          设置
        </button>
        <button type="button" className="side-action" disabled={busy} onClick={onAddWorkspace}>
          {busy ? '正在选择…' : '打开工作区…'}
        </button>
      </div>
    </aside>
  )
}

export function App() {
  /* 当前在看哪个对话。`null` = 让 `useSession` 自己挑一个（并记住挑中的那个） */
  const [selected, setSelected] = useState<string | null>(readStoredSession)

  const {
    ready,
    sessionId,
    messages,
    pending,
    live,
    running,
    interruptedTool,
    approval,
    error,
    note,
    mode,
    contextTokens,
    contextWindowTokens,
    lastUsage,
    totalUsage,
    model: sessionModel,
    sessionProvider,
    malformedEvents,
    selectModel,
    fatigue,
    send,
    stop,
    acknowledge,
    setMode,
    resetFatigue,
    approve,
    transactions,
    loadTransactions,
    revert,
    reverting,
  } = useSession(selected)

  /* ── 生成速度：**最近 5 秒的平均** ─────────────────────────────────────
   *
   * 两种做法都试过，都不对：
   *   · `总字数 ÷ 总耗时`（开局至今的平均）—— 它只往上涨，就是"只会涨"那次；
   *   · 纯瞬时值（两次采样之差）—— 抖得厉害，第一个采样还常常是尖峰。
   *
   * 取一段**滑动窗口**的平均同时满足两边：它是平均（不抖），又会随快慢涨落
   * （不只会涨）。窗口外的旧样本丢掉，所以模型慢下来时这个数跟着往下走。
   *
   * 单位仍是**字/秒**：token 数只有引擎知道，而界面手上只有字符数。
   * 中文一个字约一个 token，所以对本地模型是个有意义的近似。
   */
  const SPEED_WINDOW_MS = 5000
  const speedSamples = useRef<{ at: number; chars: number }[]>([])
  const [charsPerSecond, setCharsPerSecond] = useState<number | null>(null)

  useEffect(() => {
    const now = Date.now()
    const chars = live.text.length + live.reasoning.length
    const samples = speedSamples.current
    samples.push({ at: now, chars })

    /* 丢掉窗口之外的旧样本，但**至少留两个** —— 一个点算不出速度 */
    while (samples.length > 2 && now - (samples[0]?.at ?? now) > SPEED_WINDOW_MS) samples.shift()

    const first = samples[0]
    const last = samples[samples.length - 1]
    if (first === undefined || last === undefined || first === last) return

    const seconds = (last.at - first.at) / 1000
    /* 两个样本离得太近时除出来是噪声（比如 3 字 / 0.05 秒 = 60） */
    if (seconds < 0.4) return

    /* 增量可能为负（live 被投影收掉）—— 夹到 0，速度不会变负 */
    setCharsPerSecond(Math.max(0, (last.chars - first.chars) / seconds))
  }, [live])

  /* 记住挑中的那个：刷新之后回到同一个对话 */
  useEffect(() => {
    if (sessionId !== null) storeSession(sessionId)
  }, [sessionId])

  /*
   * 工具调用与它的返回：按 `toolCallId` 配对。
   *
   * 配上的返回**并进调用块里**（就地看得到），配不上的才单独显示 —— 否则同一件事
   * 在界面上会分成两处（"调用工具 X" 和 "[工具返回] …"），而人要自己在中间连线。
   */
  const pairedToolIds = useMemo(() => {
    const ids = new Set<string>()
    for (const message of messages) {
      for (const call of message.toolCalls ?? []) if (call.id !== undefined) ids.add(call.id)
    }
    return ids
  }, [messages])

  const toolResults = useMemo(() => {
    const map = new Map<string, ChatMessage>()
    for (const message of messages) {
      if (message.role === 'tool' && message.toolCallId !== undefined) map.set(message.toolCallId, message)
    }
    return map
  }, [messages])

  /* 已配对的返回不再单独渲染；剩下的（孤儿返回）照旧显示，不能凭空消失 */
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) =>
          !(
            message.role === 'tool' &&
            message.toolCallId !== undefined &&
            pairedToolIds.has(message.toolCallId)
          ),
      ),
    [messages, pairedToolIds],
  )

  /* 工作区与对话列表。挂在 `running` 上：一轮结束后列表才可能变 */
  const {
    workspaces,
    sessions,
    config,
    contextWindow,
    picker,
    skills,
    plugins,
    error: indexError,
    refresh: refreshIndex,
  } = useIndex(running)

  /* 界面设置（只影响这台浏览器，写 localStorage） */
  const settings = useSettings()

  /* 设置页与对话页共用一个主区域 */
  const [view, setView] = useState<'chat' | 'settings'>('chat')

  /*
   * 窄屏下的侧栏抽屉。
   *
   * 宽屏时这个状态**不起作用**（侧栏一直是常驻的，CSS 只在窄屏读 `data-open`），
   * 所以不需要判断窗口宽度 —— 让 CSS 去决定"这个状态有没有意义"比在 JS 里
   * 跟着 resize 事件同步一个 isNarrow 更不容易出错。
   */
  const [drawerOpen, setDrawerOpen] = useState(false)

  /*
   * "空会话"＝一次都没用过的（`turn === 0`）。
   *
   * ⚠️ **清理时要跳过当前正在看的那个**：刚打开页面时它自己也是一个空会话，
   * 删掉它会让界面当场失去目标。
   */
  const emptySessions = sessions.filter((s) => s.turn === 0 && s.sessionId !== sessionId)
  const [cleaning, setCleaning] = useState(false)
  const [cleanupNote, setCleanupNote] = useState<string | null>(null)

  /**
   * 给一条对话改名。
   *
   * 空名字直接不发 —— `rename_session` 要的是"新标题"，发个空串只会把标题清掉，
   * 而"清掉标题"和"没改名"在界面上长得一样（都会显示成"未命名对话"）。
   */
  const renameSession = (sessionId: string, title: string): void => {
    void (async () => {
      setActionError(null)
      try {
        await postCommand({ type: 'rename_session', sessionId, title })
        refreshIndex()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  /** 删除一条对话（daemon 会把它的日志挪进 trash/sessions） */
  const deleteSession = (sessionId: string): void => {
    void (async () => {
      setActionError(null)
      try {
        await postCommand({ type: 'delete_session', sessionId })
        /*
         * ⚠️ 删掉的正是当前会话时，必须让 `useSession` **重新挑一个**：
         * 否则界面会继续指着一个已经不存在的会话 —— 表现为整片空白加一个取不到数据的报错。
         * 传 `null` 就是"你自己挑"，它会挑最近的，挑不到就建一个。
         */
        if (sessionId === selected) setSelected(null)
        refreshIndex()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  /**
   * 删除一个工作区。
   *
   * ⚠️ 命令名是 `close_workspace`，但**它的行为是删除**：工作区和它名下的全部对话
   * 都会从索引里消失（daemon 那边已改成把日志挪进回收站，与删单条一个标准）。
   * 磁盘上的项目文件不受影响。
   */
  const deleteWorkspace = (path: string): void => {
    void (async () => {
      setActionError(null)
      try {
        await postCommand({ type: 'close_workspace', path })
        /* 当前会话可能就在被删的那个工作区里 —— 同样要重新挑一个 */
        if (sessions.find((s) => s.sessionId === selected)?.workspace === path) setSelected(null)
        refreshIndex()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    })()
  }

  /* ── 模型：切换（会话级）与配置（全局） ─────────────────────────────────
   *
   * 两件事刻意分开，因为它们的影响范围不同：
   *   · 切换 = `select_model`，**只动当前会话**
   *   · 保存 = `POST /model-config`，写 `~/.mvs-agent/config.json`，**所有会话一起变**
   *
   * 混成一个按钮的话，用户在设置页点一下就会把别的会话也换掉，而他看不出来发生过什么。
   */
  const [savingConfig, setSavingConfig] = useState(false)
  const [configResult, setConfigResult] = useState<string | null>(null)

  /**
   * 把**当前会话**切到某个供应商的模型。
   *
   * ⚠️ 只传 provider 与模型名 —— 不碰密钥。配置里的 `apiKey` 是掩码，
   * 任何把它带上再写回去的路径都会把真密钥覆盖成一串点。
   */
  const switchModel = (provider: string, model: string): void => {
    if (sessionId === null || model === '') return
    void (async () => {
      setActionError(null)
      try {
        /*
         * ⚠️ **必须走会话命令那条路**（`useSession` 的 `selectModel`），
         * 不能在这里直接 `postCommand` —— 那条路上有两样必不可少的东西：
         *   · 优先走 WS（服务端收到命令就顺手订阅那条连接）
         *   · **命令成功后重拉投影**
         *
         * 少了第二样，切完就得刷新才看得见 —— 用户报的"点了没用"正是这个，
         * 而浏览器 E2E 稳定复现了它（`modelChanged: false` 连跑两次一致）。
         */
        await selectModel(provider, model)
        refreshIndex()
      } catch (err) {
        /* ⚠️ 失败**必须有地方显示** —— 静默的"点了没反应"是这个项目最恨的一类 */
        setActionError(`切模型没成：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }

  /*
   * 技能的三条命令。
   *
   * 它们都是**人**的动作（确认哈希、停用、重扫），模型没有对应的工具 ——
   * 这是「模型能写技能文件，但不能自己批准它」那条链的断点。
   *
   * 发完之后重拉一次索引：`/state.skills` 会跟着变，而设置页显示的就是它。
   */
  const runSkillCommand = (command: Record<string, unknown>): void => {
    void (async () => {
      try {
        setActionError(null)
        await postCommand(command)
        refreshIndex()
      } catch (err) {
        /* 失败必须有地方显示：技能页上"点了没反应"是最难查的一种 */
        setActionError(`技能操作没成：${err instanceof Error ? err.message : String(err)}`)
      }
    })()
  }

  /* 插件：同样都是人的动作（确认清单哈希、按工作区启用、重扫） */
  const runPluginCommand = (command: Record<string, unknown>): void => {
    void (async () => {
      try {
        setActionError(null)
        await postCommand(command)
        refreshIndex()
      } catch (err) {
        setActionError(`插件操作没成：`)
      }
    })()
  }

  /*
   * 输入框下面那一行要用的两组选项。
   *
   * 模型**按供应商分组** —— 因为 `select_model` 本来就要 provider + model 两个参数，
   * 分组之后"换个供应商的模型"是一次选择就能完成的事；不分组的代价是用户得先
   * 去设置页换供应商、再回来选模型（两步，而且第一步还会影响别的会话）。
   *
   * 供应商下没声明 `models` 时只列它当前的模型 —— 与其编几个不存在的选项，
   * 不如让列表里只有真能用的。
   */
  const activeRoute = config?.activeProvider ?? ''
  const currentProvider = activeRoute === '' ? undefined : config?.providers?.[activeRoute]
  /*
   * ★ **会话的模型从投影来**，不是从 /state 的全局配置来 ——
   * 那个是「默认用哪个」，而这个会话可能已经被 select_model 切走了。
   * 读错地方的表现就是「点了没用」：daemon 真的切了、投影也变了，
   * 界面照旧显示全局默认值。全局配置只在会话还没报出模型时兜底。
   */
  const currentModel = displayedModel({
    session: sessionModel,
    provider: currentProvider?.model ?? '',
    global: config?.model.model ?? '',
  })

  /* 哪个该被标成「选中」：会话自己的选择优先于全局配置（见 model-choice.ts 的注释）*/
  const chosen = selectedModel({
    sessionProvider,
    sessionModel,
    globalProvider: activeRoute,
    globalModel: currentProvider?.model ?? '',
  })

  const modelGroups = Object.entries(config?.providers ?? {}).map(([route, p]) => {
    const names = p.models ?? (p.model === undefined || p.model === '' ? [] : [p.model])
    return {
      title: route === activeRoute ? `${p.label ?? route}（当前供应商）` : (p.label ?? route),
      items: names.map((name) => ({
        key: `${route}\u0000${name}`,
        label: name,
        hint: p.baseUrl === undefined ? `${route} · ${name}` : `${route} · ${name} @ ${p.baseUrl}`,
        selected: route === chosen.provider && name === chosen.model,
        onPick: () => switchModel(route, name),
      })),
    }
  })

  const modeItems = MODES.map((item) => ({
    key: item.value,
    label: item.label,
    hint: item.hint,
    selected: item.value === mode,
    onPick: () => void setMode(item.value),
  }))

  /**
   * 保存配置。**只有用户按下"保存"才会走到这里** ——
   * 这是这个项目的第一条硬规则（配置文件只能因为一次明确的用户动作而改变）。
   */
  const saveConfig = (patch: Record<string, unknown>): void => {
    void (async () => {
      setSavingConfig(true)
      setConfigResult(null)
      try {
        const result = await postModelConfig(patch)
        setConfigResult(
          result.ok
            ? '已写入配置文件。生成参数在会话构造时读一次 —— 要重启守护进程才生效。'
            : `没写成：${result.message ?? '守护进程没说原因'}`,
        )
        refreshIndex()
      } catch (err) {
        setConfigResult(`没写成：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setSavingConfig(false)
      }
    })()
  }

  const cleanEmpty = (): void => {
    void (async () => {
      setCleaning(true)
      setCleanupNote(null)
      let done = 0
      let failed = 0
      for (const s of emptySessions) {
        try {
          await postCommand({ type: 'delete_session', sessionId: s.sessionId })
          done += 1
        } catch {
          /* 一条删不掉不该中断整批；最后如实报出数目 */
          failed += 1
        }
      }
      setCleaning(false)
      setCleanupNote(
        failed === 0 ? `已删除 ${done} 条空会话。` : `已删除 ${done} 条，另有 ${failed} 条删除失败。`,
      )
      refreshIndex()
    })()
  }

  /* ── "发出去了但没反应"要说清楚（**只在真的没反应时**） ──────────────
   *
   * 正常路径什么都不显示：先发请求，收到回复就正常显示。只有**运行中且久无任何
   * 增量**时才出现一行提示 —— 因为那正是最容易让人误判成"软件坏了"的状态。
   *
   * 措辞按引擎分，判据是**回环地址**这个事实，不是提供商名字：
   *   · 本地（`127.0.0.1`）：引擎单槽位 —— 别的会话在生成时你会排队而不自知
   *   · 远端：接口一直没有返回内容，多半是网络或服务端慢
   *
   * ⚠️ 只说观察到的（"已等待 N 秒"）+ 一种可能，不替引擎下结论。
   * 本地 35B 长思考时确实可能几十秒不出字，那也是"可能"之一，要一起说。
   */
  const STALL_SECONDS = 30
  const [nowTick, setNowTick] = useState(() => Date.now())
  const lastActivity = useRef(Date.now())

  /* 任何一次增量（`live` 会换新对象）都算活动；一轮开始也重置 */
  useEffect(() => {
    lastActivity.current = Date.now()
  }, [live, running])

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [running])

  const waitedSeconds = running ? Math.floor((nowTick - lastActivity.current) / 1000) : 0
  const stalled = running && waitedSeconds >= STALL_SECONDS

  const engineBaseUrl =
    config?.providers?.[config.activeProvider ?? '']?.baseUrl ?? config?.model.baseUrl ?? ''
  const localEngine = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(engineBaseUrl)

  /* ── 添加工作区 ────────────────────────────────────────────────────────
   *
   * 路径选择走的是 **DSH 那一套**（`/picker` + `/pick-directory`，见 client.ts），
   * 这里只负责把它和 `open_workspace` 命令串起来。
   *
   * 三种情况要分清，不能混成一句"失败了"：
   *   · `browse` 能力  → 这台机器（多半是远端）开不了系统框，得用页面内浏览器；
   *                      那个还没做，所以**如实说清楚**，而不是点了一下没动静
   *   · 用户取消       → 什么都没发生，**不该报错**
   *   · 真的出错       → 把服务端给的原话显示出来
   */
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  /**
   * 在指定工作区下新建对话。
   *
   * daemon 会**回传新会话 id**（`{ok:true, sessionId}`）—— 它那边的注释写着
   * "客户端靠它立刻插一行"。这里没插行，而是重取一次列表：本地往返只有几毫秒，
   * 而重取能顺带把标题、`updatedAt`、状态都对齐，比本地造一行更不容易漂。
   *
   * ⚠️ **建完不会切过去。** 切会话还没做（切走的会话要断流、切来的要重连并重新
   * watch），所以你会看到它出现在那个工作区列表的最上面，但当前对话没变。
   */
  const createSession = (workspace: string): void => {
    void (async () => {
      setCreating(workspace)
      setActionError(null)
      try {
        const created = await postCommand({ type: 'create_session', workspace })
        refreshIndex()
        /*
         * **建完就切过去** —— 两件事都要做：
         *   · 选中新会话（否则你还停在原来那个）
         *   · 切回对话页（否则在设置页点加号，新对话建好了你却看不见）
         */
        if (created.sessionId !== undefined) {
          setSelected(created.sessionId)
          setView('chat')
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setCreating(null)
      }
    })()
  }

  const addWorkspace = (): void => {
    void (async () => {
      setBusy(true)
      setActionError(null)
      try {
        const capability = await getPicker()
        if (capability.kind === 'browse') {
          setActionError(`这台机器上用不了系统目录框（${capability.reason}）—— 页面内的目录浏览器还没做`)
          return
        }

        const picked = await pickDirectory()
        if (picked.cancelled) return
        if (picked.path === null) {
          setActionError(picked.error ?? '没有选到目录')
          return
        }

        await postCommand({ type: 'open_workspace', path: picked.path })
        refreshIndex()
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    })()
  }

  /*
   * ── 侧栏宽度 ────────────────────────────────────────────────────────────
   *
   * 拖拽期间**直接改 DOM**（`asideRef.current.style.width`），松手才落到 state。
   * 若每一帧都 setState，就是一边拖一边重渲染整棵树 —— 流式输出时那一帧本来就
   * 很贵，手感会立刻变糙。松手提交一次，值也不丢。
   */
  const [sidebarWidth, setSidebarWidth] = useState(readStoredWidth)
  const sidebarRef = useRef<HTMLElement>(null)

  const commitWidth = (px: number): void => {
    const next = clampWidth(px)
    setSidebarWidth(next)
    storeWidth(next)
  }

  const startResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    const handle = event.currentTarget
    const aside = sidebarRef.current
    if (aside === null) return

    event.preventDefault()
    /* 指针捕获：手滑出这根 6px 的条也不会丢事件 */
    handle.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = aside.getBoundingClientRect().width
    let latest = startWidth

    const onMove = (move: PointerEvent): void => {
      latest = clampWidth(startWidth + (move.clientX - startX))
      aside.style.width = `${latest}px`
    }
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onUp)
      handle.removeEventListener('pointercancel', onUp)
      commitWidth(latest)
    }

    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onUp)
    handle.addEventListener('pointercancel', onUp)
  }
  const [draft, setDraft] = useState('')
  const logRef = useRef<HTMLElement>(null)
  /*
   * 量的是**贴底那一整块**（`#bottom`：输入框 + 它下面的指标行），不是表单本身 ——
   * 否则指标行的高度不会被算进对话区的底部留白里，最后一条消息会被它盖住。
   */
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /* 抖动的量化：CLS（浏览器口径）+ 内容回缩。详见 useJitter.ts */
  const jitter = useJitter(logRef, running)

  /*
   * 输入框是**悬浮**的（脱离文档流盖在对话区上），所以对话区要自己留出它的高度
   * —— 否则最后一条消息永远被它盖住。
   *
   * 它会随内容变高，写死一个数不够，所以量出来写进 CSS 变量 `--composer-h`，
   * 由 `#log` 的 `padding-bottom` 用。用 ResizeObserver 跟着变（比如输入框长高）。
   */
  useLayoutEffect(() => {
    const composer = bottomRef.current
    const log = logRef.current
    if (composer === null || log === null) return

    const apply = (): void => {
      /*
       * ★ **量完还要把滚动位置一起挪。**
       *
       * 只改 `--composer-h` 的话，多出来的那段底部留白在**下面**，而 `scrollTop`
       * 一点没动 —— 于是在"贴着底部"的时候，最后几行正好被长高了的输入框盖住。
       * 用户报的就是这个："输入框会挡住一些正文"。
       *
       * 判断与算术都抽在 `ui/stick.ts` 里（那里能被单元测试盯住）——
       * 这里只剩读元素、写样式这种一次性的胶水。
       */
      const atBottom = isAtBottom(log)
      const height = composer.getBoundingClientRect().height
      const delta = stickDelta({ atBottom, previousHeight: previous, height })
      log.style.setProperty('--composer-h', `${height}px`)
      if (delta !== 0) log.scrollTop += delta
      previous = height
    }
    let previous = composer.getBoundingClientRect().height
    apply()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(apply)
    observer.observe(composer)
    return () => observer.disconnect()
  }, [])

  /*
   * ★★ **每次渲染后再量一次 —— 这才是「输入框长高」的主力。**
   *
   * ## 为什么上面那个 ResizeObserver 不够（实测）
   *
   * 浏览器诊断（`tools/diag-composer.mjs`）量出来的数字：
   *
   *     输入框长到 340px   →   `--composer-h` 仍然是 150.6px
   *     padding-bottom     →   仍是 162.6px                
   *     于是最后一条正文被盖住 **159px**                    
   *
   * 也就是说：变量在**挂载时量过一次之后就没再更新** ——
   * 光靠 observer 不足以把这一块撑起来。
   *
   * ## 为什么"每次渲染"是对的
   *
   * 输入框长高的**唯一原因**是内容变了，而内容变了必然伴随一次渲染
   *（受控 textarea）。所以在 layout 阶段量一次，时机**正好**，
   * 而且不依赖 observer 的实现细节。
   *
   * observer 仍然留着：字号变化、字体加载完、窗口缩放这类**不经过渲染**的
   * 尺寸变化，只有它能看见。两条腿缺一不可。
   */
  useLayoutEffect(() => {
    const composer = bottomRef.current
    const log = logRef.current
    if (composer === null || log === null) return
    const height = composer.getBoundingClientRect().height
    const atBottom = isAtBottom(log)
    const previous = Number(log.style.getPropertyValue('--composer-h').replace('px', '')) || 0
    const delta = stickDelta({ atBottom, previousHeight: previous, height })
    log.style.setProperty('--composer-h', `${height}px`)
    if (delta !== 0) log.scrollTop += delta
  })

  const hasLive = live.reasoning !== '' || live.text !== '' || live.active

  /*
   * ★ **跟随底部：在底部就跟着，往上翻就停，滚回底部再恢复。**
   *
   * 这是常见聊天软件那一套，也是这里唯一说得通的行为：
   *
   *   · 用户**在底部**（距底部 32px 以内）→ 新内容到了就跟着滚，他看的就是最新
   *   · 用户**往上翻** → 立刻停止跟随，绝不把他正在读的东西拽走
   *   · 他又**滚回底部** → 自动恢复跟随，不需要再点任何东西
   *
   * 状态只由**滚动位置**决定，不由我猜他想干什么。
   *
   * ⚠️ 滚动发生在 **layout 阶段**（绘制之前）：否则会先按"新内容 + 旧滚动位置"
   * 画一帧、再纠正 —— 那正是"一点点抖"的来源。
   */
  const stick = useRef(true)

  const onLogScroll = (): void => {
    const el = logRef.current
    if (el === null) return
    stick.current = isAtBottom(el)
  }

  const scrollToBottom = (): void => {
    const el = logRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
    /* 主动滚到底 = 用户想看最新，跟随随之恢复 */
    stick.current = true
  }

  useLayoutEffect(() => {
    /* 设置页里能选：从不跟随 / 在底部时跟随（默认）/ 总是跟随 */
    if (settings.follow === 'never') return
    if (settings.follow === 'bottom' && !stick.current) return
    scrollToBottom()
  }, [messages, live, pending, interruptedTool, error, note, settings.follow])

  /* 刚发出消息：把他那条和回答的起点带进视野（这是他自己的动作） */
  useLayoutEffect(() => {
    if (pending !== null) scrollToBottom()
  }, [pending])

  useEffect(() => {
    inputRef.current?.focus()
  }, [ready])

  /*
   * 窄屏抽屉的第三个出口：Esc。
   *
   * 只在展开时挂监听 —— 常挂着一个"什么都不做"的键盘处理器，会在用户按 Esc
   * 想取消别的东西时抢走那一下。
   */
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen])

  /*
   * 输入框自动增高。
   *
   * ⚠️ **上限只认 CSS 那一份**（`#input` 的 `max-height`，当前 26vh），
   * 不要再写一个 JS 版的公式。原来写的是 `window.innerHeight * 0.4`，与 CSS 不是
   * 同一个数 —— 差一点点时高度就比内容矮，浏览器立刻画出一条滚动条。
   * 现在改上限只改 CSS 一处，这里自动跟着变。
   *
   * ⚠️ **滚动条不能靠"高度等于 scrollHeight"来避免**：`scrollHeight` 是取整的，
   * 而行高是 `1.65 × 15px = 24.75px` 这种小数，两边永远差一点点，浏览器就会画。
   * 所以直接按**有没有被夹住**来开关 —— 这正是"长到不能再长才出滚动条"的意思：
   *
   *   没到上限 → 高度 = 内容高，`overflow-y: hidden`（**保证**没有滚动条）
   *   到了上限 → 高度 = 上限，`overflow-y: auto`（这时才该有）
   */
  const grow = (): void => {
    const el = inputRef.current
    if (el === null) return
    /* 先归零再量：否则 scrollHeight 里含着上一次设的高度 */
    el.style.height = 'auto'

    const raw = getComputedStyle(el).maxHeight
    /* 一般已把 `40vh` 解析成像素；万一没解析，用视口的 40%（与 CSS 同一个值）兜底 */
    const max = raw.endsWith('px') ? Number.parseFloat(raw) : window.innerHeight * 0.4

    const content = el.scrollHeight
    const clamped = content > max
    el.style.height = `${Math.min(content, max)}px`
    el.style.overflowY = clamped ? 'auto' : 'hidden'
  }

  /*
   * 挂载后立刻量一次，并在草稿变化时重算 —— 包括发完消息被程序清空那一次。
   * 不做这一次的话，初始渲染只有 CSS 的 `min-height` 生效，可能仍然差一点。
   */
  useLayoutEffect(() => {
    grow()
  }, [draft, ready])

  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || !ready) return
    setDraft('')
    const el = inputRef.current
    if (el !== null) el.style.height = 'auto'
    void send(text)
  }

  return (
    <>
      <Sidebar
        workspaces={workspaces}
        sessions={sessions}
        current={sessionId}
        error={indexError}
        asideRef={sidebarRef}
        width={sidebarWidth}
        drawerOpen={drawerOpen}
        onCloseDrawer={() => setDrawerOpen(false)}
        transactions={transactions}
        onLoadChanges={loadTransactions}
        onRevert={(txnId) => void revert(txnId)}
        reverting={reverting}
        onAddWorkspace={addWorkspace}
        onOpenSettings={() => setView('settings')}
        onCreateSession={createSession}
        /*
         * ⚠️ **点对话必须同时切回对话页。**
         *
         * 只 `setSelected` 的话，会话确实换了，但页面还停在设置上 —— 用户的感受
         * 就是"点了没反应"。侧栏在任何页面都在，所以"点它就该去那儿"是默认预期。
         */
        onSelectSession={(sessionId) => {
          setSelected(sessionId)
          setView('chat')
          /* 窄屏下选完就把抽屉收起来 —— 否则它挡着刚切过去的对话 */
          setDrawerOpen(false)
        }}
        onRenameSession={renameSession}
        onDeleteSession={deleteSession}
        onDeleteWorkspace={deleteWorkspace}
        creating={creating}
        busy={busy}
        actionError={actionError}
      />

      {/*
        拖拽分隔条。
        `role="separator"` + `tabIndex` 是为了键盘也能调（左右方向键各 16px），
        双击复位到默认宽度 —— 拖窄了之后总得有条路回去。
      */}
      <div
        id="splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整侧栏宽度"
        tabIndex={0}
        onPointerDown={startResize}
        onDoubleClick={() => commitWidth(SIDEBAR_DEFAULT)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault()
            commitWidth(sidebarWidth - 16)
          } else if (event.key === 'ArrowRight') {
            event.preventDefault()
            commitWidth(sidebarWidth + 16)
          }
        }}
      />

      {/*
        `#main` 是对话区 + 悬浮输入框的容器。
        输入框是 `position: absolute`，定位父级必须是这一列（而不是 `#root`），
        否则它会横跨到左侧栏上面去。
      */}
      {/*
        窄屏的抽屉开关与遮罩。**宽屏下这两个元素是隐藏的**（CSS 里只在
        `max-width: 720px` 那一档让它们出现），所以宽屏用户看到的东西一点没变。

        遮罩点一下就关 —— 它是"我改主意了"最自然的出口。
      */}
      <button
        type="button"
        className="drawer-toggle"
        aria-label="显示会话列表"
        title="会话列表"
        onClick={() => setDrawerOpen(true)}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M2 4h12M2 8h12M2 12h12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>

      {drawerOpen ? (
        <div className="drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
      ) : null}

      <div id="main">
        {view === 'settings' ? (
          <SettingsPage
            settings={settings}
            onChange={updateSettings}
            onReset={resetSettings}
            config={config}
            contextWindow={contextWindow}
            picker={picker}
            sessionCount={sessions.length}
            emptyCount={emptySessions.length}
            sidebarWidth={sidebarWidth}
            onResetSidebarWidth={() => commitWidth(SIDEBAR_DEFAULT)}
            fatigue={fatigue}
            onResetFatigue={() => void resetFatigue()}
            sessionId={sessionId}
            onSwitchModel={switchModel}
            onSaveConfig={saveConfig}
            savingConfig={savingConfig}
            configResult={configResult}
            onCleanEmpty={cleanEmpty}
            cleaning={cleaning}
            cleanupNote={cleanupNote}
            onClose={() => setView('chat')}
            skills={skills}
            onApproveSkill={(workspace, name) =>
              runSkillCommand({ type: 'approve_skill', workspace, name })
            }
            onToggleSkill={(workspace, name, enabled) =>
              runSkillCommand({ type: 'set_skill_enabled', workspace, name, enabled })
            }
            plugins={plugins}
            onApprovePlugin={(workspace, name) =>
              runPluginCommand({ type: 'approve_plugin', workspace, name })
            }
            onTogglePlugin={(workspace, name, enabled) =>
              runPluginCommand({ type: 'set_plugin_enabled', workspace, name, enabled })
            }
            onReloadPlugins={() => runPluginCommand({ type: 'reload_plugins' })}
            onReloadSkills={() => {
              /* 逐个工作区发：命令是工作区级的，一次一个 */
              for (const workspace of workspaces) {
                runSkillCommand({ type: 'reload_skills', workspace: workspace.path })
              }
            }}
          />
        ) : (
          <>
        <main id="log" ref={logRef} onScroll={onLogScroll}>
        <div className="inner">
          {/*
            **空状态。**

            截图暴露过这个洞：选中一个空会话时，右侧整片空白 —— 看起来像加载失败。
            空状态要说清三件事：现在是什么状态、为什么会这样、下一步做什么。
          */}
          {visibleMessages.length === 0 && !hasLive ? (
            <div className="empty">
              <div className="empty-title">这个会话还是空的</div>
              <div className="empty-hint">
                在下面说点什么就能开始。工具调用、改了哪些文件、撤销入口，都会出现在这里。
              </div>
            </div>
          ) : null}
          {visibleMessages.map((message, index) => (
            <Message message={message} results={toolResults} key={`${message.role}-${index}`} />
          ))}

          {pending === null ? null : (
            <div className="msg user">
              <div className="body">{pending}</div>
            </div>
          )}

          {hasLive ? <LiveMessage live={live} /> : null}

          {/*
            阻断提示**必须配一个动作**。会话卡在 interrupted 时，旧界面只表现为
            "发消息没反应"，人在界面上找不到任何出口 —— 而这道闸门本身是对的
            （上次工具调用的结果未知，不许猜），错的只是它没有门。
          */}
          {interruptedTool === null ? null : (
            <div className="blocked">
              <div>
                会话已暂停：上一次的工具调用（{interruptedTool}）结果未知，需要你确认才能继续。
              </div>
              <div className="blocked-actions">
                <button type="button" onClick={() => void acknowledge()}>
                  我知道了，继续
                </button>
              </div>
            </div>
          )}

          {/*
            **等批准的那一次调用。**

            和上面那张"结果未知"的卡片是一对：那个是"已经过去、需要人判断"，
            这个是"就在眼前、需要人点头"。两者都必须有出口 —— 没有出口时会话就停
            在那儿，而用户看不到任何解释（这一条以前只存在于协议里：投影一直带着
            `pendingApproval`，界面从没渲染过它）。

            参数用 `summarizeArgs` 摘要（和工具块同一个函数），因为人做决定时看的
            是"它要干什么"，不是一坨 JSON。
          */}
          {approval === null ? null : (
            <div className="blocked approval">
              <div>
                需要你决定：模型要调用 <code>{approval.tool}</code>
                {summarizeArgs(approval.argsJson) === '' ? null : (
                  <>
                    {' '}
                    —— <code>{summarizeArgs(approval.argsJson)}</code>
                  </>
                )}
              </div>
              {approval.message === '' ? null : <div className="set-hint">{approval.message}</div>}
              <div className="blocked-actions">
                <button type="button" className="danger" onClick={() => void approve(true)}>
                  允许
                </button>
                <button type="button" onClick={() => void approve(false)}>
                  拒绝
                </button>
              </div>
            </div>
          )}

          {error === null ? null : <div className="error">{error}</div>}
          {note === null ? null : <div className="note">{note}</div>}

          {ready ? null : <div className="note">正在连接…</div>}
        </div>
      </main>

      {/*
        `#bottom` 是**贴底的那一整块**：输入框 + 它下面的指标行。

        ⚠️ 指标行**在表单外面**（它是"读"的东西，不是输入的一部分），
        但它和输入框同属这一块 —— 于是：
          · 卡片被指标行**顶上去**（这正是重叠该有的处理方式）
          · `#log` 的底部留白按**整块**量（`--composer-h`），最后一条消息
            不会被这块的任何一部分盖住

        这也是为什么量高度的 ref 挂在这一层，而不是挂在表单上。
      */}
      <div id="bottom" ref={bottomRef}>
        <form
          id="composer"
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
        {/* 只在真的久无输出时出现；正常路径什么都不显示 */}
        {stalled ? (
          <div className="stall">
            已发出 {waitedSeconds} 秒，引擎还没有任何输出。
            {localEngine
              ? '本地引擎是单槽位 —— 可能有另一个会话正在生成、你这条在排队；也可能只是这一轮在长思考。'
              : '接口一直没有返回内容 —— 可能是网络或服务端慢。'}
          </div>
        ) : null}

        <div className="inner">
          <div className="row">
            <textarea
              id="input"
              ref={inputRef}
              rows={1}
              placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                grow()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          {/*
            一个按钮，两种身份：空闲时是"发送"（向上箭头），生成中是"停止"（方块）。

            为什么不用 `type="submit"`：那样在生成中按它也会走提交路径。这里两个
            动作都显式调用，表单的 onSubmit 仍然留给 Enter。

            图标用内联 SVG 而不是字符（`↑` `■`）：字符的字形与基线随字体变，
            居中会飘。
          */}
          <button
            className="send"
            type="button"
            aria-label={running ? '停止生成' : '发送'}
            title={running ? '停止生成' : '发送'}
            disabled={!running && (draft.trim() === '' || !ready)}
            onClick={() => {
              if (running) void stop()
              else submit()
            }}
          >
            {running ? (
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path
                  d="M12 19V5M6 11l6-6 6 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
          </div>

          {/*
            权限模式：**放在卡片内部底部**。
            它经常要改（"这次让它改文件"/"这次只许看"），放设置页就要点三次才能到位，
            而它又是有后果的设置 —— 所以摆在一个看得见、够得着的地方。

            改的是**这个会话**（`set_mode`），不是进程配置。
          */}
          <div className="mode-row">
            {/*
              这一行放**两个**会话级设置：权限模式与模型。都不加标签 ——
              下拉框的内容是自明的，而"权限"/"模型"这种前缀在窄屏上白白占位。
              说明走 tooltip。
            */}
            <Dropdown
              label={MODES.find((item) => item.value === mode)?.label ?? '（读取中…）'}
              title={MODES.find((item) => item.value === mode)?.hint ?? '选择这个会话的权限模式'}
              disabled={mode === ''}
              groups={[{ items: modeItems }]}
            />

            {/*
              模型：改的是**这个会话**（`select_model`） —— 和设置页那个「修改」
              （写 config.json、所有会话一起变）是两回事。按供应商分组，
              一次选择就能跨供应商换模型。
            */}
            <Dropdown
              label={currentModel === '' ? '（读取中…）' : currentModel}
              title={
                currentModel === ''
                  ? '这个会话要用的模型'
                  : `当前会话用的是 ${currentModel}${activeRoute === '' ? '' : `（${activeRoute}）`}`
              }
              disabled={modelGroups.length === 0}
              groups={modelGroups}
            />
          </div>
        </div>
        </form>

        {/*
          指标行：**在表单外面、输入框下方**。
          它和输入框同属 `#bottom` 那一块，所以卡片会被它顶上去，而不是被压住。
        */}
        <div className="metrics">
          <span title="这个会话已经用掉的上下文 / 模型窗口">
            上下文 {contextTokens.toLocaleString()} /{' '}
            {contextWindowTokens === 0 ? '—' : contextWindowTokens.toLocaleString()}
            {contextWindowTokens > 0
              ? `（${Math.round((contextTokens / contextWindowTokens) * 100)}%）`
              : ''}
          </span>
          <span className="sep">·</span>
          <span title="最近 5 秒的平均（滑动窗口），所以它会随快慢涨落。拿到引擎的数之后改显 token/秒（llama.cpp 的 timings）">
            {lastUsage?.tokensPerSecond === undefined
              ? `速度 ${charsPerSecond === null ? '—' : `~${charsPerSecond.toFixed(1)} 字/秒`}`
              : `速度 ${lastUsage.tokensPerSecond.toFixed(1)} token/秒`}
          </span>
          <span className="sep">·</span>
          <span
            title={
              lastUsage?.cachedTokens === undefined
                ? '端点没有给缓存命中数（usage.prompt_tokens_details.cached_tokens）—— 那是"不知道"，不是"没命中"'
                : `本次输入 ${lastUsage.inputTokens} 个 token，其中 ${lastUsage.cachedTokens} 个命中了引擎的提示缓存`
            }
          >
            缓存命中{' '}
            {lastUsage?.cachedTokens === undefined || lastUsage.inputTokens === 0
              ? '—'
              : `${Math.round((lastUsage.cachedTokens / lastUsage.inputTokens) * 100)}%`}
          </span>
          {/*
            累计用量（这个会话一共）。

            ⚠️ **三种状态必须分开**（这个界面反复踩的一条）：
              · 没有数据 → `—`（不是"用了 0 token"）
              · 有数据但端点不给缓存字段 → 缓存那格已经是 `—`
              · 有数据 → 真实数字

            **钱没显示** —— 那需要单价，而单价是用户的事：本机模型免费，
            硬编一份过期价目表只会给出假数字。
          */}
          <span className="sep">·</span>
          <span
            title={
              totalUsage === null
                ? '这个会话还没拿到过引擎的用量数据 —— 那是"不知道"，不是"用了 0"'
                : `累计 ${totalUsage.calls} 次调用：输入 ${totalUsage.inputTokens}、输出 ${totalUsage.outputTokens}`
            }
          >
            累计{' '}
            {totalUsage === null
              ? '—'
              : `${((totalUsage.inputTokens + totalUsage.outputTokens) / 1000).toFixed(1)}k tokens`}
          </span>
          {/*
            **会话日志坏了多少条事件。**

            只在非零时出现 —— 正常时它不存在，所以不占地方。
            出现时它是"失败出来了"的证据：以前这个数被计数然后扔掉，
            日志坏了没人知道（见 `#malformedEvents` 的注释）。
          */}
          {malformedEvents === 0 ? null : (
            <>
              <span className="sep">·</span>
              <span
                className="bad"
                title="会话日志里有事件无法解析，已跳过。会话仍可用，但那几条内容丢了 —— 这一行是证据，不是噪音"
              >
                日志异常 {malformedEvents} 条
              </span>
            </>
          )}
        </div>
      </div>
          </>
        )}
      </div>

      {/*
        抖动读数（`?debug` 才出现）。
        **必须 fixed 定位**：若它参与布局，读数自己一变就把页面推一下 ——
        那就等于用污染源去测污染。
      */}
      {DEBUG || settings.jitter ? (
        <div className="jitter">
          抖动 CLS {jitter.score.toFixed(4)} · 位移 {jitter.shifts} 次 · 回缩 {jitter.shrinks} 次
          {jitter.maxShrinkPx > 0 ? ` · 最大 ${jitter.maxShrinkPx}px` : ''}
          {jitter.sources.length > 0 ? ` · 来源 ${jitter.sources.slice(0, 3).join(', ')}` : ''}
        </div>
      ) : null}
    </>
  )
}
