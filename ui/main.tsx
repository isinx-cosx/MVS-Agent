/**
 * 挂载点。
 *
 * ⚠️ **刻意不用 `StrictMode`。** 它在开发模式下会把 effect 跑两遍，而我们的启动
 * effect 会**建一个会话** —— 双跑就是每次打开页面多出一个空会话。
 * （这也是为什么 `build-ui.mjs` 里把 `NODE_ENV` 定成 `development`：要 React 的
 * 警告，但不要 StrictMode 的副作用。）
 *
 * ## 为什么这里要装一个全局错误显示
 *
 * 渲染期抛错时，React 会**把整棵树卸掉** —— 页面变成一片空白，而且不留任何痕迹。
 * 我们正好撞上过：白屏、资源都是 200、代码也在产物里，就是什么都没有，而我在
 * 浏览器外面看不到控制台。**一片白比一行红字难查得多。**
 *
 * 所以：任何未捕获的错误/未处理的 Promise 失败，都直接写进页面。
 * 这不是调试开关 —— 它是"失败必须显形"这条规矩在界面上的落地（本地应用，
 * 用户就是开发者，把原因摆出来永远比留白有用）。
 */

import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import './styles.css'

const container = document.getElementById('root')
if (container === null) throw new Error('页面缺少 #root 挂载点')

function showFailure(title: string, detail: string): void {
  /* 用 textContent 而不是 innerHTML：错误信息来自外部，不该被当成标记解析 */
  const box = document.createElement('div')
  box.className = 'crash'
  const head = document.createElement('div')
  head.className = 'crash-title'
  head.textContent = title
  const body = document.createElement('pre')
  body.className = 'crash-detail'
  body.textContent = detail
  box.append(head, body)
  document.body.append(box)
}

window.addEventListener('error', (event) => {
  showFailure('界面出错了', event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  showFailure('有一个操作失败了', reason instanceof Error ? reason.stack ?? reason.message : String(reason))
})

createRoot(container).render(<App />)
