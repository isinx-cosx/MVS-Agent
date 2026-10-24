/**
 * 落盘数据的**版本迁移**。
 *
 * ## 为什么需要一个单独的文件
 *
 * 三个文件（`state.json` / `config.json` / `checkpoint.json`）本来都写了
 * `version` 字段，但谁也没有真正读它 —— 一个是写了不读，一个是读到了只记一条
 * 警告照常解析，第三个是版本不等就静默丢。三种语义、三种错法。
 *
 * 这里把「版本如何前进」这一件事收成一处，规则只有五条（见下）。
 *
 * ## 五条规则
 *
 *   1. 版本相同 → 原样返回，`applied` 为空
 *   2. 版本更旧 → 按 `from` 递增依次应用迁移；**缺对应迁移就报错**
 *   3. 版本更新 → 抛 `DataTooNewError`，调用方必须拒绝启动
 *   4. 没有 `version` → 当作 0
 *   5. 每一步之后校验版本确实前进了 1 —— 迁移函数把版本写错会当场炸
 *
 * ## 为什么「版本更新」必须拒绝，而不是尽力解析
 *
 * 旧代码不认识新字段，解析出来的对象再被整份写回，那些字段就**永久没了**。
 * 这不是"可能出错"，这是确定性的数据丢失。宁可起不来 —— 起不来用户会来问，
 * 数据丢了用户只会觉得"它把我东西吃了"。
 *
 * 所以也**不提供** `--allow-newer-state` 之类的强行打开：那等于允许旧代码写新数据，
 * 正是这一节要防的那件事。要降级就把 `version` 手工改回去 —— 一次有意识的动作。
 *
 * ## 迁移必须是纯函数
 *
 * `apply` 只拿数据、只回数据，不碰磁盘、不发请求。落盘由调用方按
 * 「备份 → 原子写」的顺序做（见 `docs/状态迁移与令牌默认.md`）。
 * 这样「迁移失败」和「写盘失败」是两件可以分开处理的事。
 */

/** 一条迁移：`from` → `from + 1` */
export interface Migration {
  from: number
  /** 一句话说明，会出现在给用户看的 warning 里 */
  describe: string
  apply: (data: unknown) => unknown
}

export interface MigrateInput {
  /** 哪种数据（只用于错误消息）：`state` / `config` / `checkpoint` */
  kind: string
  /** 当前代码支持的版本 */
  current: number
  /** 磁盘上读出来、已经 `JSON.parse` 过的对象 */
  raw: unknown
  /** 这个数据类型的迁移表。空数组 = 还没有任何历史版本 */
  migrations: readonly Migration[]
}

export interface MigrateResult {
  data: unknown
  /** 迁移前的版本（缺失 = 0） */
  from: number
  /** 迁移后的版本（等于 `current`） */
  to: number
  /** 实际跑过的步骤说明。空数组 = 没迁移 */
  applied: string[]
}

/**
 * 数据比当前代码新。
 *
 * 单独一个类，是因为调用方要能把它和"文件坏了"分开处理：
 * 文件坏了可以备份后重置，而版本更新**必须拒绝启动**。
 */
export class DataTooNewError extends Error {
  readonly kind: string
  readonly found: number
  readonly current: number

  constructor(kind: string, found: number, current: number) {
    super(
      `${kind} 的版本是 ${found}，当前程序只支持到 ${current} —— ` +
        `这份数据是更新版本写的。请升级程序；要降级，请先把 ${kind} 里的 version 手工改回 ${current}。`,
    )
    this.name = 'DataTooNewError'
    this.kind = kind
    this.found = found
    this.current = current
  }
}

/** 读一个对象里的 `version`。不是数字就当 0（早期数据没有版本字段） */
export function readVersion(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 0
  const value = (raw as Record<string, unknown>)['version']
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

export function migrate(input: MigrateInput): MigrateResult {
  const { kind, current, migrations } = input
  const from = readVersion(input.raw)

  if (from === current) {
    return { data: input.raw, from, to: current, applied: [] }
  }

  if (from > current) {
    throw new DataTooNewError(kind, from, current)
  }

  if (input.raw === null || typeof input.raw !== 'object' || Array.isArray(input.raw)) {
    /*
     * 不是对象就没法迁移（也没有字段可迁）。返回默认值由调用方的正常化逻辑去补，
     * 但**要让它知道**：这里不抛错，因为「文件结构不对」和「版本不对」是两件事，
     * 前者通常已经被调用方当作"坏文件"处理了。
     */
    return { data: input.raw, from, to: from, applied: [] }
  }

  let data: unknown = input.raw
  let version = from
  const applied: string[] = []

  while (version < current) {
    const step = migrations.find((entry) => entry.from === version)
    if (step === undefined) {
      throw new Error(
        `${kind} 缺少 v${version} → v${version + 1} 的迁移：` +
          `磁盘上是 v${from}，代码要 v${current}。补一条 migration 或者升级/降级程序。`,
      )
    }

    const next = step.apply(data)
    const nextVersion = readVersion(next)

    /*
     * 迁移函数必须自己把 `version` 推进到 `from + 1`。
     *
     * 不校验的话，一个忘记写版本的迁移会让循环**永远停在原版本**（死循环），
     * 或者把版本推到错的位置（后续步骤全错）。这里当场炸，附带是哪一条。
     */
    if (nextVersion !== version + 1) {
      throw new Error(
        `${kind} 的迁移「${step.describe}」（v${version} → v${version + 1}）` +
          `没有把 version 推进到 ${version + 1}，实际是 ${nextVersion}`,
      )
    }

    data = next
    version = nextVersion
    applied.push(step.describe)
  }

  return { data, from, to: version, applied }
}

/**
 * 把"迁移"与"落到磁盘"串起来的顺序说明（给调用方看的，不做实际 I/O）：
 *
 *   1. `migrate(...)` —— 纯内存
 *   2. 有 `applied` 时先备份原文件（名字带**源版本**，例如 `state.json.v1.backup`）
 *   3. 原子写新文件
 *   4. 任何一步抛错 → 原文件不动 + 报错 + 拒绝启动
 *
 * 备份名带源版本而不是时间戳：用户一眼能看出"这是从 v1 来的"。
 */
export const MIGRATION_ORDER = 'migrate → backup(sourceVersion) → atomicWrite'
