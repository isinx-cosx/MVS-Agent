/**
 * 本地模型监管器的测试。
 *
 * 挑的都是**纯函数**和**不碰真进程**的部分 —— 起一个 20 GB 的 llama-server
 * 不在单元测试该干的事里（那由 `tools/local-model-lifecycle.mjs` 做端到端）。
 *
 * 这里钉住的是几条**踩过坑**的行为，其中第一条是我自己犯过的：
 *
 *   · `-ngl` 默认是 **999**（全上 GPU），**不是 0**
 *   · `-ncmoe` / `-c` 是一对，都要传下去
 *   · `-fa` 要带值（不带的话它吃掉下一个参数，报的还是别的参数）
 *   · `--parallel 1` 不能省（默认多 slot 会把显存切碎）
 *   · 值为 0 的参数不能被当成「没填」
 *   · 缺配置要**列出缺哪一项**，不是只说「失败」
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildArgs, missingConfig } from '../src/host/local-model.ts'

/** 把 `-x v` 形式的参数收成 Map，方便断言 */
function pairsOf(args: string[]): Map<string, string> {
  const pairs = new Map<string, string>()
  for (let i = 0; i < args.length - 1; i += 1) pairs.set(args[i]!, args[i + 1]!)
  return pairs
}

test('★ buildArgs：-ngl 默认 999，不是 0', () => {
  /*
   * ⚠️ 这条钉的是一个**我自己犯过的错**。
   *
   * 第一版我写死 `-ngl 0`，理由是「显存留给小模型」—— 那是我自己编的约束，
   * 代价是**一点 GPU 都没用上**：载入 155 秒、12 GB 显存空着。
   * 用户直接指出来的（「光占内存不占显存」）。
   *
   * 对 MoE 模型，`-ngl` 管的是**非专家**部分（attention、嵌入、norm）——
   * 那些很小却算得最频繁，放 GPU 是纯赚。占地方的专家张量由 `-ncmoe` 单独控。
   */
  const args = buildArgs({ modelPath: 'D:\\m.gguf' }, 'D:\\m.gguf')
  assert.equal(pairsOf(args).get('-ngl'), '999')
})

test('buildArgs：完整的一套落到正确的旗标上', () => {
  const args = buildArgs(
    {
      modelPath: 'D:\\m.gguf',
      port: 8080,
      alias: 'qwen3.6',
      ctxSize: 131072,
      cpuMoeLayers: 26,
      gpuLayers: 999,
      cacheTypeK: 'q8_0',
      cacheTypeV: 'q8_0',
      flashAttention: true,
      cacheRam: 2048,
      parallel: 1,
      reasoning: 'off',
      reasoningFormat: 'deepseek',
    },
    'D:\\m.gguf',
  )
  const pairs = pairsOf(args)

  assert.equal(args[0], '-m')
  assert.equal(args[1], 'D:\\m.gguf')
  assert.equal(pairs.get('-ngl'), '999')
  assert.equal(pairs.get('-ncmoe'), '26')
  assert.equal(pairs.get('-c'), '131072')
  assert.equal(pairs.get('-ctk'), 'q8_0')
  assert.equal(pairs.get('-ctv'), 'q8_0')
  assert.equal(pairs.get('-cram'), '2048')
  assert.equal(pairs.get('--parallel'), '1')
  assert.equal(pairs.get('--reasoning'), 'off')
  assert.equal(pairs.get('--reasoning-format'), 'deepseek')
  assert.equal(pairs.get('--alias'), 'qwen3.6')
  assert.equal(pairs.get('--port'), '8080')
  /*
   * ⚠️ `-fa` **必须带值**。这个构建把它当 `--flash-attn` 的取值形式，
   * 而裸 `-fa` 会把**下一个参数**当成值吃掉，报出来的是
   * 「unknown value for --flash-attn: '-ngl'」—— 看起来像 `-ngl` 有问题。
   * 这个坑实测踩过一次。
   */
  assert.equal(pairs.get('-fa'), 'on')
  assert.equal(pairs.get('--host'), '127.0.0.1')
})

test('buildArgs：--parallel 默认就是 1（不能省）', () => {
  /*
   * 显存在这个配置里是最稀缺的资源，而默认多 slot 会把它切成几份。
   * 单用户场景设 1 是硬要求，所以**默认值也必须是 1** ——
   * 靠用户记得填，就会有人忘了填。
   */
  const args = buildArgs({ modelPath: 'D:\\m.gguf' }, 'D:\\m.gguf')
  assert.equal(pairsOf(args).get('--parallel'), '1')
})

test('buildArgs：没填的可选参数不出现在命令行里', () => {
  const args = buildArgs({ modelPath: 'D:\\m.gguf' }, 'D:\\m.gguf')
  assert.ok(!args.includes('-ncmoe'), '没声明专家分档就不该传 —— 传了会绑住服务端的默认值')
  assert.ok(!args.includes('-c'))
  assert.ok(!args.includes('-ctk'))
  assert.ok(!args.includes('-cram'))
  assert.ok(!args.includes('--reasoning-budget'))
})

test('★ buildArgs：--reasoning 默认 on（思考默认开启）', () => {
  /*
   * ⚠️ 这条**改过两次，第一次改是错的**，把经过留着。
   *
   * ## 实测的三种取值
   *
   * 同一个问题（鸡兔同笼）、同一个 900 token 上限：
   *
   *     off    1.6s  finish=stop    思考 0 字符     正文 5 字符（"23 12"，答对）
   *     auto  17.5s  finish=length  思考 2552 字符  正文 0 字符
   *     on    17.3s  finish=length  思考 2510 字符  正文 0 字符
   *
   * 所以 `off` 是**完全不思考**（`reasoning_content` 字段根本不出现），
   * 只有 `auto` / `on` 才把思考放进 `reasoning_content`。
   *
   * ## 为什么默认是 `on` 而不是 `auto`
   *
   * 两者实测差别可以忽略（2552 vs 2510 字符）。写 `on` 是因为
   * 「默认开启」是个**明确的**默认值，而 `auto` 的语义是「让服务端决定」——
   * 明确的默认值不该把决定权再交出去。
   *
   * ## 我第一次改错在哪
   *
   * 我一度把默认设成 `off`，依据是「`on` 会把服务打崩」——
   * 那是我反复 `taskkill` 之后留下的**半死进程**造成的假象。
   * 复测用 `tools/probe-reasoning-sweep.mjs`：**起 → 探 → 关**，
   * 每个取值一个干净进程，三种都稳。
   *
   * 教训：**在脏环境里测出来的因果关系不算数**。那一次我不仅改错了默认值，
   * 还把它写进了注释和测试，等于把错的结论固化下来。
   *
   * ## `auto` / `on` 那两行「正文 0 字符」不是坏了
   *
   * 是 900 token 的上限**被思考吃光了**（`finish_reason: length`）。
   * `src/host/session.ts` 有一条分支专门处理「只产出了思考、没有正文」的回合，
   * 并把这个原因说出来 —— 所以它不会静默变成一条空消息。
   */
  const bare = pairsOf(buildArgs({ modelPath: 'D:\\m.gguf' }, 'D:\\m.gguf'))
  assert.equal(bare.get('--reasoning'), 'on', '默认 on —— 思考默认开启，见注释里的对照表')
  assert.equal(bare.get('--reasoning-format'), 'deepseek', '格式要成对给，否则思考混进正文')

  const forcedOff = pairsOf(buildArgs({ modelPath: 'D:\\m.gguf', reasoning: 'off' }, 'D:\\m.gguf'))
  assert.equal(forcedOff.get('--reasoning'), 'off', '显式写的值要生效 —— 默认值不能盖掉它')
})

test('★ buildArgs：值为 0 的参数不能被当成「没填」', () => {
  /*
   * `-ngl 0` / `-ncmoe 0` / `-cram 0` 都是**有意义的取值**（全在 CPU / 专家全上 GPU /
   * KV 不进 RAM），而不是「没设」。用 `if (config.gpuLayers)` 那种判法 0 会被跳过，
   * 于是服务端用自己的默认值 —— **一次静默的改配置**，而且不报错。
   */
  const args = buildArgs(
    { modelPath: 'D:\\m.gguf', gpuLayers: 0, cpuMoeLayers: 0, cacheRam: 0 },
    'D:\\m.gguf',
  )
  const pairs = pairsOf(args)
  assert.equal(pairs.get('-ngl'), '0')
  assert.equal(pairs.get('-ncmoe'), '0')
  assert.equal(pairs.get('-cram'), '0')
})

test('buildArgs：flashAttention 显式关掉要传 off', () => {
  const args = buildArgs({ modelPath: 'D:\\m.gguf', flashAttention: false }, 'D:\\m.gguf')
  assert.equal(pairsOf(args).get('-fa'), 'off')
})

test('buildArgs：reasoningBudget 负数（= 不限）不传', () => {
  const args = buildArgs({ modelPath: 'D:\\m.gguf', reasoningBudget: -1 }, 'D:\\m.gguf')
  assert.ok(!args.includes('--reasoning-budget'), '-1 表示不限，传下去等于给自己设了个怪上限')
  const withBudget = buildArgs({ modelPath: 'D:\\m.gguf', reasoningBudget: 256 }, 'D:\\m.gguf')
  assert.equal(pairsOf(withBudget).get('--reasoning-budget'), '256')
})

test('buildArgs：extraArgs 是逃生口，接在最后', () => {
  const args = buildArgs(
    { modelPath: 'D:\\m.gguf', extraArgs: ['--no-warmup', '--threads', '8'] },
    'D:\\m.gguf',
  )
  assert.ok(args.indexOf('--no-warmup') > args.indexOf('--host'), '逃生口参数排在后面')
  assert.ok(args.includes('--threads'))
})

test('missingConfig：没配 modelPath 就是「缺一项」', () => {
  const missing = missingConfig(undefined)
  assert.equal(missing.length, 1)
  assert.match(missing[0], /modelPath/)
  assert.match(missing[0], /绝对路径/, '要说清楚该填什么 —— 只说「缺配置」等于没说')
})

test('missingConfig：路径填了但文件不在，要说出**那个路径**', () => {
  const missing = missingConfig({ modelPath: 'D:\\nope\\does-not-exist.gguf' })
  assert.equal(missing.length, 1)
  assert.match(missing[0], /不存在/)
  assert.match(missing[0], /does-not-exist\.gguf/, '要把路径带出来，否则用户不知道是哪个文件')
})

test('missingConfig：serverPath 指向不存在的文件也算缺', () => {
  const missing = missingConfig({
    modelPath: 'D:\\nope\\m.gguf',
    serverPath: 'D:\\nope\\llama-server.exe',
  })
  assert.equal(missing.length, 2, '两项都要报出来，不能只报第一个')
})
