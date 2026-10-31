/**
 * 断言：把「观察到的事实」和「场景声明」比对。
 *
 * 分两类，因为它们的**含义完全不同**：
 *
 *   · `invariant` —— 产品坏了。这些跟模型无关，任何模型跑都不该出现。
 *   · `expectation` —— 模型没做到这次任务的要求。
 *
 * 混在一起会让报告变成"跑完 20 个场景，失败 7 个"这种没法行动的数字。
 */

import type { Failure, Observations, Scenario } from './types.ts'

/** 子串或 `/正则/` —— 场景文件是人手写的，两种写法都要能表达 */
function matchesText(haystack: string, needle: string): boolean {
  const trimmed = needle.trim()
  if (trimmed.length > 2 && trimmed.startsWith('/') && trimmed.endsWith('/')) {
    try {
      return new RegExp(trimmed.slice(1, -1)).test(haystack)
    } catch {
      return haystack.includes(trimmed.slice(1, -1))
    }
  }
  return haystack.includes(trimmed)
}

/**
 * 不变量：与模型无关，任何模型跑都不该违反。
 *
 * 这五条对应五个真实会在别处炸掉的东西：
 *   1. 一轮没结束 → 界面永远在"运行中"
 *   2. 有挂着的工具调用 → 会话卡在 interrupted，用户只能重启
 *   3. 有悬空的审批 → 同上
 *   4. 日志有坏行 → 重放时会丢步骤
 *   5. 超时 → 结论不能说"通过"，也不能说"模型不行"
 */
export function checkInvariants(observations: Observations): Failure[] {
  const failures: Failure[] = []

  if (observations.timedOut === true) {
    failures.push({
      kind: 'invariant',
      message: `超时（${observations.ms} ms）—— 这一轮没有跑完，不能算通过也不能算模型不行`,
    })
  }
  if (observations.status === 'running') {
    failures.push({ kind: 'invariant', message: '这一轮没有结束（状态仍是 running）' })
  }
  if (observations.unsettledCall) {
    failures.push({ kind: 'invariant', message: '有一个工具调用没有结算（会话会卡在 interrupted）' })
  }
  if (observations.pendingApproval) {
    failures.push({ kind: 'invariant', message: '有一个审批悬空没有答案' })
  }
  if (observations.malformed > 0) {
    failures.push({ kind: 'invariant', message: `事件日志里有 ${observations.malformed} 行解析不了` })
  }

  return failures
}

export function checkExpectations(scenario: Scenario, observations: Observations): Failure[] {
  const expect = scenario.expect
  if (expect === undefined) return []

  const failures: Failure[] = []
  const calledNames = new Set(observations.tools.map((tool) => tool.name))

  if (expect.finalText !== undefined && !matchesText(observations.finalText, expect.finalText)) {
    failures.push({
      kind: 'expectation',
      message: `最终正文不含「${expect.finalText}」，实际：${observations.finalText.slice(0, 200)}`,
    })
  }

  if (expect.toolCalled !== undefined && expect.toolCalled.length > 0) {
    const hit = expect.toolCalled.some((name) => calledNames.has(name))
    if (!hit) {
      failures.push({
        kind: 'expectation',
        message: `应当调用过 ${expect.toolCalled.join(' / ')} 之一，实际调用：${[...calledNames].join(' / ') || '（没有）'}`,
      })
    }
  }

  if (expect.toolAllCalled !== undefined) {
    for (const name of expect.toolAllCalled) {
      if (!calledNames.has(name)) {
        failures.push({
          kind: 'expectation',
          message: `应当调用过 ${name}，实际调用：${[...calledNames].join(' / ') || '（没有）'}`,
        })
      }
    }
  }

  if (expect.toolNotCalled !== undefined) {
    for (const name of expect.toolNotCalled) {
      if (calledNames.has(name)) {
        failures.push({ kind: 'expectation', message: `不该调用 ${name}，但它调用了` })
      }
    }
  }

  if (expect.fileContains !== undefined) {
    for (const [file, needle] of Object.entries(expect.fileContains)) {
      const content = observations.files[file]
      if (content === undefined) {
        failures.push({ kind: 'expectation', message: `文件 ${file} 不存在` })
        continue
      }
      if (!matchesText(content, needle)) {
        failures.push({
          kind: 'expectation',
          message: `文件 ${file} 不含「${needle}」，实际：${content.slice(0, 200)}`,
        })
      }
    }
  }

  if (expect.fileMissing !== undefined) {
    for (const file of expect.fileMissing) {
      if (observations.files[file] !== undefined) {
        failures.push({ kind: 'expectation', message: `文件 ${file} 应当不存在，但它被创建了` })
      }
    }
  }

  if (expect.maxSteps !== undefined && observations.steps > expect.maxSteps) {
    failures.push({
      kind: 'expectation',
      message: `最多 ${expect.maxSteps} 步，实际走了 ${observations.steps} 步`,
    })
  }

  if (expect.approvalAsked === true && observations.approvals === 0) {
    failures.push({ kind: 'expectation', message: '应当问人一次，但它没问' })
  }
  if (expect.noApproval === true && observations.approvals > 0) {
    failures.push({ kind: 'expectation', message: `不该问人，但它问了 ${observations.approvals} 次` })
  }

  return failures
}

/** 一件事：跑完一个场景后的全部失败 */
export function checkAll(scenario: Scenario, observations: Observations): Failure[] {
  return [...checkInvariants(observations), ...checkExpectations(scenario, observations)]
}
