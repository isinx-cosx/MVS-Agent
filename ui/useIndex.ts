/**
 * 工作区与对话列表 —— 读的是 `/state`。
 *
 * ## 现在只读，不发任何命令
 *
 * 这一步只搭界面，所以这里**只取数据**。daemon 那边动作都已经有了
 * （`open_workspace` / `close_workspace` / `create_session` / `rename_session` /
 * `delete_session`），接线时只要在按钮上补一次 `postCommand` —— 界面形状是按那些
 * 命令的字段搭的，不用返工。
 *
 * ## 为什么挂在 `running` 上重取
 *
 * 一轮结束之后列表才可能变（新会话出现、标题从"未命名"变成摘要、`updatedAt` 更新）。
 * 用轮询会把"只在需要时刷新"变成"一直在刷"，而这里挂一个很少变化的键就够。
 */

import { useCallback, useEffect, useState } from 'react'
import {
  getPicker,
  getState,
  type ConfigSummary,
  type PickerCapability,
  type PluginSummary,
  type SessionSummary,
  type SkillSummary,
  type WorkspaceSummary,
} from './client.ts'

export interface IndexState {
  workspaces: WorkspaceSummary[]
  sessions: SessionSummary[]
  /** 只读展示用（设置页的"信息与诊断"那一段） */
  config: ConfigSummary | null
  contextWindow: { tokens: number; source: string } | null
  /** 路径选择后端：native（系统框）还是 browse（页面内浏览） */
  picker: PickerCapability | null
  /**
   * 技能（所有工作区拍平）。
   *
   * 放在索引里而不是单独取一次：它和「有哪些工作区」是同一个时机变化的东西，
   * 而且设置页本来就跟着索引一起刷新。
   */
  skills: SkillSummary[]
  /** 插件（安装全局、启用按工作区，所以带 workspace） */
  plugins: PluginSummary[]
  error: string | null
}

export function useIndex(refreshKey: unknown): IndexState & { refresh: () => void } {
  const [state, setState] = useState<IndexState>({
    workspaces: [],
    sessions: [],
    config: null,
    contextWindow: null,
    picker: null,
    skills: [],
    plugins: [],
    error: null,
  })

  const refresh = useCallback((): void => {
    /*
     * 两次请求一起发。选择器的能力是启动时算定的（见 `picker.ts`），
     * 所以拿一次就够 —— 但它和状态列表的刷新时机相同，顺手一起取最省事。
     */
    void Promise.all([getState(), getPicker().catch(() => null)])
      .then(([res, picker]) => {
        setState({
          workspaces: res.state.workspaces ?? [],
          sessions: res.state.sessions ?? [],
          config: res.state.config ?? null,
          contextWindow: res.state.window ?? null,
          picker,
          skills: res.state.skills ?? [],
          plugins: res.state.plugins ?? [],
          error: null,
        })
      })
      .catch((err: unknown) => {
        /* 列表取不到不该让整个界面崩：保留上一次的内容，把原因显示出来 */
        setState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
        }))
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh, refreshKey])

  return { ...state, refresh }
}

/** 相对时间。列表里只需要"多久以前"，不需要精确到秒 */
export function shortTime(iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const diff = Date.now() - at
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  const date = new Date(at)
  return `${date.getMonth() + 1}-${date.getDate()}`
}
