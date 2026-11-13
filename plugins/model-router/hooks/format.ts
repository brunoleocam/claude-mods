import type { Est, Footer, Range, Tier } from '../types'

// Semáforo: verde = razoável, laranja = intermediário, vermelho = muito.
export const COLOR = {
  ok: '#22c55e',
  mid: '#f59e0b',
  high: '#ef4444',
  warn: '#eab308',
} as const
export type Level = 'ok' | 'mid' | 'high'

const level = (v: number, okMax: number, midMax: number): Level => (v <= okMax ? 'ok' : v <= midMax ? 'mid' : 'high')

export const outLevel = (tokens: number) => level(tokens, 8_000, 30_000)
export const timeLevel = (seconds: number) => level(seconds, 120, 600)
export const ctxLevel = (tokens: number, window: number) => level(window > 0 ? tokens / window : 0, 0.3, 0.6)
export const quotaLevel = (delta: number) => level(delta, 1, 5)
export const costLevel = (usd: number) => level(usd, 0.1, 0.5)
/** Cache: verde com mais da metade do prazo, laranja até 15%, vermelho abaixo. */
export const cacheLevel = (leftMs: number, ttlMs: number): Level =>
  leftMs <= 0 ? 'high' : leftMs / ttlMs >= 0.5 ? 'ok' : leftMs / ttlMs >= 0.15 ? 'mid' : 'high'

export function tierOf(model: string): Tier | null {
  const m = model.toLowerCase().match(/fable|opus|sonnet|haiku/)
  return m ? (m[0] as Tier) : null
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function prettyModel(model: string): string {
  const m = model.toLowerCase().match(/(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/)
  if (!m || !m[1]) {
    const t = tierOf(model)
    return t ? cap(t) : model
  }
  return m[3] ? `${cap(m[1])} ${m[2]}.${m[3]}` : `${cap(m[1])} ${m[2]}`
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function fmtSeconds(s: number): string {
  s = Math.round(s)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r === 0 || m >= 10 ? `${m}min` : `${m}m${String(r).padStart(2, '0')}s`
}

export const fmtRange = (r: Range, f: (n: number) => string) => `${f(r[0])}–${f(r[1])}`

/** Onde o valor real caiu em relação à faixa estimada. */
export type Hit = 'in' | 'over' | 'under'
export const hitOf = (actual: number, r: Range): Hit => (actual > r[1] ? 'over' : actual < r[0] ? 'under' : 'in')

/** Verde: dentro da faixa. Laranja: errou por menos de 2x. Vermelho: errou por mais. */
export function hitLevel(actual: number, r: Range): Level {
  const h = hitOf(actual, r)
  if (h === 'in') return 'ok'
  const off = h === 'over' ? actual / Math.max(r[1], 1) : Math.max(r[0], 1) / Math.max(actual, 1)
  return off < 2 ? 'mid' : 'high'
}

export type FooterPart = { text: string; level?: Level | 'warn'; isBold?: boolean }

const trim1 = (n: number) => n.toFixed(1).replace(/\.0$/, '')

function estPart(actual: number, r: Range, f: (n: number) => string): FooterPart {
  const h = hitOf(actual, r)
  return { text: `est ${fmtRange(r, f)} ${h === 'in' ? '✓' : h === 'over' ? '↑' : '↓'}`, level: hitLevel(actual, r) }
}

/** O rodapé em partes coloridas; `footerLine` junta as mesmas partes em texto. */
export function footerParts(f: Footer): FooterPart[] {
  const seconds = f.durationMs / 1000
  const est: Est | null = f.isAborted ? null : f.est
  const parts: FooterPart[] = [
    { text: prettyModel(f.model) + (f.effort ? ` · ${f.effort}` : ''), isBold: true },
    { text: '⏱ ' + fmtSeconds(seconds) + (f.isAborted ? ' (interrompido)' : ''), level: timeLevel(seconds) },
  ]
  if (est) parts.push(estPart(seconds, est.sec, fmtSeconds))
  const cache = f.cacheRead + f.cacheWrite
  parts.push({ text: `in ${fmtTokens(f.input)}${cache > 0 ? ` +${fmtTokens(cache)} cache` : ''}` })
  parts.push({ text: `↗ out ${fmtTokens(f.output)}`, level: outLevel(f.output) })
  if (est) parts.push(estPart(f.output, est.out, fmtTokens))
  if (f.fiveHour) {
    const { before, after } = f.fiveHour
    const delta = before === null ? null : Math.max(0, after - before)
    parts.push(
      delta === null
        ? { text: `5h ${after}%` }
        : { text: `5h +${trim1(delta)}% (${after}%)`, level: quotaLevel(delta) },
    )
  }
  if (f.usdDelta !== null && f.usdDelta > 0) {
    parts.push({
      text: `$${f.usdDelta < 0.01 ? f.usdDelta.toFixed(3) : f.usdDelta.toFixed(2)}`,
      level: costLevel(f.usdDelta),
    })
  }
  if (f.hint) parts.push({ text: `⇄ ${cap(f.hint.model)} · ${f.hint.effort}`, level: 'warn' })
  return parts
}

export function footerLine(f: Footer): string {
  return footerParts(f)
    .map(p => p.text)
    .join(' · ')
}
