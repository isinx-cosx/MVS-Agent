/**
 * SSE 分帧。
 *
 * 这里最容易踩的坑：**一个 TCP chunk 不等于一个 SSE 事件。**
 * `data: {...}` 可能被切成两半跨 chunk，一个 chunk 里也可能塞了三个事件。
 * 所以必须自己维护缓冲区、跨 chunk 保住余量。
 *
 * 直接对每个 chunk 做 JSON.parse 是最常见的崩法。
 */

export interface SSEEvent {
  event: string
  data: string
}

/**
 * 行尾归一化。
 *
 * SSE 规范允许 \n、\r\n、\r 三种行分隔符。要处理「\r 在 chunk 末尾、
 * \n 在下一个 chunk 开头」这种被切断的 CRLF，所以末尾孤立的 \r 保留不动，
 * 等下一个 chunk 拼上再说。
 */
function normalizeNewlines(buffer: string): string {
  const crlfNormalized = buffer.replace(/\r\n/g, '\n')
  if (crlfNormalized.endsWith('\r')) {
    return crlfNormalized.slice(0, -1).replace(/\r/g, '\n') + '\r'
  }
  return crlfNormalized.replace(/\r/g, '\n')
}

/** 解析一个事件块（已被空行分隔），返回 null 表示块里没有任何有效字段 */
function parseBlock(block: string): SSEEvent | null {
  let event = ''
  const dataLines: string[] = []

  for (const line of block.split('\n')) {
    if (line === '') continue
    // 以冒号开头的是注释（常用于心跳保活）
    if (line.startsWith(':')) continue

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // 规范：冒号后最多去掉一个空格
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }

  if (dataLines.length === 0 && event === '') return null
  // 多行 data 按规范用 \n 连接
  return { event, data: dataLines.join('\n') }
}

/**
 * 把字节流切成 SSE 事件流。
 *
 * 不接收 AbortSignal：底层 body 被 abort 时会自己抛错，由调用方捕获，
 * 这里不该重复造一套取消逻辑。
 */
export async function* parseSSE(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    buffer = normalizeNewlines(buffer)

    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const event = parseBlock(block)
      if (event !== null) yield event
      boundary = buffer.indexOf('\n\n')
    }
  }

  // flush 解码器里可能残留的多字节字符
  buffer += decoder.decode()
  buffer = normalizeNewlines(buffer)

  // 末尾没有空行收尾时，最后一个事件仍要发出去
  const tail = parseBlock(buffer)
  if (tail !== null) yield tail
}
