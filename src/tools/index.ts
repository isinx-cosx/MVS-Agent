/**
 * 工具层的组装点。
 *
 * 被 `src/host/runtime.ts` 引用，由它交给每个会话 —— **模型确实能拿到工具**，
 * 工具循环在 `src/host/session.ts` 里跑（策略判定 → 需要时挂起等审批 →
 * 写 intent → 执行 → 结算）。
 *
 * ⚠️ 唯一**没有**引用它的是 `src/cli/chat.ts`（裸对话 REPL），那是刻意的：
 * 那个入口只连模型，用来单独跑、单独测模型层。这条由 `test/tools.test.ts`
 * 的「结构守卫」钉住。
 */

import { runCommandTool } from './command-tool.ts'
import { editTools } from './edit-tool.ts'
import { fileTools } from './file-tools.ts'
import { jobOutputTool, killJobTool, listJobsTool } from './job-tools.ts'
import { ToolRegistry } from './registry.ts'
import { searchTools } from './search-tools.ts'
import { webTools } from './web-tools.ts'

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry().registerAll([
    ...fileTools(),
    /*
     * 搜索和精确编辑 —— 这两个是「能不能在代码库里干活」的分界线。
     *
     * 原来的集合能读、写、建、删、跑命令，但**找不到东西**：没有搜索的 agent
     * 只能去 `run_command` 里跑 findstr / rg，而那要求命令行在、语法对、
     * 输出可读、路径转义对 —— 任一条不成立它就卡住，而且**不会说「我不会搜」**，
     * 它会编一个像答案的东西。
     */
    ...searchTools(),
    ...editTools(),
    /*
     * 网络工具。
     *
     * `web_fetch` **不需要任何配置**就能用 —— 而「把那篇文档拉下来」对一个
     * 写代码的 agent 来说，比「搜一下」更常用：报错里给的链接、README 指向的
     * spec、issue 里引的 RFC，都是**已经知道 URL** 的场景。
     *
     * `web_search` 需要配后端（`config.json` 的 `webSearch` 段）。没配时它
     * **明确报错**，不去刮某个搜索引擎的 HTML 凑答案 —— 刮 HTML 的接口随对方
     * 改版就碎，而碎的方式是"偶尔返回垃圾"，那种错误模型分辨不出来。
     */
    ...webTools(),
    runCommandTool,
    listJobsTool,
    jobOutputTool,
    killJobTool,
  ])
}

export { ToolRegistry } from './registry.ts'
export { JobRegistry } from './jobs.ts'
export { killTree } from './kill-tree.ts'
export { resolveInsideRoot, isInside } from './paths.ts'
export { validate } from './schema.ts'
export { readFileTool, writeFileTool, createFileTool, deleteFileTool, fileTools } from './file-tools.ts'
export { globTool, grepTool, searchTools } from './search-tools.ts'
export { editTool, editTools } from './edit-tool.ts'
export { runCommandTool } from './command-tool.ts'
export { listJobsTool, jobOutputTool, killJobTool } from './job-tools.ts'
export type { JobRecord, JobRegistryLike, StartJobOptions } from './types.ts'
export {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TIMEOUT_MS,
  failResult,
  okResult,
} from './types.ts'
export type {
  AnyTool,
  RiskLevel,
  Tool,
  ToolContext,
  ToolError,
  ToolErrorKind,
  ToolResult,
} from './types.ts'
