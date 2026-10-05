/**
 * 模型元信息探测测试。
 *
 * 核心断言不是「能探到」，而是**探不到时如实说探不到** ——
 * 一个假装知道窗口的实现，会在运行中炸掉或者无谓地丢历史。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { probeContextLength, stripVersionSuffix } from '../src/model/probe.ts'

type Route = (url: string, init: RequestInit) => Response | Promise<Response>

function routedFetch(routes: Record<string, Route>): typeof globalThis.fetch {
  const fn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return await handler(url, init ?? {})
    }
    return new Response('not found', { status: 404 })
  }
  return fn as unknown as typeof globalThis.fetch
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// ---------------------------------------------------------------------------

test('stripVersionSuffix：把 /v1 剥掉，拿到服务根', () => {
  assert.equal(stripVersionSuffix('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434')
  assert.equal(stripVersionSuffix('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434')
  assert.equal(stripVersionSuffix('https://api.deepseek.com/v1'), 'https://api.deepseek.com')
  assert.equal(stripVersionSuffix('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')
})

test('vLLM：/v1/models 的 max_model_len 能被认出来', async () => {
  const result = await probeContextLength({
    baseUrl: 'http://127.0.0.1:8000/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    fetch: routedFetch({
      '/v1/models': () =>
        json({
          object: 'list',
          data: [
            { id: 'other-model', object: 'model' },
            { id: 'Qwen/Qwen2.5-7B-Instruct', object: 'model', max_model_len: 32_768 },
          ],
        }),
    }),
  })

  assert.equal(result.source, 'openai-models')
  assert.equal(result.contextLength, 32_768)
  assert.match(result.evidence ?? '', /max_model_len/)
})

test('OpenRouter 风格的 context_length 也能认出来', async () => {
  const result = await probeContextLength({
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-3.5-sonnet',
    fetch: routedFetch({
      '/v1/models': () =>
        json({ data: [{ id: 'anthropic/claude-3.5-sonnet', context_length: 200_000 }] }),
    }),
  })
  assert.equal(result.contextLength, 200_000)
})

test('Ollama：/api/show 的 model_info 里带架构前缀的 context_length', async () => {
  let sentBody = ''
  const result = await probeContextLength({
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    fetch: routedFetch({
      // Ollama 的 /v1/models 只给 id，不给窗口 —— 所以必须继续往下试
      '/v1/models': () => json({ object: 'list', data: [{ id: 'qwen2.5:7b', object: 'model' }] }),
      '/api/show': (_url, init) => {
        sentBody = String(init.body ?? '')
        return json({
          details: { family: 'qwen2' },
          model_info: {
            'general.architecture': 'qwen2',
            'qwen2.context_length': 32_768,
            'qwen2.embedding_length': 3_584,
          },
        })
      },
    }),
  })

  assert.equal(result.source, 'ollama-show')
  assert.equal(result.contextLength, 32_768)
  assert.match(result.evidence ?? '', /qwen2\.context_length/)
  // 新旧版本的字段名不同，两个都要带上
  assert.match(sentBody, /"name":"qwen2\.5:7b"/)
  assert.match(sentBody, /"model":"qwen2\.5:7b"/)
})

test('llama.cpp：/props 的 n_ctx', async () => {
  const result = await probeContextLength({
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'local',
    fetch: routedFetch({
      '/props': () => json({ default_generation_settings: { n_ctx: 4_096 } }),
    }),
  })
  assert.equal(result.source, 'llama-props')
  assert.equal(result.contextLength, 4_096)
})

test('★ 探不到时如实说探不到，绝不编一个数', async () => {
  const result = await probeContextLength({
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    fetch: routedFetch({
      // OpenAI / DeepSeek 的真实形状：只有 id、object、owned_by
      '/v1/models': () =>
        json({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }] }),
    }),
  })

  assert.equal(result.source, 'none')
  assert.equal(result.contextLength, undefined, '探不到就必须是 undefined，不能给个默认值假装知道')
  assert.match(result.error ?? '', /没有上下文长度/)
})

test('网络不通时说清楚是网络问题，而不是「没有这个字段」', async () => {
  const result = await probeContextLength({
    baseUrl: 'http://127.0.0.1:9/v1',
    model: 'x',
    fetch: routedFetch({}),
  })
  assert.equal(result.source, 'none')
  assert.ok((result.error ?? '').length > 0)
})

test('端点返回 500 不会让探测抛异常出来 —— 探测失败不该是致命问题', async () => {
  const result = await probeContextLength({
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'x',
    fetch: routedFetch({ '/models': () => new Response('boom', { status: 500 }) }),
  })
  assert.equal(result.source, 'none')
  assert.equal(result.contextLength, undefined)
})
