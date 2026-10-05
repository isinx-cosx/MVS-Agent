/**
 * 投影测试：从事件流推导客户端要看的视图。
 *
 * 单独一个文件，因为这里的正确性标准和执行层**不一样**。
 *
 * 执行层要回答的是「我能不能把文件恢复回去」，投影层要回答的是
 * 「界面上那个按钮该写『撤销』还是『重做』，该不该点得动」。
 * 后者错了不会损坏任何文件，但会让人**按下一个说谎的按钮** ——
 * 用户以为文件回去了，实际没有。所以这里的每条规则都要单独钉住。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { foldToolCall, rebuildToolCalls } from '../src/protocol/projection.ts'
import type { HostEvent, ToolCallRecord } from '../src/protocol/types.ts'

// ---------------------------------------------------------------------------
// 构造事件的小工具
// ---------------------------------------------------------------------------

function settled(callId: string, recoveryTxnId?: string): HostEvent {
  return {
    type: 'tool_settled',
    callId,
    tool: 'write_file',
    ok: true,
    content: 'ok',
    summary: '写了 a.txt',
    ...(recoveryTxnId === undefined ? {} : { recoveryTxnId }),
  }
}

function reverting(
  txnId: string,
  options: {
    ok?: boolean
    restoreTxnId?: string | null
    skipped?: Array<{ path: string; reason: string }>
  } = {},
): HostEvent {
  return {
    type: 'revert_settled',
    txnId,
    restoreTxnId: options.restoreTxnId === undefined ? `txn-restore-${txnId}` : options.restoreTxnId,
    ok: options.ok ?? true,
    message: '',
    restored: [],
    deleted: [],
    skipped: options.skipped ?? [],
    notCovered: [],
  }
}

function fold(events: HostEvent[]): ToolCallRecord[] {
  return rebuildToolCalls(events)
}

// ---------------------------------------------------------------------------
// 记录表
// ---------------------------------------------------------------------------

test('每次工具结算都留一条记录，没动文件的工具也要有', () => {
  const records = fold([
    settled('c1', 'txn-1'),
    { type: 'tool_settled', callId: 'c2', tool: 'read_file', ok: true, content: 'hi', summary: '读了 a.txt' },
  ])

  assert.equal(records.length, 2, '读文件也要有卡片 —— 它是「模型看过什么」的证据')
  assert.equal(records[0]?.undoTxnId, 'txn-1')
  assert.equal(
    records[1]?.undoTxnId,
    null,
    '读文件没有事务：卡片照画，但没有撤销按钮',
  )
  assert.equal(records[1]?.ok, true)
  assert.equal(records[1]?.summary, '读了 a.txt')
})

test('没结算的工具调用不进记录表 —— 它属于「状态未知」那条分支', () => {
  const records = fold([{ type: 'tool_intent', callId: 'c1', tool: 'write_file', argsJson: '{}' }])
  assert.deepEqual(records, [])
})

// ---------------------------------------------------------------------------
// 撤销状态机：撤销、重做
// ---------------------------------------------------------------------------

test('撤销之后状态翻转，并且指向新事务 —— 重做不是重复撤销同一个', () => {
  const records = fold([settled('c1', 'T'), reverting('T', { restoreTxnId: 'R' })])

  assert.equal(records[0]?.reverted, true)
  assert.equal(
    records[0]?.undoTxnId,
    'R',
    '要翻回去现在该撤 R（撤销动作自身也是一个事务），而不是再撤一次 T',
  )
})

test('再撤一次就是把状态翻回来（重做）', () => {
  const records = fold([
    settled('c1', 'T'),
    reverting('T', { restoreTxnId: 'R' }),
    reverting('R', { restoreTxnId: 'R2' }),
  ])

  assert.equal(records[0]?.reverted, false)
  assert.equal(records[0]?.undoTxnId, 'R2')
})

test('来回多次也能正确落在某一边', () => {
  const records = fold([
    settled('c1', 'T'),
    reverting('T', { restoreTxnId: 'R' }),
    reverting('R', { restoreTxnId: 'R2' }),
    reverting('R2', { restoreTxnId: 'R3' }),
  ])

  assert.equal(records[0]?.reverted, true)
  assert.equal(records[0]?.undoTxnId, 'R3')
})

// ---------------------------------------------------------------------------
// 关键规则：部分成功不算翻转
// ---------------------------------------------------------------------------

test('★ 撤销部分成功时**不**翻转状态 —— 否则按钮会说谎', () => {
  const records = fold([
    settled('c1', 'T'),
    reverting('T', {
      ok: true,
      restoreTxnId: 'R',
      // 有的文件之后被人改过，恢复层拒绝覆盖它
      skipped: [{ path: 'b.txt', reason: 'conflict' }],
    }),
  ])

  assert.equal(
    records[0]?.reverted,
    false,
    '文件停在中间状态：既不是改完了也不是没改过。标成「已撤销」会让用户以为文件回去了',
  )
  assert.equal(
    records[0]?.undoTxnId,
    'T',
    '还能再试一次（比如之后带 force），所以仍指向原来那个事务',
  )
})

test('撤销失败（ok=false）同样不翻转', () => {
  const records = fold([settled('c1', 'T'), reverting('T', { ok: false, restoreTxnId: null })])

  assert.equal(records[0]?.reverted, false)
  assert.equal(records[0]?.undoTxnId, 'T')
})

test('撤销没能为恢复本身建事务时，翻转但不再可撤（不是假装还能翻回去）', () => {
  const records = fold([settled('c1', 'T'), reverting('T', { restoreTxnId: null })])

  assert.equal(records[0]?.reverted, true)
  assert.equal(
    records[0]?.undoTxnId,
    null,
    '拿不到新事务就说明翻不回去了，必须如实说「没有可用事务」，而不是留一个点不动的按钮',
  )
})

test('撤销一条不存在的记录不会凭空造出一条', () => {
  const records = fold([settled('c1', 'T'), reverting('不知道自己是谁')])
  assert.equal(records.length, 1)
  assert.equal(records[0]?.reverted, false)
})

// ---------------------------------------------------------------------------
// 与「在线折叠」的一致性
// ---------------------------------------------------------------------------

test('★ 逐条折叠与一次性重建的结果完全相同', () => {
  // 这条是整层的核心保证：「一直在线的界面」和「刚刷新的界面」必须一模一样。
  // 不一致就是 Claude Code #34368 那类 bug（界面给了撤销，但状态对不上）。
  const events: HostEvent[] = [
    settled('c1', 'T1'),
    settled('c2'),
    reverting('T1', { restoreTxnId: 'R1' }),
    settled('c3', 'T2'),
    reverting('T2', { restoreTxnId: 'R2' }),
    reverting('R2', { restoreTxnId: 'R3' }),
  ]

  const batch = rebuildToolCalls(events)

  const incremental: ToolCallRecord[] = []
  for (const event of events) foldToolCall(incremental, event)

  assert.deepEqual(incremental, batch)
})
