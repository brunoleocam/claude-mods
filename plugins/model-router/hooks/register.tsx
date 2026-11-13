import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Footer, Held, LogEntry, Mode, Verdict } from '../types'
import { MIN_CHARS, MIN_CONFIDENCE, accuracy, buildAnalysisPrompt, clipboardText, parseVerdict } from './analyze'
import {
  COLOR,
  cacheLevel,
  ctxLevel,
  fmtSeconds,
  fmtTokens,
  footerParts,
  prettyModel,
  tierOf,
} from './format'

const mode = atom({ plugin: 'model-router', key: 'mode' } as const, 'on')
const held = atom({ plugin: 'model-router', key: 'held' } as const, null)
const currentModel = atom({ plugin: 'model-router', key: 'currentModel' } as const, '')
const currentEffort = atom({ plugin: 'model-router', key: 'currentEffort' } as const, null)
const footers = atom({ plugin: 'model-router', key: 'footers' } as const, {})
const lastActivity = atom({ plugin: 'model-router', key: 'lastActivity' } as const, null)
const tick = atom({ plugin: 'model-router', key: 'tick' } as const, 0)

// Quanto o prompt cache dura depois da última requisição. A API padrão guarda
// 5 min; sessões com cache estendido guardam 60. Ajuste aqui se for o caso.
const CACHE_TTL_MS = 60 * 60 * 1000
const MAX_LOG = 400
const LOG_KEY = 'log2'

const fmtMinutes = (ms: number) => (ms < 60_000 ? '<1m' : `${Math.floor(ms / 60_000)}m`)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

async function logFilePath($: EngineInterface): Promise<string | null> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home.replace(/[\\/]+$/, '')}/.claude/model-router-log.json` : null
}

/** Chama o modelo atual sobre a conversa (cache compartilhado); sem conversa, o Opus em medium. */
async function analyze($: EngineInterface, prompt: string) {
  const forked = await $.model.fork({ prompt })
  if (forked.isAnswered || forked.reason !== 'nothing-to-fork') return { r: forked, viaFork: true }
  return { r: await $.model.complete({ model: 'opus', effort: 'medium', maxTokens: 4000, prompt }), viaFork: false }
}

// Estado do módulo (recomeça a cada reload).
let log: LogEntry[] | null = null
let cur: LogEntry | null = null // o prompt em andamento, à espera do resultado real
let bypassId: string | null = null // o envio que o usuário liberou com "Enviar assim mesmo"
let turnEffort: string | null = null
let fiveHourBefore: number | null = null
let usdBefore: number | null = null

async function getLog($: EngineInterface) {
  if (log === null) log = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
  return log
}

async function saveLog($: EngineInterface) {
  const entries = await getLog($)
  log = entries.slice(-MAX_LOG)
  await $.store.set(LOG_KEY, log)
  try {
    const path = await logFilePath($)
    if (path !== null) await $.fs.write(path, JSON.stringify(log, null, 1))
  } catch {
    // o log também vive no armazenamento do mod; o arquivo é só uma cópia para leitura
  }
}

async function sendHeld($: EngineInterface) {
  const h = await read($, held)
  if (h === null) return false
  bypassId = h.entryId
  await update($, held, () => null)
  await $.prompt.submit({ text: h.text, asUser: true })
  return true
}

async function recopy($: EngineInterface) {
  const h = await read($, held)
  if (h === null) return
  const surface = await $.session.surface()
  const r = await $.ui.copy({ text: h.clip, ...(surface ? { surface } : {}) })
  await update($, held, () => ({ ...h, isCopied: r.isCopied }))
  $.ui.toast(r.isCopied ? 'Prompt refinado copiado.' : 'Não consegui copiar para a área de transferência.')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = await $.store.get('mode')
    if (saved === 'on' || saved === 'off') await update($, mode, () => saved as Mode)
    await update($, currentModel, () => '')
    // Atualiza a contagem regressiva do cache na faixa.
    $.clock.every(30_000, () => void update($, tick, n => n + 1))
    await $.command.register({
      name: 'router',
      description: 'Model router: /router on | off | log | export | send | reset',
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || (await read($, mode)) === 'off') return next(e)

    const sessionModel = await $.session.model()
    const effort = await read($, currentEffort)
    const now = await $.clock.now()

    // O usuário liberou este envio: não analisa de novo, só acompanha o resultado.
    if (bypassId !== null) {
      const entries = await getLog($)
      const entry = entries.find(x => x.id === bypassId)
      bypassId = null
      if (entry) {
        entry.action = 'overridden'
        cur = entry
        await saveLog($)
      }
      return next(e)
    }

    const text = e.text.trim()
    if (text.length < MIN_CHARS) return next(e)

    // 1. Analisa o prompt com o modelo atual, sobre a conversa.
    $.ui.status('Router: analisando o prompt…')
    const usage = await $.session.usage()
    const lastAt = await read($, lastActivity)
    const cacheMinLeft = lastAt === null ? null : Math.floor((lastAt + CACHE_TTL_MS - now) / 60_000)
    const t0 = now
    let reply: Awaited<ReturnType<typeof analyze>> | null = null
    try {
      reply = await analyze($, buildAnalysisPrompt({
        text,
        model: prettyModel(sessionModel),
        effort,
        ctxTokens: usage.context.tokens ?? 0,
        ctxWindow: usage.context.window,
        cacheMinLeft,
      }))
    } catch {
      reply = null
    }
    $.ui.status(undefined)
    const ms = (await $.clock.now()) - t0
    const ok = reply !== null && reply.r.isAnswered
    const verdict: Verdict | null = reply !== null && reply.r.isAnswered ? parseVerdict(reply.r.text) : null

    const entry: LogEntry = {
      id: `${now}`,
      at: now,
      promptChars: text.length,
      model: sessionModel,
      effort,
      action: 'sent',
      analysis: {
        ok: ok && verdict !== null,
        ms,
        inTok: reply?.r.usage.input_tokens ?? 0,
        outTok: reply?.r.usage.output_tokens ?? 0,
        viaFork: reply?.viaFork ?? false,
      },
      verdict,
      actual: null,
    }

    // 2. Serve? Segue o fluxo. A análise que falhou também deixa o prompt passar.
    const differs =
      verdict !== null &&
      (tierOf(sessionModel) !== verdict.model || (effort !== null && effort !== verdict.effort))
    const shouldHold = verdict !== null && !verdict.adequate && differs && verdict.confidence >= MIN_CONFIDENCE
    if (!shouldHold || verdict === null) {
      cur = entry
      ;(await getLog($)).push(entry)
      await saveLog($)
      return next(e)
    }

    // 3. Interrompe: refina, copia e orienta a abrir um novo chat.
    const clip = clipboardText(verdict, text)
    const surface = await $.session.surface()
    const copied = await $.ui.copy({ text: clip, ...(surface ? { surface } : {}) })
    entry.action = 'held'
    ;(await getLog($)).push(entry)
    await saveLog($)
    const h: Held = {
      entryId: entry.id,
      text: e.text,
      clip,
      model: verdict.model,
      effort: verdict.effort,
      reason: verdict.reason,
      isCopied: copied.isCopied,
    }
    await update($, held, () => h)
    return {
      drop:
        `Router: este prompt rende melhor em ${cap(verdict.model)} · ${verdict.effort} (${verdict.reason}). ` +
        (copied.isCopied
          ? 'O prompt refinado, com o resumo da conversa, foi copiado: abra um novo chat, selecione o modelo e cole. '
          : 'Não consegui copiar o prompt refinado; use o botão "Copiar" acima do prompt. ') +
        'Para enviar aqui mesmo assim, use o botão acima do prompt ou /router send.',
    }
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    turnEffort = null
    const u = await $.session.usage()
    fiveHourBefore = u.rateLimits.find(r => r.kind === 'five_hour')?.percentUsed ?? null
    usdBefore = u.cost?.usd ?? null
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    if (e.index === 0) {
      turnEffort = e.effort === undefined ? null : String(e.effort)
      await update($, currentEffort, () => turnEffort)
    }
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || !e.usage) return r

    const usage = e.usage
    const nowMs = await $.clock.now()
    const u = await $.session.usage()
    const five = u.rateLimits.find(l => l.kind === 'five_hour')
    const usdAfter = u.cost?.usd ?? null

    // Fecha a linha do log com o que o prompt gastou de verdade.
    const entry = cur
    cur = null
    if (entry !== null && !e.isAborted) {
      entry.actual = {
        outTok: usage.output_tokens,
        inTok: usage.input_tokens,
        cacheRead: usage.cache_read_input_tokens,
        cacheWrite: usage.cache_creation_input_tokens,
        ms: e.durationMs,
        model: usage.model,
        effort: turnEffort,
      }
      await saveLog($)
    }

    const v = entry?.verdict ?? null
    const footer: Footer = {
      model: usage.model,
      effort: turnEffort,
      durationMs: e.durationMs,
      input: usage.input_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      output: usage.output_tokens,
      fiveHour: five ? { before: fiveHourBefore, after: five.percentUsed } : null,
      usdDelta: usdAfter !== null && usdBefore !== null ? usdAfter - usdBefore : null,
      isAborted: e.isAborted,
      est: v?.est ?? null,
      hint: entry?.action === 'overridden' && v !== null ? { model: v.model, effort: v.effort } : null,
    }

    await update($, lastActivity, () => nowMs)
    await update($, currentModel, () => usage.model)

    // O rodapé vira uma linha própria na conversa, desenhada com cores.
    const id = `f_${e.turnId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)}`
    await update($, footers, all => ({ ...Object.fromEntries(Object.entries(all).slice(-49)), [id]: footer }))
    try {
      await $.ui.place({ id })
    } catch {
      // sem superfície que desenhe a linha: o log continua valendo
    }
    return r
  })

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    if (e.props.plugin !== 'model-router') return next(e)
    const f = (await read($, footers))[e.props.id]
    if (!f) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" flexWrap="wrap">
        {footerParts(f).map(p => (
          <Text
            bold={p.isBold === true}
            dimColor={p.level === undefined && p.isBold !== true}
            {...(p.level === undefined ? {} : { color: COLOR[p.level] })}
          >
            {p.text}
            {'   '}
          </Text>
        ))}
      </Box>
    )
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      const m: Mode = arg
      await update($, mode, () => m)
      await $.store.set('mode', m)
      return { text: `Model router: análise dos prompts ${arg === 'on' ? 'ligada' : 'desligada'}.` }
    }
    if (arg === 'send') {
      return { text: (await sendHeld($)) ? 'Enviando o prompt retido.' : 'Não há prompt retido.' }
    }
    if (arg === 'reset') {
      log = []
      await $.store.set(LOG_KEY, [])
      await update($, held, () => null)
      return { text: 'Model router: log apagado.' }
    }
    if (arg === 'export') {
      const path = await logFilePath($)
      await saveLog($)
      return { text: path ? `Log em ${path} (${(await getLog($)).length} prompts).` : 'Não achei a pasta do usuário.' }
    }

    // log / status: precisão das estimativas
    const entries = await getLog($)
    const a = accuracy(entries)
    const pct = (n: number) => (a.n > 0 ? `${Math.round((n / a.n) * 100)}%` : '—')
    const ratio = (x: number | null) => (x === null ? '—' : `${x.toFixed(2)}x`)
    const lines = [
      `Model router: análise ${(await read($, mode)) === 'on' ? 'ligada' : 'desligada'}. Log: ${entries.length} prompts (${a.sent} seguiram, ${a.held} interrompidos, ${a.overridden} enviados mesmo assim).`,
      '',
      `Estimativa x real (${a.n} prompts com os dois):`,
      `  tokens de saída: ${pct(a.outIn)} dentro da faixa, ${pct(a.outOver)} acima (subestimou), ${pct(a.outUnder)} abaixo (superestimou); real/estimado mediano ${ratio(a.outRatio)}`,
      `  tempo:           ${pct(a.secIn)} dentro da faixa, ${pct(a.secOver)} acima, ${pct(a.secUnder)} abaixo; real/estimado mediano ${ratio(a.secRatio)}`,
      '',
      `Custo da análise: ${a.analysisMs === null ? '—' : fmtSeconds(a.analysisMs / 1000)} e ${a.analysisTok === null ? '—' : fmtTokens(a.analysisTok)} tokens por prompt, em média.`,
    ]
    if (a.held + a.overridden > 0) {
      lines.push(`Sugestões seguidas: ${a.held} de ${a.held + a.overridden} (o resto você enviou mesmo assim).`)
    }
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    if ((await read($, mode)) === 'off') return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    await read($, currentModel) // redesenha quando o modelo da sessão muda
    await read($, tick) // redesenha a cada 30 s para a contagem do cache
    const hold = await read($, held)

    const { context } = await $.session.usage()
    const ctx = context.tokens ?? 0
    const ctxPct = context.window > 0 ? Math.round((ctx / context.window) * 100) : null
    const last = await read($, lastActivity)
    const left = last === null ? null : last + CACHE_TTL_MS - (await $.clock.now())
    const cacheText = left === null ? '—' : left <= 0 ? 'expirado' : fmtMinutes(left)
    const cacheColor = left === null ? undefined : COLOR[cacheLevel(left, CACHE_TTL_MS)]

    return (
      <Box flexDirection="column">
        {hold === null ? (
          ''
        ) : (
          <Box flexDirection="column" marginBottom={1}>
            <Text>
              <Text color={COLOR.warn}>⚠ Melhor em </Text>
              <Text bold>
                {cap(hold.model)} · {hold.effort}
              </Text>
              <Text dimColor>{'  '}{hold.reason}</Text>
            </Text>
            <Text dimColor>
              {hold.isCopied
                ? 'Prompt refinado copiado. Abra um novo chat, selecione o modelo e cole.'
                : 'Não consegui copiar o prompt refinado; use Copiar.'}
            </Text>
            <Box flexDirection="row">
              <Button key="send" label="Enviar aqui mesmo" onPress={() => sendHeld($)} />
              <Text>{'  '}</Text>
              <Button key="recopy" label="Copiar de novo" onPress={() => recopy($)} />
              <Text>{'  '}</Text>
              <Button key="discard" label="Descartar" onPress={() => update($, held, () => null)} />
            </Box>
          </Box>
        )}
        <Box flexDirection="row" flexWrap="wrap">
          <Text dimColor>contexto </Text>
          <Text color={COLOR[ctxLevel(ctx, context.window)]}>
            {fmtTokens(ctx)}
            {ctxPct !== null ? ` (${ctxPct}%)` : ''}
          </Text>
          <Text dimColor>{'   '}Cache · </Text>
          <Text color={cacheColor} dimColor={cacheColor === undefined}>
            {cacheText}
          </Text>
        </Box>
      </Box>
    )
  })
}
