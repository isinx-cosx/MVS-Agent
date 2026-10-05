/**
 * CLI 文本样式层 —— **当前实现是不着色。**
 *
 * CLI 输出刻意不做 ANSI 着色，三个理由：
 *
 * 1. 管道 / 重定向 / CI 日志里 ANSI 只会变成噪音或乱码
 * 2. **真正的界面是客户端**，它渲染的是 markdown 原文；CLI 只需要是朴素文本视图
 * 3. 少一层「这份输出是给终端还是给文件」的分支
 *
 * 保留这些语义化的名字而不是把调用点全部拆掉，是因为它们描述的是
 * **这段文字是什么**（次要信息 / 错误 / 成功），不是**它长什么样**。
 * 哪天真要加回颜色，改这一个文件就够，161 个调用点一行不用动。
 */

export const dim = (text: string): string => text
export const bold = (text: string): string => text
export const green = (text: string): string => text
export const red = (text: string): string => text
export const yellow = (text: string): string => text
export const cyan = (text: string): string => text
