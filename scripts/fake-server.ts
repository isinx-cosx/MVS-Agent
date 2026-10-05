/**
 * 本地假端点：一个最小的 OpenAI 兼容 /chat/completions 服务。
 *
 * 用途：在 Ollama 没起、DeepSeek 没 key、或者不想花钱的时候，
 * 依然能跑通真实的网络路径（真实 fetch、真实 TCP、真实 SSE 分帧）。
 *
 * 场景（按用户消息内容触发）：
 *   包含「断开」  → 吐两个字后粗暴掐断连接，用来验证 error/network 路径
 *   包含「慢」    → 每字间隔拉长，方便观察流式与测试 Ctrl+C 取消
 *   其它          → 正常慢速逐字流式返回，带 usage 与 [DONE]
 *
 * 用法：
 *   node scripts/fake-server.ts
 *   node src/cli/chat.ts --base-url http://127.0.0.1:8787/v1 --model fake "你好"
 */

import http from 'node:http'
import process from 'node:process'

const port = Number(process.env.FAKE_PORT ?? 8787)

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`

const server = http.createServer((req, res) => {
  if (!req.url?.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"only /chat/completions is implemented"}')
    return
  }

  let raw = ''
  req.on('data', (piece) => {
    raw += piece
  })

  req.on('end', () => {
    const parsed = JSON.parse(raw || '{}') as {
      model?: string
      messages?: Array<{ role: string; content: string }>
    }

    const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => m.role === 'user')
    const prompt = String(lastUser?.content ?? '')
    // 已经回填过工具结果 → 说明工具循环跑到第二轮了，这一轮该给最终答复
    const hasToolResult = (parsed.messages ?? []).some((m) => m.role === 'tool')
    const model = parsed.model ?? 'fake'
    const id = 'chatcmpl-fake'

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const send = (delta: unknown, finishReason: string | null = null): void => {
      res.write(
        sse({
          id,
          object: 'chat.completion.chunk',
          created: 1730000000,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        }),
      )
    }

    // 场景：中途掐断
    if (prompt.includes('断开')) {
      send({ content: '这段会' })
      setTimeout(() => res.destroy(), 40)
      return
    }

    // 场景：请求一次工具调用（用来端到端验证工具循环）。
    // 参数**刻意切成碎片**下发，顺带压测按 index 累积那段逻辑。
    if (prompt.includes('写文件') && !hasToolResult) {
      const args = JSON.stringify({ path: 'agent-note.txt', content: '这是 agent 写的' })
      const pieces = [args.slice(0, 8), args.slice(8, 20), args.slice(20)]

      send({ role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: 'write_file', arguments: '' } }] })
      let i = 0
      const toolTimer = setInterval(() => {
        if (i >= pieces.length) {
          clearInterval(toolTimer)
          send({}, 'tool_calls')
          res.write('data: [DONE]\n\n')
          res.end()
          return
        }
        send({ tool_calls: [{ index: 0, function: { arguments: pieces[i] } }] })
        i += 1
      }, 20)
      return
    }

    // 场景：正常流式（「慢」时拉长间隔，方便手动按 Ctrl+C）
    const interval = prompt.includes('慢') ? 400 : 25
    const reply = hasToolResult
      ? '文件已经写好了。'
      : `收到：「${prompt}」。我是本地假端点，不消耗任何额度。`

    let cursor = 0
    const timer = setInterval(() => {
      if (cursor >= reply.length) {
        clearInterval(timer)
        send({}, 'stop')
        res.write(
          sse({
            id,
            object: 'chat.completion.chunk',
            created: 1730000000,
            model,
            choices: [],
            usage: { prompt_tokens: 12, completion_tokens: reply.length, total_tokens: 12 + reply.length },
          }),
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      send({ content: reply[cursor] })
      cursor += 1
    }, interval)

    res.on('close', () => clearInterval(timer))
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`假端点已启动：http://127.0.0.1:${port}/v1\n`)
})
