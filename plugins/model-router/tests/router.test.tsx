import { expect, mock, test } from 'claude-code/testing'

import { accuracy, buildAnalysisPrompt, clipboardText, parseVerdict } from '../hooks/analyze'
import { cacheLevel, footerLine, footerParts, hitLevel, prettyModel } from '../hooks/format'
import type { Footer, LogEntry, Verdict } from '../types'

const BAND = {
  plugin: 'model-router',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const REPLY = {
  adequate: false,
  best_model: 'sonnet',
  best_effort: 'medium',
  confidence: 0.9,
  reason: 'bug bem delimitado, sem necessidade de raciocínio profundo',
  est: { output_tokens: [2000, 6000], seconds: [20, 70] },
  summary: 'Estamos corrigindo o login.',
  refined_prompt: 'Corrija o erro de sessão em auth.ts e rode os testes.',
}

test('a resposta da análise é lida, com ou sem cerca de código', async () => {
  const v = parseVerdict('```json\n' + JSON.stringify(REPLY) + '\n```')
  expect(v).toMatchObject({ adequate: false, model: 'sonnet', effort: 'medium', confidence: 0.9 })
  expect(v?.est).toEqual({ out: [2000, 6000], sec: [20, 70] })
  expect(parseVerdict('não sei')).toBe(null)
  expect(parseVerdict(JSON.stringify({ ...REPLY, best_model: 'gpt' }))).toBe(null)
  expect(parseVerdict(JSON.stringify({ ...REPLY, est: {} }))?.est).toBe(null)
  expect(
    buildAnalysisPrompt({ text: 'oi', model: 'Opus 5.5', effort: 'medium', ctxTokens: 10, ctxWindow: 100, cacheMinLeft: 5 }),
  ).toContain('Opus 5.5 · esforço medium')
})

test('o texto copiado traz o resumo e o pedido refinado', async () => {
  const v = parseVerdict(JSON.stringify(REPLY)) as Verdict
  expect(clipboardText(v, 'x')).toBe(
    '## Contexto da conversa até aqui\nEstamos corrigindo o login.\n\n## Pedido\nCorrija o erro de sessão em auth.ts e rode os testes.',
  )
  expect(clipboardText({ ...v, summary: '', refined: '' }, ' original ')).toBe('original')
})

test('a precisão compara a estimativa com o gasto real', async () => {
  const mk = (id: string, outTok: number, secs: number, action: LogEntry['action'] = 'sent'): LogEntry => ({
    id,
    at: 0,
    promptChars: 100,
    model: 'claude-opus-5-5',
    effort: 'medium',
    action,
    analysis: { ok: true, ms: 4000, inTok: 500, outTok: 300, viaFork: true },
    verdict: parseVerdict(JSON.stringify({ ...REPLY, adequate: true })),
    actual: { outTok, inTok: 10, cacheRead: 1000, cacheWrite: 0, ms: secs * 1000, model: 'claude-opus-5-5', effort: 'medium' },
  })
  // estimativa: 2k–6k tokens e 20–70 s
  const a = accuracy([mk('1', 3000, 40), mk('2', 9000, 30), mk('3', 1000, 200, 'overridden'), { ...mk('4', 1, 1), actual: null }])
  expect(a.n).toBe(3)
  expect([a.outIn, a.outOver, a.outUnder]).toEqual([1, 1, 1])
  expect([a.secIn, a.secOver, a.secUnder]).toEqual([1, 1, 1].map((_, i) => [2, 1, 0][i]))
  expect(a.overridden).toBe(1)
  expect(a.analysisMs).toBe(4000)
  expect(hitLevel(3000, [2000, 6000])).toBe('ok')
  expect(hitLevel(9000, [2000, 6000])).toBe('mid')
  expect(hitLevel(20000, [2000, 6000])).toBe('high')
})

test('o rodapé mostra o gasto real ao lado da estimativa', async () => {
  expect(prettyModel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  const f: Footer = {
    model: 'claude-opus-5-5',
    effort: 'medium',
    durationMs: 54_000,
    input: 12,
    cacheRead: 36000,
    cacheWrite: 2000,
    output: 3100,
    fiveHour: { before: 38.7, after: 41 },
    usdDelta: 0.184,
    isAborted: false,
    est: { out: [2000, 6000], sec: [20, 40] },
    hint: { model: 'sonnet', effort: 'medium' },
  }
  expect(footerLine(f)).toBe(
    'Opus 5.5 · medium · ⏱ 54s · est 20s–40s ↑ · in 12 +38k cache · ↗ out 3.1k · est 2k–6k ✓ · 5h +2.3% (41%) · $0.18 · ⇄ Sonnet · medium',
  )
  expect(footerParts(f).filter(p => p.text.startsWith('est')).map(p => p.level)).toEqual(['mid', 'ok'])
  expect(cacheLevel(0, 1)).toBe('high')
})

test('um prompt que rende melhor em outro modelo é retido, refinado e copiado', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  const copied: string[] = []
  on('command.register', () => ({ value: { command: 'router' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surface', () => ({ value: 'desktop' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 45000, window: 1_000_000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.copy', (_, e) => (copied.push(e.text), { value: { isCopied: true } }))
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: JSON.stringify(REPLY),
      usage: { input_tokens: 400, output_tokens: 250, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 },
    },
  }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.prompt.submit({ text: 'Corrija o bug de sessão que expira cedo demais no login, por favor' } as never)

  expect('drop' in r && r.drop).toMatch(/Sonnet · medium/)
  expect(copied).toHaveLength(1)
  expect(copied[0]).toContain('## Contexto da conversa até aqui')

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Melhor em/ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeDefined()
  expect(await ui.find({ key: 'recopy' })).toBeDefined()
  await ui.unmount()

  // um prompt curto segue sem análise
  const ok = await $.prompt.submit({ text: 'sim, continua' } as never)
  expect('drop' in ok).toBe(false)
})

test('sem prompt retido a faixa mostra só contexto e cache', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'router' } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 248000, window: 1_000_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /248k/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Cache ·/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Melhor em/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('o rodapé colorido é desenhado na conversa', async ($, on) => {
  on('state.get', (_, e) => ({
    value: {
      value:
        e.key === 'footers'
          ? {
              f_abc: {
                model: 'claude-opus-5-5',
                effort: 'medium',
                durationMs: 54_000,
                input: 12,
                cacheRead: 1_100_000,
                cacheWrite: 0,
                output: 3100,
                fiveHour: { before: 16, after: 18 },
                usdDelta: 0.32,
                isAborted: false,
                est: { out: [2000, 6000], sec: [20, 70] },
                hint: null,
              },
            }
          : undefined,
      version: 1,
    },
  }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'model-router',
      component: 'Placed',
      surface,
      requestId: 'f_abc',
      props: { id: 'f_abc', plugin: 'model-router', view: {} },
    } as never)
    expect(await ui.find({ type: 'Text', text: /Opus 5.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /est 2k–6k ✓/ })).toBeDefined()
    await ui.unmount()
  }
})
