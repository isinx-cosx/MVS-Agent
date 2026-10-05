/**
 * 网络工具的测试。
 *
 * ## 不打真网络
 *
 * 测试里发真请求的话，红色既可能是我们的 bug、也可能是对面挂了 ——
 * 而**分不出这两者的测试会被人忽略**。所以这里只测：
 *   · 纯函数（HTML 摘要、截断）
 *   · **错误路径**（这些恰恰是最要紧的：没配后端、`file://`、没密钥）
 *
 * 真网络的验证在 `tools/probe-web-tools.mjs` 里，那是**手动跑的**，
 * 因为它依赖外部世界。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { createDefaultRegistry } from '../src/tools/index.ts'
import { htmlToText, truncate } from '../src/tools/web-tools.ts'

const registry = createDefaultRegistry()
const ctx = { root: process.cwd() }

// ---------------------------------------------------------------------------
// HTML → 文字
// ---------------------------------------------------------------------------

test('htmlToText：脚本和样式不进来', () => {
  /*
   * 这两样是**最该去掉的**：`<script>` 里是压缩过的 JS（几千字符），
   * `<style>` 里是压缩过的 CSS —— 两者看起来都像"代码"，模型会试图理解它们，
   * 而它们对"这个页面讲了什么"毫无贡献。
   */
  const text = htmlToText(
    '<html><head><style>.a{color:red}</style></head>' +
      '<body><script>var x=1;function f(){return 2}</script>' +
      '<p>真正的正文</p></body></html>',
  )
  assert.ok(text.includes('真正的正文'))
  assert.ok(!text.includes('color:red'), 'style 不该出现')
  assert.ok(!text.includes('function f'), 'script 不该出现')
})

test('htmlToText：块级元素之间要换行', () => {
  /*
   * 不换行的话整页挤成一行 —— 段落结构没了，模型看到的是
   * 「导航首页文档关于正文页脚」这种连成一片的字符串，读不出边界。
   */
  const text = htmlToText('<div>第一段</div><div>第二段</div><p>第三段</p>')
  assert.equal(text.split('\n').filter((l) => l !== '').length, 3)
})

test('htmlToText：实体要还原', () => {
  /* `&amp;` 不还原的话，URL 里的查询参数看起来是坏的（`?a=1&amp;b=2`） */
  const text = htmlToText('<p>a &amp; b &lt;tag&gt; &quot;引号&quot; &#65;</p>')
  assert.ok(text.includes('a & b'))
  assert.ok(text.includes('<tag>'))
  assert.ok(text.includes('"引号"'))
  assert.ok(text.includes('A'), '数字实体也要还原')
})

test('htmlToText：注释不掉会污染结果', () => {
  /*
   * HTML 里常有被注释掉的大段内容（模板、废弃的区块）。
   * 不去的话它们会**原样**进到模型看到的东西里 —— 而注释里的东西
   * 在页面上是看不见的，模型却会拿它当页面内容。
   */
  const text = htmlToText('<p>可见</p><!-- 隐藏的旧文案 --><p>也可见</p>')
  assert.ok(text.includes('可见'))
  assert.ok(!text.includes('隐藏的旧文案'))
})

// ---------------------------------------------------------------------------
// 截断
// ---------------------------------------------------------------------------

test('★ 截断必须说出来', () => {
  /*
   * 不说的话模型以为看到了全文 —— 于是没显示的那部分在它眼里**不存在**。
   * 一条 5000 字符的文档被截到 100，如果不说，模型会基于那 100 字符下结论。
   */
  const short = truncate('短', 100)
  assert.equal(short.truncated, 0, '没超限就不该报截断')
  assert.equal(short.text, '短')

  const long = truncate('x'.repeat(1000), 100)
  assert.equal(long.text.length, 100)
  assert.equal(long.truncated, 900, '要说清楚还有多少没显示')
})

// ---------------------------------------------------------------------------
// web_fetch 的错误路径
// ---------------------------------------------------------------------------

test('★★ web_fetch：`file://` 必须被拒 —— 否则它是绕过路径围栏的后门', () => {
  /*
   * ⚠️ **这条是整个工具集里最要紧的一条断言。**
   *
   * `read_file` 的核心保证是「工作区外一律拒」（`resolveInsideRoot`）。
   * 而 `web_fetch` 如果接受 `file://`，那就等于：
   *
   *     web_fetch { url: 'file:///C:/Users/x/.mvs-agent/config.json' }
   *
   * **一行拿到 API 密钥**，而且看起来是个完全正当的"抓取"调用。
   * 路径围栏会被从旁边绕过去，而且没人会注意到。
   */
  return (async () => {
    const result = await registry.execute(
      'web_fetch',
      { url: 'file:///C:/Users/x/.mvs-agent/config.json' },
      ctx,
    )
    assert.equal(result.ok, false, '绝不能让 file:// 通过')
    assert.equal(result.error?.kind, 'invalid_args')
    assert.match(String(result.error?.message ?? ''), /http\/https/, '要说清楚只支持什么')
  })()
})

test('web_fetch：其它协议也拒', async () => {
  for (const url of ['ftp://example.com/x', 'javascript:alert(1)', 'data:text/plain,hi']) {
    const result = await registry.execute('web_fetch', { url }, ctx)
    assert.equal(result.ok, false, `${url} 不该通过`)
  }
})

test('web_fetch：不是 URL 就报 invalid_args，不是去 fetch', async () => {
  const result = await registry.execute('web_fetch', { url: '不是网址' }, ctx)
  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'invalid_args')
})

// ---------------------------------------------------------------------------
// web_search 的错误路径
// ---------------------------------------------------------------------------

test('★ web_search：没配后端时**明确说是没配**，并指向 web_fetch', () => {
  /*
   * 这条钉的是一个**设计决定**，不是实现细节：
   *
   * 搜网页没有免密钥又能长期稳定的公共接口。所以没配就是不能用 ——
   * 而**明确报"没配"**，不去刮某个搜索引擎的 HTML 凑答案。
   *
   * 刮 HTML 的接口随对方改版就碎，而**碎的方式是"偶尔返回垃圾"** ——
   * 那种错误模型分辨不出来，它会拿垃圾当搜索结果用。
   * （这条是从 DSH 的实现里抄的：absence of those blocks is an error
   *   rather than a prose-scraping fallback。）
   */
  return (async () => {
    const result = await registry.execute('web_search', { query: '测试' }, ctx)
    assert.equal(result.ok, false)
    const message = String(result.error?.message ?? '')
    assert.match(message, /webSearch/, '错误信息要指向配置项，用户才知道改哪里')
    assert.match(message, /web_fetch/, '要指出还有个不需要配置的办法')
  })()
})

test('web_search：配了 tavily 但没密钥 → 说出来', async () => {
  const result = await registry.execute(
    'web_search',
    { query: '测试' },
    { root: ctx.root, webSearch: { provider: 'tavily' } },
  )
  assert.equal(result.ok, false)
  assert.match(String(result.error?.message ?? ''), /密钥/)
})

test('web_search：配了 searxng 但没 baseUrl → 说出来', async () => {
  /*
   * `searxng` 是**自建实例**，地址必须由用户给。忘了填的话
   * 报错要说清是"没填地址"，而不是笼统的"搜索失败"。
   */
  const result = await registry.execute(
    'web_search',
    { query: '测试' },
    { root: ctx.root, webSearch: { provider: 'searxng' } },
  )
  assert.equal(result.ok, false)
  assert.match(String(result.error?.message ?? ''), /baseUrl/)
})

test('web_search：空的 query 直接拒，不去发请求', async () => {
  const result = await registry.execute(
    'web_search',
    { query: '   ' },
    { root: ctx.root, webSearch: { provider: 'tavily', apiKey: 'x' } },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error?.kind, 'invalid_args')
})

// ---------------------------------------------------------------------------
// 风险档
// ---------------------------------------------------------------------------

test('★★ 网络工具是独立的 `network` 档，没并进 `read`', () => {
  /*
   * 这一档存在的理由：网络请求有三个本机操作没有的性质 ——
   *   · **对外**（请求本身就是泄露）
   *   · **响应不受信任**（网页是最典型的提示注入载体）
   *   · **不可撤销**
   *
   * 并进 `read` 的话，策略层就再也**没法单独对网络设限**了 ——
   * 而那正好是"拿去跑远端 API"这个场景最需要的旋钮。
   */
  for (const name of ['web_fetch', 'web_search']) {
    const tool = registry.get(name)
    assert.ok(tool !== undefined, `${name} 应该在注册表里`)
    assert.equal(tool?.risk, 'network', `${name} 该是 network 档`)
  }
})

test('网络工具的返回文本**显式标注来源是外部内容**', () => {
  /*
   * 这不能阻止提示注入（那要靠沙箱和出口限制），但能让模型看到一个
   * 明确的边界标记，而不是把网页正文和用户的话混为一谈。
   *
   * ⚠️ 这里查的是**描述**——真实返回里的那行在 `probe-web-tools.mjs` 里验，
   * 因为它需要网络。而描述是**模型决定要不要用这个工具时看到的东西**，
   * 同样该带上这个警告。
   */
  for (const name of ['web_fetch', 'web_search']) {
    const tool = registry.get(name)
    assert.match(
      String(tool?.description ?? ''),
      /外部|不是用户/,
      `${name} 的描述里要提醒返回的是外部内容`,
    )
  }
})
