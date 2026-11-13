export type Tier = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Range = [number, number]

/** O que a análise estimou para o modelo e esforço que estão selecionados. */
export type Est = { out: Range; sec: Range }

export type Verdict = {
  /** O modelo e esforço atuais servem para este prompt. */
  adequate: boolean
  model: Tier
  effort: Effort
  confidence: number
  reason: string
  est: Est | null
  /** Só quando não é adequado: resumo da conversa e prompt reescrito. */
  summary: string
  refined: string
}

export type Mode = 'on' | 'off'

export type Actual = {
  outTok: number
  inTok: number
  cacheRead: number
  cacheWrite: number
  ms: number
  model: string
  effort: string | null
}

/** Uma linha do log: o que o router estimou e o que o prompt gastou de fato. */
export type LogEntry = {
  id: string
  at: number
  promptChars: number
  /** Modelo e esforço selecionados quando o prompt foi enviado. */
  model: string
  effort: string | null
  /** sent: seguiu; held: interrompido; overridden: interrompido e enviado mesmo assim. */
  action: 'sent' | 'held' | 'overridden'
  analysis: { ok: boolean; ms: number; inTok: number; outTok: number; viaFork: boolean }
  verdict: Verdict | null
  actual: Actual | null
}

export type Held = {
  entryId: string
  /** O prompt como foi digitado. */
  text: string
  /** Resumo + prompt refinado, o que foi para a área de transferência. */
  clip: string
  model: Tier
  effort: Effort
  reason: string
  isCopied: boolean
}

export type Footer = {
  model: string
  effort: string | null
  durationMs: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  fiveHour: { before: number | null; after: number } | null
  usdDelta: number | null
  isAborted: boolean
  est: Est | null
  /** Quando o prompt foi enviado apesar da sugestão do router. */
  hint: { model: Tier; effort: Effort } | null
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      mode: Mode
      held: Held | null
      currentModel: string
      currentEffort: string | null
      footers: Record<string, Footer>
      lastActivity: number | null
      tick: number
    }
  }
}
