/**
 * 列出**我这次探针跑出来**的会话，方便报告/清理。
 *
 * 判据：标题还是默认的「新会话」且创建时间落在探针那个窗口里。
 * 用户自己建的会话不会恰好落在这个窗口，所以不会误伤。
 */
const ORIGIN = process.env.MVS_ORIGIN ?? 'http://127.0.0.1:3092'
const since = Number(process.argv[2] ?? 0)

const state = await (await fetch(`${ORIGIN}/state`)).json()
const mine = state.state.sessions.filter((s) => Date.parse(s.createdAt) >= since)

console.log(`窗口起点 ${new Date(since).toISOString()}，落在里面的会话 ${mine.length} 个：`)
for (const s of mine) {
  console.log(`  ${s.sessionId}  turn=${s.turn}  ${s.createdAt}  ${JSON.stringify(s.title)}`)
}
console.log('\n清理用的命令（守护进程自己会把目录移到 trash/sessions，可恢复）：')
console.log(
  JSON.stringify(
    mine.map((s) => ({ type: 'delete_session', sessionId: s.sessionId })),
  ),
)
