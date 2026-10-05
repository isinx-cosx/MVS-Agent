/**
 * 最小 WebSocket 服务端（RFC 6455）。
 *
 * 为什么自己写：**守护进程刻意保持零运行时依赖**，而 Node 没有内置 WS 服务端。
 *
 * ⚠️ 这和「npm 装不装得上」无关 —— npm 在开发机上是通的，是**不想要**：
 * 一个要执行命令、要碰用户文件的进程，发货时不带 `node_modules` 是真实的安全收益
 * （没有传递依赖、没有 postinstall 脚本、没有供应链更新面）。
 * 而 Node 没有内置 WS 服务端。我们只需要文本帧、关闭、ping/pong——
 * 不需要二进制、不需要扩展协商、不需要压缩。
 *
 * 两处规范要求不能省：
 * - **客户端发来的帧必须带掩码**，没带就是协议错误（第 5.1 节）。
 * - **服务端发出去的帧必须不带掩码**（否则浏览器会直接断开）。
 */

import { createHash } from 'node:crypto'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 单帧上限。本地 UI 用不到更大，但它是一道防止内存被打爆的闸 */
const MAX_PAYLOAD = 4 * 1024 * 1024

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

export function webSocketAccept(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

export interface WebSocketHandlers {
  onMessage: (text: string) => void
  onClose: () => void
}

interface Frame {
  fin: boolean
  opcode: number
  payload: Buffer
}

export class WebSocketConnection {
  #socket: Duplex
  #handlers: WebSocketHandlers
  #buffer: Buffer = Buffer.alloc(0)
  #fragment: Buffer | null = null
  #closed = false

  constructor(socket: Duplex, handlers: WebSocketHandlers) {
    this.#socket = socket
    this.#handlers = handlers
    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#drain()
    })
    socket.on('close', () => this.#finish())
    socket.on('error', () => this.#finish())
  }

  get closed(): boolean {
    return this.#closed
  }

  send(text: string): void {
    if (this.#closed) return
    try {
      this.#socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')))
    } catch {
      this.#finish()
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.#closed) return
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2, 'utf8')
    try {
      this.#socket.write(encodeFrame(OP_CLOSE, payload))
    } catch {
      // 已经断了
    }
    this.#socket.end()
    this.#finish()
  }

  #finish(): void {
    if (this.#closed) return
    this.#closed = true
    this.#handlers.onClose()
  }

  #drain(): void {
    for (;;) {
      const frame = this.#parseFrame()
      if (frame === null) return
      if (!this.#handleFrame(frame)) return
    }
  }

  #parseFrame(): Frame | null {
    const buf = this.#buffer
    if (buf.length < 2) return null

    const first = buf[0] as number
    const second = buf[1] as number
    const fin = (first & 0x80) !== 0
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2

    if (length === 126) {
      if (buf.length < offset + 2) return null
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return null
      const big = buf.readBigUInt64BE(offset)
      offset += 8
      if (big > BigInt(MAX_PAYLOAD)) {
        this.close(1009, 'payload too large')
        return null
      }
      length = Number(big)
    }

    if (length > MAX_PAYLOAD) {
      this.close(1009, 'payload too large')
      return null
    }

    // 规范：客户端 → 服务端的帧必须带掩码
    if (!masked) {
      this.close(1002, 'client frames must be masked')
      return null
    }

    if (buf.length < offset + 4) return null
    const maskKey = buf.subarray(offset, offset + 4)
    offset += 4

    if (buf.length < offset + length) return null

    const payload = Buffer.from(buf.subarray(offset, offset + length))
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = (payload[i] as number) ^ (maskKey[i % 4] as number)
    }

    this.#buffer = buf.subarray(offset + length)
    return { fin, opcode, payload }
  }

  /** 返回 false 表示连接已结束，停止继续解析 */
  #handleFrame(frame: Frame): boolean {
    switch (frame.opcode) {
      case OP_TEXT:
      case OP_CONTINUATION: {
        // 两条规范要求，都不是可选的：
        //  - 续帧之前必须先有文本帧的开头。孤立的续帧是协议错误（1002），
        //    而**不是**一条新消息的开头 —— 当成新消息会把两条消息的内容拼在一起，
        //    解析出来的 JSON 要么报错、要么是另一个意思。
        //  - 一条消息没拼完之前不能再开新的文本帧。
        if (frame.opcode === OP_CONTINUATION && this.#fragment === null) {
          this.close(1002, 'unexpected continuation frame')
          return false
        }
        if (frame.opcode === OP_TEXT && this.#fragment !== null) {
          this.close(1002, 'unexpected data frame')
          return false
        }
        this.#fragment =
          this.#fragment === null
            ? Buffer.from(frame.payload)
            : Buffer.concat([this.#fragment, frame.payload])

        if (this.#fragment.length > MAX_PAYLOAD) {
          this.close(1009, 'message too large')
          return false
        }
        if (frame.fin) {
          const text = this.#fragment.toString('utf8')
          this.#fragment = null
          this.#handlers.onMessage(text)
        }
        return true
      }

      case OP_PING:
        try {
          this.#socket.write(encodeFrame(OP_PONG, frame.payload))
        } catch {
          this.#finish()
          return false
        }
        return true

      case OP_PONG:
        return true

      case OP_CLOSE:
        this.close(1000)
        return false

      default:
        this.close(1003, 'unsupported opcode')
        return false
    }
  }
}

/** 服务端发出的帧**不带掩码** —— 带了浏览器会直接断开 */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length
  let header: Buffer

  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }

  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/** 校验 upgrade 请求头，返回 accept 值；不合法返回 null */
export function tryUpgrade(req: IncomingMessage): string | null {
  const upgrade = req.headers.upgrade
  const key = req.headers['sec-websocket-key']
  const version = req.headers['sec-websocket-version']

  if (typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') return null
  if (typeof key !== 'string' || key === '') return null
  if (version !== '13') return null
  return webSocketAccept(key)
}
