/**
 * 极小的 JSON Schema 子集校验器。
 *
 * 为什么自己写而不是引依赖：内核到现在零运行时依赖，为了几个字段拉一个
 * ajv 进来不划算；而且我们只需要覆盖工具参数真正会用到的关键字。
 *
 * 支持：type / properties / required / additionalProperties / items /
 *      enum / minimum / maximum / minLength
 *
 * 关键点：**工具的 parameters 字段是单一事实来源** ——
 * 它既是发给模型的声明，也是这里的校验依据。两处分开写必然漂移。
 */

export type JsonSchema = Record<string, unknown>

export type ValidationResult = { ok: true } | { ok: false; message: string }

export function validate(
  schema: JsonSchema,
  value: unknown,
  path = '$',
): ValidationResult {
  // 未知的 type 不拦（保持宽松，避免把 schema 写错变成运行时报错）
  const type = schema.type
  if (typeof type === 'string' && !matchesType(type, value)) {
    return { ok: false, message: `${path} 期望 ${type}，实际是 ${describe(value)}` }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJson(item, value))) {
    return { ok: false, message: `${path} 必须是 ${JSON.stringify(schema.enum)} 之一` }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties)
      ? (schema.properties as Record<string, JsonSchema>)
      : {}
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : []

    for (const key of required) {
      if (!(key in value)) {
        return { ok: false, message: `${path}.${key} 是必填字段` }
      }
    }

    for (const [key, item] of Object.entries(value)) {
      const sub = properties[key]
      if (sub !== undefined) {
        const result = validate(sub, item, `${path}.${key}`)
        if (!result.ok) return result
        continue
      }
      if (schema.additionalProperties === false) {
        return { ok: false, message: `${path}.${key} 不是允许的字段` }
      }
      if (isPlainObject(schema.additionalProperties)) {
        const result = validate(schema.additionalProperties, item, `${path}.${key}`)
        if (!result.ok) return result
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    for (let i = 0; i < value.length; i += 1) {
      const result = validate(schema.items, value[i], `${path}[${i}]`)
      if (!result.ok) return result
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      return { ok: false, message: `${path} 不能小于 ${schema.minimum}` }
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      return { ok: false, message: `${path} 不能大于 ${schema.maximum}` }
    }
  }

  if (typeof value === 'string' && typeof schema.minLength === 'number') {
    if (value.length < schema.minLength) {
      return { ok: false, message: `${path} 长度不能小于 ${schema.minLength}` }
    }
  }

  return { ok: true }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    case 'null':
      return value === null
    default:
      return true
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
