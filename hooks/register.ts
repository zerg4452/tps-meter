import type { Register } from 'claude-code'

const fmt = (ms: number) => {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${(ms / 1000).toFixed(1)}s`
}

export const register: Register = on => {
  let turnStart = 0
  let lastTps = ''

  on('prompt.submit', async ($, e, next) => {
    turnStart = await $.clock.now()
    lastTps = ''
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const start = await $.clock.now()
    let chars = 0
    let lastDraw = 0
    let outTokens = 0

    const stream = next(e)
    let step = await stream.next()
    while (!step.done) {
      const c = step.value
      if (c.kind === 'text' || c.kind === 'thinking') {
        chars += c.text.length
        const now = await $.clock.now()
        if (now - lastDraw > 250 && now - start > 300) {
          lastDraw = now
          const tps = chars / 4 / ((now - start) / 1000)
          lastTps = `~${tps.toFixed(1)} t/s`
          $.ui.status(`⚡ ${lastTps} · ⏱ ${fmt(now - (turnStart || start))}`)
        }
      } else if (c.kind === 'stop' && c.usage) {
        outTokens = c.usage.output_tokens ?? 0
      }
      yield c
      step = await stream.next()
    }

    const secs = ((await $.clock.now()) - start) / 1000
    if (outTokens > 0 && secs > 0) {
      lastTps = `${(outTokens / secs).toFixed(1)} t/s`
    }
    return step.value
  })

  on('turn.complete', async ($, e, next) => {
    if (turnStart) {
      const total = fmt((await $.clock.now()) - turnStart)
      $.ui.status(`${lastTps ? `⚡ ${lastTps} · ` : ''}⏱ 총 ${total}`)
    }
    return next(e)
  })
}
