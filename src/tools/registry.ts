/**
 * 工具注册表 —— 也是「错误是结果」这条原则的落地点。
 *
 * 工具内部该 throw 就 throw（那是最自然的写法），但**边界**在这里收敛：
 * 任何异常都变成 ToolResult，绝不会穿透到调用方。
 */

import type { ToolSchema } from '../model/types.ts'
import { PLUGIN_PREFIX } from '../plugins/types.ts'
import { validate } from './schema.ts'
import {
  failResult,
  type AnyTool,
  type ToolContext,
  type ToolResult,
} from './types.ts'

export class ToolRegistry {
  #tools = new Map<string, AnyTool>()

  register(tool: AnyTool): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`工具重名：${tool.name}`)
    }
    this.#tools.set(tool.name, tool)
    return this
  }

  registerAll(tools: AnyTool[]): this {
    for (const tool of tools) this.register(tool)
    return this
  }

  get(name: string): AnyTool | undefined {
    return this.#tools.get(name)
  }

  /**
   * 换掉所有插件工具。
   *
   * 插件工具的名字都以 `plugin__` 开头，所以识别很干净；先删再注册，
   * 同名覆盖是**刻意**的 —— 插件升级后工具实现必须换新，这一点和
   * `register`（重名就抛）语义不同。
   *
   * 为什么是「换一批」而不是「逐个注册」：插件被卸载或禁用之后，
   * 它的工具必须**从注册表里消失**，否则模型还会看到它、还会去调。
   */
  replacePluginTools(tools: AnyTool[]): this {
    for (const name of [...this.#tools.keys()]) {
      if (name.startsWith(PLUGIN_PREFIX)) this.#tools.delete(name)
    }
    for (const tool of tools) this.#tools.set(tool.name, tool)
    return this
  }

  list(): AnyTool[] {
    return [...this.#tools.values()]
  }

  /**
   * 转换成发给模型的工具声明。
   *
   * 由 `Session` 在每次调模型前调用 —— 工具循环在 `src/host/session.ts`，
   * 权限判定与审批挂起都在那儿。
   *
   * ⚠️ 唯一**没有**调用它的入口是 `src/cli/chat.ts`（裸对话 REPL）：那里
   * 刻意不给模型任何能力，好让模型层能单独跑、单独测。这条由
   * `test/tools.test.ts` 的「结构守卫」钉住。
   */
  toModelSchemas(): ToolSchema[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))
  }

  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(name)
    if (!tool) {
      return failResult(
        'unknown_tool',
        `没有名为 ${name} 的工具。可用工具：${[...this.#tools.keys()].join('、') || '(无)'}`,
      )
    }

    if (ctx.signal?.aborted) {
      return failResult('aborted', '调用前就已被取消')
    }

    // 模型可能给对象，也可能给 JSON 字符串（工具调用参数本来就是字符串碎片）
    let args: unknown = rawArgs
    if (typeof rawArgs === 'string') {
      try {
        args = JSON.parse(rawArgs)
      } catch (err) {
        return failResult('invalid_args', `参数不是合法 JSON：${messageOf(err)}`)
      }
    }

    const checked = validate(tool.parameters, args)
    if (!checked.ok) {
      return failResult('invalid_args', `参数不合法：${checked.message}`)
    }

    try {
      return await tool.run(args as never, ctx)
    } catch (err) {
      return failResult('failed', `工具执行时抛出异常：${messageOf(err)}`)
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
