/**
 * host 侧的组装点。
 *
 * 这是「运行时」那一半：配置、工作区、会话、事件、检查点、agent 循环。客户端不在这里。
 *
 * ⚠️ 边界纪律（取自 DSH 的 host/client 划分）：**客户端不持有任何权限。**
 * 它只渲染索引与投影、回答提示。所有判定都在这一侧。
 */

import { Runtime, canonicalize, defaultSessionDir, deriveTitle } from './runtime.ts'
import { Session, type SessionDeps } from './session.ts'
import { SessionStore } from './persistence.ts'

export function createSession(deps: SessionDeps): Session {
  return new Session(deps)
}

export { Session, SessionStore }
export { Runtime, canonicalize, defaultSessionDir, deriveTitle }
export { HostServer } from './server.ts'
export { WebSocketConnection, tryUpgrade, webSocketAccept } from './websocket.ts'
export { devClientHtml } from './dev-client.ts'
export { pickDirectory } from './directory-picker.ts'
export { writeFileAtomic } from '../config/atomic.ts'

export type { SessionDeps, ModelProvider, InitResult, ToolExecutor } from './session.ts'
export type { ReadResult } from './persistence.ts'
export type { HostServerOptions, HostServerInfo } from './server.ts'
export type { RuntimeOptions } from './runtime.ts'
export type { PickResult } from './directory-picker.ts'
