/**
 * 配置层。
 *
 * 「API 一次配置，到处使用」——模型端点是**全局**的，不属于任何工作区或会话。
 * 这一层就是那条要求的落点。
 */

export {
  ConfigStore,
  defaultHomeDir,
  normalizeConfig,
  type LoadResult,
  type SaveResult,
} from './store.ts'
export { writeFileAtomic } from './atomic.ts'
export {
  PROFILES,
  maskResolved,
  modelIdentity,
  resolveConfig,
  type ApiKeySource,
  type ConfigOverrides,
  type Profile,
  type ResolvedConfig,
} from './resolve.ts'
export {
  API_KEY_MASK,
  CONFIG_VERSION,
  defaultConfig,
  isMaskedApiKey,
  maskApiKey,
} from './types.ts'
export type {
  AppConfig,
  ContextConfig,
  MaskedConfig,
  ModelConfig,
  PermissionsConfig,
  ServerConfig,
} from './types.ts'
