/**
 * 插件层。
 *
 * 结构：
 *   `types.ts`        清单类型、硬上限、对外工具名规则
 *   `manifest.ts`     清单解析与校验（结构 / 命名 / 体积 / 执行）
 *   `discover.ts`     扫 `<MVS_HOME>/plugins`（**只**扫这一个目录）
 *   `exec.ts`         跑一条命令：临时文件 stdio、超时杀整树、输出截断
 *   `fingerprint.ts`  轻量指纹（核对「声明 read 却写了东西」）
 *   `library.ts`      工作区级的启用状态 + 把声明变成工具
 */

export {
  PLUGIN_DESCRIPTION_MAX,
  PLUGIN_NAME_MAX,
  PLUGIN_OUTPUT_MAX_CHARS,
  PLUGIN_PARAMS_MAX_CHARS,
  PLUGIN_PARAMS_MAX_PROPS,
  PLUGIN_PREFIX,
  PLUGIN_TIMEOUT_DEFAULT_MS,
  PLUGIN_TIMEOUT_MAX_MS,
  PLUGIN_TOOL_FULL_NAME_MAX,
  PLUGIN_TOOL_NAME_MAX,
  PLUGIN_TOOLS_MAX,
  PLUGIN_TOOLS_PER_WORKSPACE_MAX,
  isPluginRisk,
  pluginOfTool,
  pluginToolName,
  type PluginManifest,
  type PluginNote,
  type PluginProblem,
  type PluginRecord,
  type PluginRisk,
  type PluginStatus,
  type PluginSummaryShape,
  type PluginToolRun,
  type PluginToolSpec,
  type PluginView,
} from './types.ts'
export { parseManifest, type ManifestResult } from './manifest.ts'
export { discoverPlugins, pluginsDir, type DiscoveredPlugin } from './discover.ts'
export { execCaptured, type ExecRequest, type ExecResult } from './exec.ts'
export {
  diffFingerprints,
  fingerprintWorkspace,
  type WorkspaceFingerprint,
} from './fingerprint.ts'
export { PluginLibrary, type PluginToolEnvironment } from './library.ts'
