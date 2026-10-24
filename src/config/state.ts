/**
 * 索引状态（`state.json`）—— **程序写的那个文件。**
 *
 * 和 `config.json` 分开存是硬要求：daemon 每建一个会话就要重写状态文件，
 * 而那次写入会覆盖掉用户刚编辑的模型配置。**写入频率不同的东西不该放一个文件里。**
 */

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './atomic.ts'
import { migrate, type Migration } from './migrate.ts'
import { defaultHomeDir } from './store.ts'

export interface WorkspaceRecord {
  /** 规范化（realpath）后的绝对路径。**它才是身份** */
  path: string
  addedAt: string
  lastOpenedAt: string
}

export interface SessionRecord {
  sessionId: string
  workspace: string
  title: string
  createdAt: string
  updatedAt: string
  /**
   * **这个会话选中的模型** —— DSH 的 `modelSelection` 语义（会话级、持久的）。
   *
   * ⚠️ 必须**落盘**。它以前只活在内存里（`Runtime.#sessionSelections`） ——
   * 守护进程一重启就没了，于是"切了模型、切走再回来又变回 MVS Agent"。
   * DSH 那边这个选择是**会话的 durable 属性**（由 `model/selection` 事件推导），
   * 放在会话记录里是对的。
   */
  model?: { provider?: string; model: string }
}

/**
 * 审计记录。
 *
 * ⚠️ **这不是安全日志。** 它的用途是让「打开一个新工作区」这件事**可见**——
 * 多工作区把「只能碰一个目录」变成了「能碰列表里的任何目录」，
 * 我们没法靠关掉这个能力来提升安全性（用户本来就跑着这个 daemon），
 * 只能让每次扩大范围都留下痕迹。
 */
export interface AuditRecord {
  at: string
  action: string
  detail: string
}

export interface AppState {
  version: number
  workspaces: WorkspaceRecord[]
  sessions: SessionRecord[]
  audit: AuditRecord[]
}

export const STATE_VERSION = 1

/**
 * `state.json` 的迁移表。
 *
 * **现在是空的** —— v1 就是当前版本，还没有"上一版"要升上来。
 * 留这个常量是为了让"改一个字段语义"有一个明确的落点：
 * 加一条 `{ from: 1, describe, apply }`，把 `STATE_VERSION` 提到 2 就够了，
 * 不需要再设计一遍机制。测试里用注入式 registry 证明这条链路是活的。
 */
export const STATE_MIGRATIONS: readonly Migration[] = []

/** 审计上限。超了就丢最老的 —— 它是可见性工具，不是合规留存 */
export const AUDIT_LIMIT = 500

export function defaultState(): AppState {
  return { version: STATE_VERSION, workspaces: [], sessions: [], audit: [] }
}

export interface StateLoadResult {
  state: AppState
  warnings: string[]
  created: boolean
}

export class StateStore {
  #dir: string
  #configured = false

  constructor(dir: string = defaultHomeDir()) {
    this.#dir = path.resolve(dir)
  }

  get dir(): string {
    return this.#dir
  }

  get path(): string {
    return path.join(this.#dir, 'state.json')
  }

  async load(): Promise<StateLoadResult> {
    const warnings: string[] = []
    await mkdir(this.#dir, { recursive: true })

    if (!existsSync(this.path)) {
      const state = defaultState()
      await this.#write(state)
      return { state, warnings, created: true }
    }

    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (err) {
      warnings.push(`读不到状态文件：${messageOf(err)}，已退回空索引`)
      return { state: defaultState(), warnings, created: false }
    }

    try {
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as unknown
      /*
       * 迁移在**内存里**做完，成功才落盘。
       *
       * 顺序是硬要求：`migrate` → 备份（名字带源版本）→ 原子写。
       * 迁移失败或写盘失败时，原文件一个字节都不动 —— 那是唯一能保证
       * 「不会带着半迁移的数据跑」的做法。
       */
      const migrated = migrate({
        kind: 'state',
        current: STATE_VERSION,
        raw: parsed,
        migrations: STATE_MIGRATIONS,
      })

      if (migrated.applied.length > 0) {
        const backup = `${this.path}.v${migrated.from}.backup`
        await copyFile(this.path, backup)
        await writeFileAtomic(
          this.path,
          `${JSON.stringify({ ...(migrated.data as object), version: STATE_VERSION }, null, 2)}\n`,
        )
        warnings.push(
          `状态文件从 v${migrated.from} 迁移到 v${STATE_VERSION}（${migrated.applied.join('；')}），` +
            `迁移前的副本在 ${path.basename(backup)}`,
        )
      }

      return { state: normalizeState(migrated.data), warnings, created: false }
    } catch (err) {
      /*
       * ⚠️ **版本比程序新**时不能"重置了事"。
       *
       * 重置会连同工作区与会话索引一起丢掉，而那份文件是更新版本写的 ——
       * 用户回滚程序之后就再也拿不回列表了。这种情况必须让启动失败，
       * 而不是默默降级成空索引（那是数据丢失）。
       */
      if (err instanceof Error && err.name === 'DataTooNewError') {
        throw new Error(`state.json 无法使用：${err.message}`)
      }

      // 索引坏了不影响功能，只影响「上次开了哪些工作区」。
      // 备份原文再退回空索引 —— 不去猜它能不能救回来，但也不直接销毁。
      const backup = `${this.path}.broken-${Date.now()}`
      try {
        await rename(this.path, backup)
        warnings.push(
          `状态文件无法解析（${messageOf(err)}），已备份为 ${path.basename(backup)}，索引已重置。` +
            `工作区列表需要重新添加，但**会话数据完好无损**。`,
        )
      } catch {
        warnings.push(`状态文件无法解析（${messageOf(err)}），索引已重置`)
      }
      return { state: defaultState(), warnings, created: false }
    }
  }

  async save(state: AppState): Promise<void> {
    await this.#write(state)
  }

  /** 读-改-写。索引很小，整份重写比维护增量简单得多 */
  async update(mutate: (state: AppState) => void): Promise<AppState> {
    const { state } = await this.load()
    mutate(state)
    state.audit = state.audit.slice(-AUDIT_LIMIT)
    await this.#write(state)
    return state
  }

  async #write(state: AppState): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`)
    this.#configured = true
  }

  get written(): boolean {
    return this.#configured
  }
}

/** 只挑能认的字段，坏条目逐条丢弃 —— 一条坏记录不该让整个索引失效 */
export function normalizeState(input: unknown): AppState {
  const state = defaultState()
  if (!isRecord(input)) return state

  if (Array.isArray(input.workspaces)) {
    for (const item of input.workspaces) {
      if (!isRecord(item) || typeof item.path !== 'string' || item.path === '') continue
      state.workspaces.push({
        path: item.path,
        addedAt: typeof item.addedAt === 'string' ? item.addedAt : new Date().toISOString(),
        lastOpenedAt:
          typeof item.lastOpenedAt === 'string' ? item.lastOpenedAt : new Date().toISOString(),
      })
    }
  }

  if (Array.isArray(input.sessions)) {
    for (const item of input.sessions) {
      if (!isRecord(item)) continue
      if (typeof item.sessionId !== 'string' || typeof item.workspace !== 'string') continue
      state.sessions.push({
        sessionId: item.sessionId,
        workspace: item.workspace,
        title: typeof item.title === 'string' ? item.title : '未命名会话',
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date().toISOString(),
        /*
         * ⚠️ **选中模型必须在这里被保留。**
         *
         * 这个函数是**重建**记录的地方 —— 少带一个字段，那个字段就会在
         * "保存一次状态"之后**凭空消失**（现象：切了模型、重启/切走回来
         * 又变回默认）。这类"读回来时少带了字段"的坑，这个文件里的注释
         * 已经记过一次（见 `projection()` 那段）。
         */
        ...(isRecord(item.model) && typeof item.model.model === 'string' && item.model.model !== ''
          ? {
              model: {
                ...(typeof item.model.provider === 'string' && item.model.provider !== ''
                  ? { provider: item.model.provider }
                  : {}),
                model: item.model.model,
              },
            }
          : {}),
      })
    }
  }

  if (Array.isArray(input.audit)) {
    for (const item of input.audit) {
      if (!isRecord(item)) continue
      if (typeof item.at !== 'string' || typeof item.action !== 'string') continue
      state.audit.push({
        at: item.at,
        action: item.action,
        detail: typeof item.detail === 'string' ? item.detail : '',
      })
    }
    state.audit = state.audit.slice(-AUDIT_LIMIT)
  }

  return state
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
