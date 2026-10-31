/**
 * 输出审核的扫描器：**纯函数，不碰磁盘、不碰会话**。
 *
 * ## 它守的是什么
 *
 * 模型能知道的一切都来自工具输出。所以"别让它看见密钥"这件事只有一个位置可做：
 * 工具结果变成消息**之前**（闸门在 `src/guard/review.ts`，调用这里的扫描）。
 *
 * ## 三条克制
 *
 * 1. **按行处理**：一次 `grep -rn` 命中 300 行、其中 1 行含密钥，整份扣掉的话
 *    用户会关掉这个功能 —— 一个总在挡路的护栏等于没有护栏。
 * 2. **保守的检测**：宁可漏掉"看起来像密码的普通单词"，也不要把 `password: ''`
 *    这种空值、`token: 3` 这种计数当成密钥。误报会直接训练用户闭眼点"放行"。
 * 3. **不靠单一信号**：前缀、PEM 头、赋值形态、JWT、高熵 —— 各自独立命中。
 */

export type SecretCategory =
  | 'api-key'
  | 'private-key'
  | 'authorization'
  | 'assignment'
  | 'jwt'
  | 'high-entropy'

export interface SecretHit {
  /** 1 基行号 */
  line: number
  category: SecretCategory
  /** 命中处的**打码预览**（前 3 后 4），给用户判断用 */
  preview: string
}

export interface ScanResult {
  /** 命中处已被替换成占位符的文本 */
  text: string
  hits: SecretHit[]
}

export interface ScanOptions {
  /** 已知敏感路径：整份打码，不做逐行匹配 */
  wholeFile?: boolean
  /** 这个路径的名字，用进占位符（例如 `.env`） */
  pathHint?: string
}

const PLACEHOLDER = '〔已扣留〕'

/** 常见密钥前缀。短、明确，几乎不会误报 */
const PREFIXES = [
  'sk-ant-',
  'sk-',
  'AKIA',
  'ASIA',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'xoxb-',
  'xoxp-',
  'AIza',
  'glpat-',
  'npm_',
  'pypi-',
]

/** 赋值形态：`password = "..."` / `api_key: '...'` 之类 */
const ASSIGNMENT =
  /(?:^|[\s,{;])(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*(['"`]?)([^\s'"`]{6,})/i

/** JWT：三段 base64url，头两段以 `ey` 开头 */
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/

/** `Authorization: Bearer xxxxx` */
const AUTH_HEADER = /\b(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+\S{6,}/i

/** PEM 私钥块 */
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

/** 打码：前 3 后 4，中间省略。太短就整体打掉 */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '…'
  return `${value.slice(0, 3)}…${value.slice(-4)}`
}

/** 高熵：长度 ≥ 32、四类字符里至少三类、且不是纯十六进制（哈希） */
export function looksHighEntropy(token: string): boolean {
  if (token.length < 32) return false
  if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) return false
  if (/^[0-9a-fA-F]+$/.test(token)) return false /* git hash / checksum 放行 */

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[+/=_-]/].filter((re) => re.test(token)).length
  if (classes < 3) return false

  /* 词表里的长单词（例如一长串小写标识符）不算密钥 */
  const distinct = new Set(token).size
  return distinct >= 12
}

function categorize(line: string): { category: SecretCategory; value: string } | null {
  if (PEM.test(line)) return { category: 'private-key', value: 'PRIVATE KEY' }

  const auth = AUTH_HEADER.exec(line)
  if (auth !== null) return { category: 'authorization', value: auth[0] }

  const jwt = JWT.exec(line)
  if (jwt !== null) return { category: 'jwt', value: jwt[0] }

  for (const prefix of PREFIXES) {
    const at = line.indexOf(prefix)
    if (at < 0) continue
    /* 值从前缀开始，取到引号/空白/行尾 */
    const rest = line.slice(at)
    const match = /^[A-Za-z0-9+/=_.-]{8,}/.exec(rest)
    return { category: 'api-key', value: match === null ? prefix : match[0] }
  }

  const assignment = ASSIGNMENT.exec(line)
  if (assignment !== null) {
    const value = assignment[2] ?? ''
    /* 空值、纯数字、纯小写单词（可能是标识符）不算 */
    if (value !== '' && !/^\d+$/.test(value) && !/^[a-z0-9_-]{0,11}$/.test(value)) {
      return { category: 'assignment', value }
    }
  }

  for (const token of line.split(/[\s"'`,;:(){}\[\]<>]+/)) {
    if (looksHighEntropy(token)) return { category: 'high-entropy', value: token }
  }

  return null
}

function redactLine(line: string, value: string, category: SecretCategory): string {
  if (value === 'PRIVATE KEY') {
    return line.replace(PEM, `-----BEGIN 〔已扣留私钥〕-----`)
  }
  if (category === 'high-entropy') return line.split(value).join(PLACEHOLDER)
  return line.split(value).join(PLACEHOLDER)
}

/**
 * 扫一段文本。
 *
 * `wholeFile: true` 时（已知敏感路径）不逐行判断，**整份**换成一句说明 ——
 * 因为内容匹配天然可以被分段与编码绕过，而"这个路径按定义就敏感"绕不过去。
 */
export function scanText(text: string, options: ScanOptions = {}): ScanResult {
  if (text === '') return { text, hits: [] }

  if (options.wholeFile === true) {
    return {
      text:
        `〔整份输出已扣留：${options.pathHint ?? '这个路径'} 属于敏感文件（凭据/私钥/环境变量一类）。` +
        `模型没有看到它的内容；如需查看请人自己打开。〕`,
      hits: [{ line: 1, category: 'private-key', preview: options.pathHint ?? '敏感文件' }],
    }
  }

  const lines = text.split('\n')
  const hits: SecretHit[] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line.trim() === '') continue
    const found = categorize(line)
    if (found === null) continue

    hits.push({
      line: index + 1,
      category: found.category,
      preview: maskSecret(found.value),
    })
    lines[index] = redactLine(line, found.value, found.category)
  }

  return { text: lines.join('\n'), hits }
}

/**
 * 这个路径是不是"按定义就敏感"。
 *
 * 比内容匹配可靠得多：分段读取（每次读 10 个字符）与编码（base64、UTF-16）
 * 都能绕过内容匹配，但绕不过路径分类。
 */
export function isSensitivePath(rel: string): boolean {
  const clean = rel.split('\\').join('/').toLowerCase()
  const base = clean.slice(clean.lastIndexOf('/') + 1)

  if (base === '.env' || base.startsWith('.env.')) return true
  if (base === '.npmrc' || base === '.netrc' || base === '.pgpass') return true
  if (base === 'id_rsa' || base === 'id_dsa' || base === 'id_ecdsa' || base === 'id_ed25519') return true
  if (base === 'credentials' && clean.includes('.aws')) return true
  if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.pfx')) return true
  if (base === 'service-account.json' || base === 'secrets.json') return true
  return false
}

/** 从一段说明里去掉具体值，只留类别 —— 日志里不该出现密钥的碎片 */
export function describeHits(hits: SecretHit[]): string {
  if (hits.length === 0) return ''
  const counts = new Map<SecretCategory, number>()
  for (const hit of hits) counts.set(hit.category, (counts.get(hit.category) ?? 0) + 1)
  return [...counts.entries()].map(([category, count]) => `${category} × ${count}`).join('、')
}
