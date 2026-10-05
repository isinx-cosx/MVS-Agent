/**
 * 设置页。
 *
 * ## 只有三类东西能进来
 *
 * 1. **界面**：只影响这台浏览器，写 localStorage，随时可改回来；
 * 2. **信息**：只读展示，不能改 —— 但"看不到"本身就是一个缺陷（比如引擎用的是
 *    哪个模型、上下文窗口是探测来的还是猜的、路径选择能不能用系统框）；
 * 3. **有后果的动作**：目前只有"清理空会话"一个，要求**两次点击**确认。
 *
 * ## 每条设置都要写清代价
 *
 * 这个项目吃亏最多的不是"没有开关"，而是**静默**：改了没反应、失败不报错、
 * 动作没生效。所以这里每个非显然的选项旁边都跟着一句后果说明 —— 尤其是图片
 * （它关系到隐私）和"跟到底部"（它关系到你会不会被一直带着滚）。
 *
 * ## 密钥
 *
 * 这里只显示掩码，而且**这一批全是只读**。等以后能编辑 daemon 配置时必须记住：
 * 掩码绝不能被写回（配置层有测试专门守这条）。
 */

import { useState } from 'react'
import type { ConfigSummary, PickerCapability } from './client.ts'
import type { FollowMode, ImagePolicy, Settings, ThemeChoice } from './settings.ts'
import { FONT_SIZE_RANGE } from './settings.ts'

interface SettingsProps {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
  /* ── 只读信息（都来自 `/state` 与 `/picker`，没有编的字段） ── */
  config: ConfigSummary | null
  contextWindow: { tokens: number; source: string } | null
  picker: PickerCapability | null
  sessionCount: number
  emptyCount: number
  sidebarWidth: number
  onResetSidebarWidth: () => void
  /** 抗疲劳熔断器的状态（单向门，必须有出口） */
  fatigue: { active: boolean; consecutiveBlocks: number; totalBlocks: number } | null
  onResetFatigue: () => void
  /* ── 模型：切换（会话级）与配置（全局） ── */
  /** 当前会话 id。`null` = 还没选会话，切换按钮就该是禁用的 */
  sessionId: string | null
  /** 把**当前会话**切到某个供应商的模型（`select_model`，不碰密钥） */
  onSwitchModel: (provider: string, model: string) => void
  /** 保存配置到 `~/.mvs-agent/config.json`（只有用户按了保存才会走到这里） */
  onSaveConfig: (patch: Record<string, unknown>) => void
  savingConfig: boolean
  configResult: string | null
  /* ── 有后果的动作 ── */
  onCleanEmpty: () => void
  cleaning: boolean
  cleanupNote: string | null
  onClose: () => void
}

/** 一行设置：左边说明，右边控件 */
function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="set-row">
      <div className="set-label">
        <div>{label}</div>
        {hint === undefined ? null : <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

/** 分段选择器（2~3 个互斥选项） */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
}) {
  return (
    <div className="seg">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'seg-item on' : 'seg-item'}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Toggle({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      className={value ? 'switch on' : 'switch'}
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
    >
      <span className="knob" />
    </button>
  )
}

/** 只读的一条信息 */
function Info({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <div>{label}</div>
        {hint === undefined ? null : <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-value" title={value}>
        {value}
      </div>
    </div>
  )
}

/**
 * 编辑**当前供应商**的配置。
 *
 * ## 字段语义（用户定的规则）
 *
 *   留空 = **不发这个字段** = 保持原值 —— 第一次配置时"原值"就是没有，
 *          所以同一条规则同时覆盖了"首次"和"后续"两种情况 ✓
 *   要清掉已经设过的值 → 点那一项右边的 `×`（显式动作，发 `null`）✓
 *
 * ## 密钥：只出不进
 *
 * 框里放的是**掩码**（`sk-…7dae`）当 placeholder ✓，用户不输入就不发这个字段 ✓。
 * 真密钥永远不会出现在页面上，也不可能被回写 ✓ —— 配置层有测试守这条。
 */
function ModelForm({
  config,
  route,
  busy,
  result,
  onSave,
}: {
  config: ConfigSummary | null
  /** **要改的那个供应商**（不是"当前用的那个"） */
  route: string
  busy: boolean
  result: string | null
  onSave: (patch: Record<string, unknown>) => void
}) {
  const view = config?.model
  const provider = route === '' ? undefined : config?.providers?.[route]

  /* 五个输入框的草稿。用受控 state，这样"×"清空和用户手输是同一条路 ✓ */
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [temperature, setTemperature] = useState('')
  const [maxTokens, setMaxTokens] = useState('')
  const [apiKey, setApiKey] = useState('')
  /** 被按过 × 的字段：保存时发 `null`（清掉），而不是省略 */
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set())
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())

  const mark = (key: string): void => setTouched((prev) => new Set(prev).add(key))

  const clearField = (key: string): void => {
    setCleared((prev) => new Set(prev).add(key))
    if (key === 'baseUrl') setBaseUrl('')
    if (key === 'model') setModel('')
    if (key === 'temperature') setTemperature('')
    if (key === 'maxTokens') setMaxTokens('')
    if (key === 'apiKey') setApiKey('')
    mark(key)
  }

  const submit = (): void => {
    const patch: Record<string, unknown> = {}
    const put = (key: string, raw: string): void => {
      if (cleared.has(key)) {
        patch[key] = null
        return
      }
      const value = raw.trim()
      /* ⚠️ 留空 = **不发** —— 不是"发空串"。空串在 apiKey 上是"清掉"的意思 ✗ */
      if (value === '') return
      patch[key] = value
    }
    put('baseUrl', baseUrl)
    put('model', model)
    put('temperature', temperature === '' ? '' : String(Number(temperature)))
    put('maxTokens', maxTokens === '' ? '' : String(Number(maxTokens)))
    /*
     * 密钥单独处理：**框里永远是空的**（掩码只在 placeholder 里），所以
     * "非空才发"这一条就够了 —— 用户没输入就一个字都不发 ✓。
     */
    if (apiKey.trim() !== '') patch['apiKey'] = apiKey.trim()

    /*
     * ⚠️ **用 `route` 定位，不要用 `activeProvider`。**
     *
     * 后者会顺手把"当前用的是谁"也切成它 ✗ —— 用户只是想改一个没在用的供应商的
     * 地址，结果正在用的模型被换掉了，而且界面上看不出来 ✓。两个职责分开了：
     * `route` 定位 ✓，`activeProvider` 切换 ✓（这里一个字都不提它 ✓）。
     */
    patch['route'] = route

    /* 数字字段要在**发出去之前**变成 number，否则服务端当字符串丢掉 */
    for (const key of ['temperature', 'maxTokens']) {
      const value = patch[key]
      if (typeof value === 'string') {
        const n = Number(value)
        if (Number.isFinite(n)) patch[key] = n
        else delete patch[key]
      }
    }
    onSave(patch)
  }

  const shown = (key: string, current: number | undefined): string =>
    touched.has(key) || cleared.has(key) ? '' : current === undefined ? '' : String(current)

  return (
    <div className="set-form">
      <label className="set-field">
        <span>接口地址</span>
        <input
          value={baseUrl}
          placeholder={provider?.baseUrl ?? view?.baseUrl ?? '（没设）'}
          onChange={(e) => {
            setBaseUrl(e.target.value)
            mark('baseUrl')
          }}
        />
        {(provider?.baseUrl ?? view?.baseUrl) === undefined ? null : (
          <button type="button" className="side-mini" title="清掉这个值" onClick={() => clearField('baseUrl')}>
            ×
          </button>
        )}
      </label>

      <label className="set-field">
        <span>模型名</span>
        <input
          value={model}
          placeholder={provider?.model ?? view?.model ?? '（没设）'}
          onChange={(e) => {
            setModel(e.target.value)
            mark('model')
          }}
        />
        {(provider?.model ?? view?.model) === undefined ? null : (
          <button type="button" className="side-mini" title="清掉这个值" onClick={() => clearField('model')}>
            ×
          </button>
        )}
      </label>

      <label className="set-field">
        <span>温度</span>
        <input
          value={temperature}
          inputMode="decimal"
          placeholder={view?.temperature === undefined ? '不设（由引擎决定）' : String(view.temperature)}
          onChange={(e) => {
            setTemperature(e.target.value)
            mark('temperature')
          }}
        />
        {view?.temperature === undefined ? null : (
          <button type="button" className="side-mini" title="清掉（回到由引擎决定）" onClick={() => clearField('temperature')}>
            ×
          </button>
        )}
      </label>

      <label className="set-field">
        <span>输出上限</span>
        <input
          value={maxTokens}
          inputMode="numeric"
          placeholder={view?.maxTokens === undefined ? '不设（无上限）' : String(view.maxTokens)}
          onChange={(e) => {
            setMaxTokens(e.target.value)
            mark('maxTokens')
          }}
        />
        {view?.maxTokens === undefined ? null : (
          <button type="button" className="side-mini" title="清掉（回到无上限）" onClick={() => clearField('maxTokens')}>
            ×
          </button>
        )}
      </label>

      <label className="set-field">
        <span>API 密钥</span>
        <input
          type="password"
          value={apiKey}
          placeholder={view?.apiKey === '' ? '（没设）' : (view?.apiKey ?? '（没设）')}
          onChange={(e) => setApiKey(e.target.value)}
        />
        {view?.apiKey === '' ? null : (
          <button type="button" className="side-mini danger" title="清掉已存的密钥" onClick={() => clearField('apiKey')}>
            ×
          </button>
        )}
      </label>

      <div className="set-form-foot">
        <button type="button" className="side-action" disabled={busy} onClick={submit}>
          {busy ? '保存中…' : '保存到配置文件'}
        </button>
        <span className="set-hint">
          留空 = 保持原值；<code>×</code> = 清掉那一项。改完要重启守护进程才生效（生成参数在会话构造时读一次）。
        </span>
      </div>
      {result === null ? null : <p className="set-hint">{result}</p>}
      {shown('temperature', view?.temperature) === '' ? null : null}
    </div>
  )
}

/**
 * 添加一个供应商。
 *
 * 走的是 `providers` 的**合并**语义 ✓（新键 = 新增，已有键 = 只更新提到的字段），
 * 所以不需要"先读再写"，也碰不到别的供应商 ✓。
 *
 * ⚠️ **标识名必须填、而且必须合法**：它就是配置里的键 ✓（展示名是另一个字段 `label`）。
 * 键会被 `activeProvider` 引用，写成奇怪的东西之后很难收拾 ✓。
 */
function AddProviderForm({
  existing,
  busy,
  result,
  onAdd,
}: {
  existing: string[]
  busy: boolean
  result: string | null
  onAdd: (route: string, fields: Record<string, unknown>) => void
}) {
  const [route, setRoute] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')

  const trimmed = route.trim()
  const duplicate = existing.includes(trimmed)
  const badChars = trimmed !== '' && !/^[A-Za-z0-9._-]+$/.test(trimmed)
  const invalid = trimmed === '' || duplicate || badChars

  return (
    <div className="set-form">
      <label className="set-field">
        <span>标识名</span>
        <input value={route} placeholder="deepseek" onChange={(e) => setRoute(e.target.value)} />
      </label>
      {duplicate ? (
        <p className="set-hint">已经有一个叫「{trimmed}」的供应商了 —— 想改它，用它卡片上的「修改」。</p>
      ) : badChars ? (
        <p className="set-hint">标识名只能用字母、数字、点、下划线和短横线 —— 它是配置文件里的键。</p>
      ) : null}

      <label className="set-field">
        <span>接口地址</span>
        <input value={baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setBaseUrl(e.target.value)} />
      </label>
      <label className="set-field">
        <span>模型名</span>
        <input value={model} placeholder="example-chat" onChange={(e) => setModel(e.target.value)} />
      </label>
      <label className="set-field">
        <span>API 密钥</span>
        <input type="password" value={apiKey} placeholder="（可留空）" onChange={(e) => setApiKey(e.target.value)} />
      </label>

      <div className="set-form-foot">
        <button
          type="button"
          className="side-action"
          disabled={busy || invalid}
          onClick={() => {
            const fields: Record<string, unknown> = {}
            if (baseUrl.trim() !== '') fields['baseUrl'] = baseUrl.trim()
            if (model.trim() !== '') fields['model'] = model.trim()
            if (apiKey.trim() !== '') fields['apiKey'] = apiKey.trim()
            onAdd(trimmed, fields)
          }}
        >
          {busy ? '写入中…' : '添加'}
        </button>
        <span className="set-hint">只写配置文件 —— 要用它还要在会话里切过去。</span>
      </div>
      {result === null ? null : <p className="set-hint">{result}</p>}
    </div>
  )
}

/** 设置页的分类。左边选一个，右边只显示它 */
const SECTIONS = [
  { id: 'ui', label: '界面', hint: '只影响这台浏览器' },
  { id: 'model', label: '模型', hint: '切换与上下文' },
  { id: 'data', label: '数据与诊断', hint: '目录、会话、环境' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function SettingsPage({
  settings,
  onChange,
  onReset,
  config,
  contextWindow,
  picker,
  sessionCount,
  emptyCount,
  sidebarWidth,
  onResetSidebarWidth,
  fatigue,
  onResetFatigue,
  sessionId,
  onSwitchModel,
  onSaveConfig,
  savingConfig,
  configResult,
  onCleanEmpty,
  cleaning,
  cleanupNote,
  onClose,
}: SettingsProps) {
  const [confirming, setConfirming] = useState(false)
  const [copied, setCopied] = useState(false)
  /** 当前显示哪一类。刻意不持久化：它是"我现在在看什么"，不是设置 */
  const [section, setSection] = useState<SectionId>('ui')
  /** 正在修改哪个供应商（卡片展开）；`null` = 都收着。同时只开一个 ✓ */
  const [editing, setEditing] = useState<string | null>(null)
  /** 是否展开"添加供应商" */
  const [adding, setAdding] = useState(false)

  const active = config?.activeProvider ?? ''
  const provider = active === '' ? undefined : config?.providers?.[active]
  const providers = Object.entries(config?.providers ?? {})
  const modelName = provider?.model ?? config?.model.model ?? '(未知)'
  const baseUrl = provider?.baseUrl ?? config?.model.baseUrl ?? '(未知)'

  const diagnostics = [
    `模型：${modelName} @ ${baseUrl}`,
    `提供商：${active === '' ? '(未知)' : active}${provider?.label === undefined ? '' : ` (${provider.label})`}`,
    `上下文窗口：${contextWindow === null ? '(未知)' : String(contextWindow.tokens)}`,
    contextWindow === null ? '' : `窗口来源：${contextWindow.source}`,
    `权限默认模式：${config?.permissions?.defaultMode ?? '(未知)'}`,
    `路径选择后端：${picker === null ? '(未知)' : `${picker.kind} —— ${picker.reason}`}`,
    `状态目录：${config?.paths?.home ?? '(未知)'}`,
    `配置文件：${config?.paths?.config ?? '(未知)'}`,
    `会话数：${sessionCount}（其中空会话 ${emptyCount}）`,
  ]
    .filter((line) => line !== '')
    .join('\n')

  return (
    <div id="settings">
      <div className="set-head">
        <h1>设置</h1>
        <div className="set-head-actions">
          <button type="button" className="side-action" onClick={onReset}>
            恢复默认
          </button>
          <button type="button" className="side-action" onClick={onClose}>
            返回对话
          </button>
        </div>
      </div>

      <div className="set-body">
        {/*
          左侧分类、右侧只显示选中的那一类。
          一整块长页要滚很久才找得到东西，而"设置"这种东西本来就是**按目的找**的。
        */}
        <nav className="set-nav">
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === section ? 'set-nav-item on' : 'set-nav-item'}
              aria-current={item.id === section ? 'page' : undefined}
              onClick={() => setSection(item.id)}
            >
              <span className="name">{item.label}</span>
              <span className="hint">{item.hint}</span>
            </button>
          ))}
        </nav>

        <div className="set-pane">
          {section === 'ui' ? (
            <section className="set-section">
              <p className="set-note">这些只影响你这台浏览器，不会改动守护进程的配置。</p>

        <Row label="主题">
          <Segmented<ThemeChoice>
            value={settings.theme}
            onChange={(theme) => onChange({ theme })}
            options={[
              { value: 'auto', label: '跟随系统' },
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
            ]}
          />
        </Row>

        <Row label="正文字号" hint={`${FONT_SIZE_RANGE.min}–${FONT_SIZE_RANGE.max} px`}>
          <div className="steps">
            <button
              type="button"
              className="step"
              disabled={settings.fontSize <= FONT_SIZE_RANGE.min}
              onClick={() => onChange({ fontSize: settings.fontSize - 1 })}
            >
              −
            </button>
            <span className="step-value">{settings.fontSize}</span>
            <button
              type="button"
              className="step"
              disabled={settings.fontSize >= FONT_SIZE_RANGE.max}
              onClick={() => onChange({ fontSize: settings.fontSize + 1 })}
            >
              +
            </button>
          </div>
        </Row>

        <Row
          label="自动跟到底部"
          hint={
            settings.follow === 'bottom'
              ? '你在底部时跟随，往上翻就不动（默认）'
              : settings.follow === 'always'
                ? '生成时一直跟着滚，你会被不断带到最新'
                : '完全不跟随，自己滚'
          }
        >
          <Segmented<FollowMode>
            value={settings.follow}
            onChange={(follow) => onChange({ follow })}
            options={[
              { value: 'bottom', label: '在底部时' },
              { value: 'always', label: '总是' },
              { value: 'never', label: '从不' },
            ]}
          />
        </Row>

        <Row label="代码高亮" hint="关掉能少一次重排，很长的回答会更顺">
          <Toggle value={settings.highlight} onChange={(highlight) => onChange({ highlight })} />
        </Row>

        <Row label="公式渲染" hint="关掉之后 $…$ 会按原文显示">
          <Toggle value={settings.math} onChange={(math) => onChange({ math })} />
        </Row>

        <Row
          label="图片"
          hint={
            settings.images === 'click'
              ? '不点就不发请求 —— 模型能在回复里放远程地址，加载它就等于告诉对方你的 IP（默认）'
              : settings.images === 'always'
                ? '模型给的地址会被立刻加载 —— 对方能看到你的 IP 与打开时间'
                : '一律不显示图片'
          }
        >
          <Segmented<ImagePolicy>
            value={settings.images}
            onChange={(images) => onChange({ images })}
            options={[
              { value: 'click', label: '点击加载' },
              { value: 'always', label: '总是' },
              { value: 'never', label: '不显示' },
            ]}
          />
        </Row>

        <Row label="抖动读数" hint="左下角显示 CLS 与内容回缩，排查界面抖动用">
          <Toggle value={settings.jitter} onChange={(jitter) => onChange({ jitter })} />
        </Row>

        <Row label="侧栏宽度" hint={`当前 ${sidebarWidth} px，也可以直接拖交界处`}>
          <button type="button" className="side-action" onClick={onResetSidebarWidth}>
            复位
          </button>
        </Row>
            </section>
          ) : null}

          {section === 'model' ? (
            <section className="set-section">
              <p className="set-note">
                每个供应商一张卡片。**「修改」只改这一个供应商**（不会把当前用的换掉）；
                要让某个会话改用另一个，在对话页用它自己的模型选择，或在下面「切换」——
                两者影响的范围不一样。
              </p>

              {providers.length === 0 ? (
                <Info label="供应商" value="(读不到提供商列表)" />
              ) : (
                providers.map(([id, p]) => (
                  <div className={editing === id ? 'prov-card open' : 'prov-card'} key={id}>
                    <div className="prov-head">
                      <div className="prov-title">
                        <span className="prov-name">{p.label ?? id}</span>
                        {id === active ? <span className="set-tag">当前</span> : null}
                      </div>
                      <div className="set-hint">
                        {[p.model, p.baseUrl].filter((v) => v !== undefined && v !== '').join(' · ') ||
                          '(还没配地址和模型)'}
                      </div>
                      <div className="prov-actions">
                        {/*
                          ⚠️ 卡片上**只有这一个按钮** ✓（用户明确要求的）。
                          "切到此"已经搬去输入框下面那一行 —— 换模型是高频动作，
                          摆在设置页要点三次才到位 ✓；这里只剩"改配置"这一件
                          低频、且影响所有会话的事 ✓。
                        */}
                        <button
                          type="button"
                          className="side-action"
                          onClick={() => {
                            setEditing(editing === id ? null : id)
                          }}
                        >
                          {editing === id ? '收起' : '修改'}
                        </button>
                      </div>
                    </div>

                    {editing === id ? (
                      <div className="prov-body">
                        <ModelForm
                          config={config}
                          route={id}
                          busy={savingConfig}
                          result={configResult}
                          onSave={onSaveConfig}
                        />
                      </div>
                    ) : null}
                  </div>
                ))
              )}

              {/* ── 添加供应商 ─────────────────────────────────────────── */}
              <div className="prov-add">
                <button
                  type="button"
                  className="side-action"
                  disabled={adding}
                  onClick={() => {
                    setAdding(!adding)
                  }}
                >
                  {adding ? '取消' : '+ 添加供应商'}
                </button>
              </div>

              {adding ? (
                <div className="prov-card open">
                  <div className="prov-head">
                    <div className="prov-title">
                      <span className="prov-name">新供应商</span>
                    </div>
                    <div className="set-hint">
                      需要一个**标识名**（配置里的键，比如 <code>deepseek</code>）——
                      地址和模型可以留空，之后用「修改」再填 ✓。
                    </div>
                  </div>
                  <div className="prov-body">
                    <AddProviderForm
                      existing={providers.map(([id]) => id)}
                      busy={savingConfig}
                      result={configResult}
                      onAdd={(route, fields) =>
                        /* 写 `providers` 是**合并**语义 ✓：新键=新增，已有键=只更新提到的字段 */
                        onSaveConfig({ providers: { [route]: fields } })
                      }
                    />
                  </div>
                </div>
              ) : null}

              <h3 className="set-sub">当前状态</h3>
              <Info
                label="上下文窗口"
                value={contextWindow === null ? '(未知)' : `${contextWindow.tokens} tokens`}
                hint={contextWindow?.source}
              />
              <Info label="权限默认模式" value={config?.permissions?.defaultMode ?? '(未知)'} />
            </section>
          ) : null}

          {section === 'data' ? (
            <section className="set-section">
              <p className="set-note">会话与配置都存在磁盘上；这里的动作会影响真实数据。</p>
        <Info label="状态目录" value={config?.paths?.home ?? '(未知)'} />
        <Info label="配置文件" value={config?.paths?.config ?? '(未知)'} />
        <Info
          label="会话总数"
          value={`${sessionCount}（空会话 ${emptyCount}）`}
          hint="空会话＝一次都没用过的；每打开一次页面在旧版本里会建一个"
        />
        <Row
          label="清理空会话"
          hint="删除所有一条消息都没有的会话。不可撤销，所以要点两次"
        >
          {confirming ? (
            <div className="confirm">
              <button
                type="button"
                className="side-action danger"
                disabled={cleaning}
                onClick={() => {
                  setConfirming(false)
                  onCleanEmpty()
                }}
              >
                {cleaning ? '正在清理…' : `确定删除 ${emptyCount} 条`}
              </button>
              <button type="button" className="side-action" onClick={() => setConfirming(false)}>
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="side-action"
              disabled={emptyCount === 0}
              onClick={() => setConfirming(true)}
            >
              {emptyCount === 0 ? '没有空会话' : `清理 ${emptyCount} 条空会话…`}
            </button>
          )}
        </Row>
        {cleanupNote === null ? null : <div className="set-note">{cleanupNote}</div>}

        <Row label="路径选择" hint={picker?.reason}>
          <span className="set-value">{picker?.kind ?? '(未知)'}</span>
        </Row>

        {/*
          抗疲劳熔断：**单向门必须有出口**。
          daemon 那边把它设计成"只有人明确复位才解除"，所以界面上既要给出
          **原因**（计数），也要给出**出口**（复位按钮）—— 缺了出口，用户只会
          觉得软件突然变烦，然后去点更多次「允许」，恰好是熔断器想阻止的事。
        */}
        <Row
          label="审批熔断"
          hint={
            fatigue === null
              ? '读不到状态'
              : fatigue.active
                ? `已命中：连续打回 ${fatigue.consecutiveBlocks} 次、累计 ${fatigue.totalBlocks} 次。此后写文件与执行命令都会被降级成「要你确认」，只有这里能解除。`
                : `未命中（连续 ${fatigue.consecutiveBlocks} 次、累计 ${fatigue.totalBlocks} 次）。它是一道单向门，命中后不会自己解除。`
          }
        >
          <button
            type="button"
            className={fatigue?.active === true ? 'side-action danger' : 'side-action'}
            disabled={fatigue?.active !== true}
            onClick={onResetFatigue}
          >
            {fatigue?.active === true ? '复位' : '未命中'}
          </button>
        </Row>

        <Row label="诊断信息" hint="出问题时把这段发出来，比一句「用不了」有用得多">
          <button
            type="button"
            className="side-action"
            onClick={() => {
              void navigator.clipboard
                .writeText(diagnostics)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }}
          >
            {copied ? '已复制' : '复制'}
          </button>
        </Row>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
