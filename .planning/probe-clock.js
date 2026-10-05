(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const t0 = Date.now()
  const p0 = performance.now()
  let n = 0
  for (let i = 0; i < 20; i += 1) {
    await sleep(500)
    n += 1
  }
  return {
    sleep次数: n,
    名义等待毫秒: n * 500,
    Date差毫秒: Date.now() - t0,
    performance差毫秒: Math.round(performance.now() - p0),
    结论: '若 performance 差 << 名义等待，说明虚拟时钟在快进 setTimeout',
  }
})()
