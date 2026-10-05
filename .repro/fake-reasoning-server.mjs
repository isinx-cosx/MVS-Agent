/*
 * 假端点（比 scripts/fake-server.ts 多一样东西）：**先吐思考、再吐正文**。
 *
 * 为什么要单独造一个：`scripts/fake-server.ts` 从不发 `reasoning_content`，
 * 于是「思考 → 正文换块」这条路一次都没被验过 —— 而垫片里最容易写错的就是它
 * （块类型一旦不跟着增量走，正文会被追加进思考那个块里）。
 *
 * 用法：
 *   node .repro/fake-reasoning-server.mjs          # :8788
 */

import http from 'node:http'

const port = Number(process.env.FAKE_PORT ?? 8788)
const REASONING = '先看看题目再回答。'
const CONTENT = '答案是四十二。'

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`

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
    const parsed = JSON.parse(raw || '{}')
    const model = parsed.model ?? 'reason-fake'

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const send = (delta, finishReason = null) =>
      res.write(
        sse({
          id: 'chatcmpl-reason',
          object: 'chat.completion.chunk',
          created: 1730000000,
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        }),
      )

    send({ role: 'assistant', content: '' })

    /* 思考：逐字，带 reasoning_content —— 模型层那条 `reasoning_delta` 的来源 */
    const plan = [
      ...REASONING.split('').map((ch, i) => ({ at: i * 25, delta: { reasoning_content: ch } })),
      ...CONTENT.split('').map((ch, i) => ({
        at: REASONING.length * 25 + i * 25,
        delta: { content: ch },
      })),
    ]

    let timer = null
    const step = (index) => {
      if (index >= plan.length) {
        send({}, 'stop')
        res.write(
          sse({
            id: 'chatcmpl-reason',
            object: 'chat.completion.chunk',
            created: 1730000000,
            model,
            choices: [],
            usage: { prompt_tokens: 8, completion_tokens: plan.length, total_tokens: 8 + plan.length },
          }),
        )
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      send(plan[index].delta)
      timer = setTimeout(() => step(index + 1), 25)
    }
    step(0)

    res.on('close', () => {
      if (timer !== null) clearTimeout(timer)
    })
  })
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`假端点（带思考）已启动：http://127.0.0.1:${port}/v1\n`)
})
