/**
 * 验证两件事，都是「接上去之后到底通不通」：
 *
 *   1. 本地模型起来了，而且**思考模式是开着的**
 *   2. Agent **能真的用工具** —— 发一句需要读文件的话，看它有没有发起工具调用
 *
 * ## 第 2 条为什么要单独测
 *
 * 守护进程里早就有工具注册表（`createDefaultRegistry()`），会话循环也把
 * `tools: schemas` 传给了模型。但「传了 schema」不等于「模型会调、调用会被执行」——
 * 中间还隔着：
 *
 *   · llama.cpp 的 chat template 认不认 `tools` 字段
 *   · 模型会不会按那个格式吐 tool_call
 *   · `openai-compatible.ts` 能不能把它解析回来
 *   · 权限层放不放行
 *
 * 任何一环断了，现象都是「模型只回文字、不干活」—— 而那不报错。
 *
 * 用法：node tools/check-agent-tools.mjs
 */

const BASE = 'http://127.0.0.1:3092'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const rpc = async (method, payload) => {
  const res = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rpcId: `probe-${Date.now()}`, method, payload }),
  })
  return await res.json()
}

console.log('  ── 1. 本地模型')
const local = await (await fetch(`${BASE}/local-model`)).json()
console.log(`     状态 ${local.state}  ${local.detail}`)

try {
  const props = await (await fetch('http://127.0.0.1:8080/props')).json()
  console.log(`     窗口 ${String(props.default_generation_settings?.n_ctx ?? '?')}`)
  console.log(`     模型 ${String(props.model_path ?? '').split(/[\\/]/).pop()}`)
  const chat = JSON.stringify(props.chat_template ?? '')
  console.log(`     chat template 提到 tools：${/tool/i.test(chat)}`)
} catch (err) {
  console.log(`    读不到 /props：${err.message}`)
}

console.log('')
console.log('  ── 2. 工具')
/*
 * 工具调用走的是**会话**，不是一次性 HTTP —— 所以这里起一个会话、发一句
 * 明确需要读文件的话，然后看事件里有没有 tool/call。
 *
 * ⚠️ 不直接打 `/api/session/prompt`：那个拦截在**页面里**，Node 这边打过去
 * 会落到守护进程的 404。所以走 `/command`，那是守护进程真正的入口。
 */
const state = await (await fetch(`${BASE}/state`)).json()
const workspace = state.state.workspaces[0]
if (workspace === undefined) {
  console.log('    没有工作区，测不了')
  process.exit(1)
}
console.log(`     工作区 ${workspace.path}`)

const created = await (await fetch(`${BASE}/command`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'create_session', workspace: workspace.path, title: '工具自检' }),
})).json()
const sessionId = created.sessionId ?? created.session?.sessionId
console.log(`     新会话 ${String(sessionId).slice(0, 8)}`)

await fetch(`${BASE}/command`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    type: 'user_message',
    sessionId,
    text: '请用工具读一下当前目录下的 package.json，然后只回答 "name" 字段的值。',
  }),
})

// 等它跑完：轮询会话状态
const deadline = Date.now() + 180_000
let final = null
for (;;) {
  const now = await (await fetch(`${BASE}/state`)).json()
  const session = now.state.sessions.find((s) => s.sessionId === sessionId)
  if (session?.status === 'idle' && session.turn > 0) {
    final = session
    break
  }
  if (Date.now() > deadline) {
    final = session
    console.log('     ⏱ 超时')
    break
  }
  await sleep(3000)
}

console.log(`     会话状态 ${final?.status ?? '?'}  turn ${final?.turn ?? '?'}  step ${final?.step ?? '?'}`)

// 事件里找工具调用
const page = await (await fetch(`${BASE}/projection?sessionId=${encodeURIComponent(sessionId)}`)).json()
const messages = page.projection?.messages ?? []
const kinds = new Set()
for (const m of messages) {
  if (typeof m.kind === 'string') kinds.add(m.kind)
  if (m.role === 'tool') kinds.add('tool-role')
  if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) kinds.add('toolCalls[]')
}
console.log(`     消息 ${messages.length} 条，种类：${[...kinds].join(', ') || '(无)'}`)

const usedTool = [...kinds].some((k) => /tool/i.test(k))
console.log('')
console.log(usedTool ? ' Agent 用上了工具' : ' 没看到工具调用 —— 模型只回了文字')
process.exitCode = usedTool ? 0 : 1
