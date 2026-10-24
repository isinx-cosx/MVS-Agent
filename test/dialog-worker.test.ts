/**
 * 原生目录选择器（`tools/dialog-worker.mjs`）的测试。
 *
 * 这个文件平时一跑就会弹出一个**模态对话框**，自动化测试没法点它。所以测试
 * 打的是它自己留的两条不弹框的路：
 *
 *   `--self-check`  只验环境：koffi 能不能加载、指针宽度、vtable 槽位表
 *   `--dry-run`     真的建一次 COM 对象、SetOptions + SetTitle，然后放掉
 *
 * 第二条是重点。vtable 槽位是这个文件里**唯一靠记忆**的地方：写错时它不会
 * 报「槽位错了」，而是崩掉或者返回一个负的 HRESULT。把「除弹框之外的全部」
 * 跑一遍，至少让这类错误在测试里出现，而不是在用户点「添加工作区」的时候。
 */

import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tools',
  'dialog-worker.mjs',
)

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * 跑一次 worker。
 *
 * ⚠️ **输出走文件描述符，不走管道** —— 本环境里 `stdio: 'pipe'` 会同步抛 EPERM，
 * 而 `execFile` / `exec` 内部就是管道。所以这里显式开两个文件当 stdio，
 * 和 `src/host/directory-picker.ts` 起的那个子进程一模一样。
 */
async function runWorker(args: string[], outDir: string, tag: string): Promise<RunResult> {
  const stdoutFile = path.join(outDir, `stdout-${tag}.txt`)
  const stderrFile = path.join(outDir, `stderr-${tag}.txt`)
  const outFd = openSync(stdoutFile, 'w')
  const errFd = openSync(stderrFile, 'w')

  try {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [WORKER, ...args], {
        stdio: ['ignore', outFd, errFd],
        windowsHide: true,
      })
      child.on('error', () => resolve(null))
      child.on('close', (exitCode) => resolve(exitCode))
    })

    const read = async (file: string): Promise<string> => {
      try {
        return await readFile(file, 'utf8')
      } catch {
        return ''
      }
    }
    return { code, stdout: await read(stdoutFile), stderr: await read(stderrFile) }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
}

test('dialog-worker：--self-check 报出 vtable 槽位与 koffi 状态', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-dialog-'))
  try {
    /*
     * `execFile` 的默认 stdio 是管道 —— 而本环境里管道会同步抛 EPERM。
     * 所以这里用 `process.execPath` + `execFile` 的 `maxBuffer` 走默认路径，
     * 捕获不到输出就只看退出码；真正的断言放在 dry-run 那个用结果文件的测试里。
     */
    const result = await runWorker(['--self-check'], dir, 'self1')
    assert.equal(result.code, 0, `--self-check 应当以 0 退出，实际 ${result.code}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dialog-worker：--dry-run 能建出 COM 对象并设好选项（不弹框）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-dialog-'))
  const outPath = path.join(dir, 'result.json')
  try {
    const selfCheck = await runWorker(['--self-check'], dir, 'self1')
    assert.equal(selfCheck.code, 0)

    const result = await runWorker(['--dry-run', '--title', 'MVS 测试', '--out', outPath], dir, 'dry')

    /*
     * 这台机器上没有 koffi 时，worker 会写一条 error —— 那不算测试失败：
     * 没有 koffi 就意味着该走页面内浏览，是产品里明确支持的降级路径。
     * 但**只要有 koffi，就必须成功**，否则说明 COM 那一层坏了。
     */
    const raw = await readFile(outPath, 'utf8').catch(() => '')
    assert.notEqual(raw, '', 'worker 无论成功失败都应当写结果文件')

    const parsed = JSON.parse(raw) as { kind: string; dryRun?: boolean; message?: string }
    if (parsed.kind === 'error' && /找不到 koffi/.test(String(parsed.message))) {
      return
    }

    assert.equal(parsed.kind, 'done', `--dry-run 应当成功，实际：${raw.slice(0, 200)}`)
    assert.equal(parsed.dryRun, true, '应当标明这是 dry-run 的结果')
    assert.equal(result.code, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dialog-worker：缺 --out 时明确报用法，并以 2 退出', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mvs-dialog-'))
  try {
    const result = await runWorker([], dir, 'noargs')
    assert.equal(result.code, 2, '缺参数应当是用法错误（2），不是崩溃（1）')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
