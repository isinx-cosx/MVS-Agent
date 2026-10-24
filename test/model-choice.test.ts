/**
 * 「这个会话显示哪个模型」的取值规则。
 *
 * **第一档（会话）就是今天那个 bug 的所在**：它被漏掉时，daemon 明明切成功了、
 * 投影也变了，界面却因为读的是全局默认值而纹丝不动 —— 用户看到"点了没用"。
 *
 * 所以这里最要紧的一条是：**会话的值必须压过全局**，
 * 而且这条测试写成"两者不同"的形状 —— 若写成相同值，漏掉第一档也照样通过。
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { displayedModel, selectedModel } from '../ui/model-choice.ts'

test('★ 会话已经切过 → 显示会话的，压过供应商与全局（这条就是那个 bug）', () => {
  assert.equal(
    displayedModel({ session: 'qwen2.5:7b', provider: 'qwen3.6', global: 'qwen3.6' }),
    'qwen2.5:7b',
  )
  /* 三个都不一样，确保取的是第一档而不是碰巧 */
  assert.equal(
    displayedModel({ session: 'A', provider: 'B', global: 'C' }),
    'A',
  )
})

test('会话还没报出模型 → 退到供应商', () => {
  assert.equal(displayedModel({ session: '', provider: 'B', global: 'C' }), 'B')
})

test('会话与供应商都没有 → 退到全局', () => {
  assert.equal(displayedModel({ session: '', provider: '', global: 'C' }), 'C')
})

test('三者都空 → 空串（界面据此显示「读取中…」，而不是编一个名字）', () => {
  assert.equal(displayedModel({ session: '', provider: '', global: '' }), '')
})

test('只有会话为空串算"没有" —— 空白字符串不是模型名', () => {
  /*
   * 这条防的是"把空串当值"：投影没到时会给出 `''`，
   * 如果判据写成 `?? `（只挡 undefined）而不是 `!== ''`，
   * 界面就会显示一个空标签，看起来像加载失败。
   */
  assert.equal(displayedModel({ session: '', provider: 'B', global: 'C' }), 'B')
  assert.notEqual(displayedModel({ session: '', provider: 'B', global: 'C' }), '')
})

test('★ 同名模型在两个供应商下 —— 标记必须落在会话选的那一个', () => {
  /*
   * 这是用户报的那个现象：「只有一个模型能正常显示选中」。
   * 两个供应商都提供 qwen3.6，会话切到了 ollama 那一个 ——
   * 若判据只比模型名，标记会落在全局（llama）那一项上，
   * 也就是"选中提示跑到别的模型上"。
   */
  const chosen = selectedModel({
    sessionProvider: 'ollama',
    sessionModel: 'qwen3.6',
    globalProvider: 'llama',
    globalModel: 'qwen3.6',
  })
  assert.deepEqual(chosen, { provider: 'ollama', model: 'qwen3.6' })
  /* 反过来说：光看模型名这两个候选长得一模一样 —— 所以必须比这一对 */
  assert.notDeepEqual(chosen, { provider: 'llama', model: 'qwen3.6' })
})

test('会话没选过 → 用全局配置那一对', () => {
  assert.deepEqual(
    selectedModel({ sessionProvider: '', sessionModel: '', globalProvider: 'llama', globalModel: 'qwen3.6' }),
    { provider: 'llama', model: 'qwen3.6' },
  )
})

test('会话选了模型但投影里没带供应商（旧数据）→ 模型用会话的、供应商退到全局', () => {
  assert.deepEqual(
    selectedModel({ sessionProvider: '', sessionModel: 'A', globalProvider: 'B', globalModel: 'C' }),
    { provider: 'B', model: 'A' },
  )
})