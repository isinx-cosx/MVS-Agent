/**
 * 「这个会话现在显示哪个模型」的取值规则。
 *
 * ## 为什么要单独一个模块（这段代码是花了一个真 bug 换来的）
 *
 * 界面原来这么写：
 *
 *     const currentModel = currentProvider?.model ?? config?.model.model ?? ''
 *
 * 那两个都是 **`/state` 里的全局默认值** —— 而"这个会话用哪个模型"是**会话级**的
 * 事实（`select_model` 改的就是它，投影里一直带着）。
 *
 * 于是点"切换模型"时：命令成功、daemon 真的切了、投影也变了 ——
 * **只有界面纹丝不动**，因为它在看另一个地方。用户看到的就是"点了没用"。
 *
 * 这类 bug 单元测试抓不到（命令是通的），命令覆盖测试也抓不到（分支是有的）——
 * **只有"取值来源"本身可以被测**。所以把它抽成一个纯函数。
 */

/**
 * 显示哪个模型，优先级：**会话 → 供应商 → 全局**。
 *
 * ⚠️ **第一档不能省。** 省掉它（或者把它放到后面）就是那个 bug：
 * 会话已经切到 B 了，界面却因为全局默认是 A 而显示 A。
 *
 * 后两档是"会话还没报出模型"时的兜底（比如投影还没到）——
 * 兜底可以退，但**不能盖住第一档**。
 */
export function displayedModel(input: { session: string; provider: string; global: string }): string {
  if (input.session !== '') return input.session
  if (input.provider !== '') return input.provider
  return input.global
}

/**
 * **哪一项该被标成「选中」。**
 *
 * ⚠️ 判据必须是 (供应商, 模型) **这一对** —— 只看模型名不够：
 * 两个供应商可能提供**同名模型**（qwen3.6 在 llama 下也有）→
 * 标记会落在"全局那家碰巧同名"的那一项上，用户看到的就是
 * 「只有一个模型能正常显示选中」。
 *
 * 供应商的来源也有讲究：**会话自己的**（投影里的 modelSelection）
 * 优先于**全局配置**（/state 的 activeProvider）—— 会话切走之后，
 * 全局那家已经不是它了。
 */
export function selectedModel(input: {
  sessionProvider: string
  sessionModel: string
  globalProvider: string
  globalModel: string
}): { provider: string; model: string } {
  if (input.sessionModel !== '') {
    return {
      provider: input.sessionProvider !== '' ? input.sessionProvider : input.globalProvider,
      model: input.sessionModel,
    }
  }
  return { provider: input.globalProvider, model: input.globalModel }
}