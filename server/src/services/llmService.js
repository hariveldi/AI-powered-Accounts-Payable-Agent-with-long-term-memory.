const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions'
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-20b'
const REQUEST_TIMEOUT_MS = 30_000
const MAX_MEMORY_COUNT = 8
const MAX_MEMORY_TEXT_LENGTH = 700

export class LlmServiceError extends Error {
  constructor(message, code, status = 503) {
    super(message)
    this.name = 'LlmServiceError'
    this.code = code
    this.status = status
  }
}

export function groqReadiness() {
  return {
    configured: Boolean(process.env.GROQ_API_KEY?.trim()),
    model: process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL,
  }
}

const outputSchema = {
  type: 'object',
  properties: {
    riskLevel: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
    detectedIssues: { type: 'array', items: { type: 'string' } },
    historicalContext: { type: 'string' },
    recommendation: { type: 'string' },
    confidence: { type: 'string' },
    reasoningSummary: { type: 'string' },
  },
  required: ['riskLevel', 'detectedIssues', 'historicalContext', 'recommendation', 'confidence', 'reasoningSummary'],
  additionalProperties: false,
}

function selectRelevantMemories(memories) {
  return (Array.isArray(memories) ? memories : [])
    .map((memory, index) => ({
      id: String(memory?.id ?? `memory-${index + 1}`),
      text: String(memory?.text ?? memory?.detail ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MEMORY_TEXT_LENGTH),
    }))
    .filter((memory) => memory.text)
    .slice(0, MAX_MEMORY_COUNT)
}

function buildMemoryPrompt(memories) {
  const relevant = selectRelevantMemories(memories)
  if (!relevant.length) return 'No relevant Hindsight memories were returned for this invoice.'

  return relevant.map((memory, index) => {
    const factText = memory.text
      .replace(/\s*\|\s*/g, '\n')
      .replace(/\s*When:\s*/gi, '\nWhen: ')
      .replace(/\s*Involving:\s*/gi, '\nInvolving: ')
      .replace(/\s*Resolution\s*of\s*/gi, '\nResolution: ')
      .trim()

    return `Memory ${index + 1}:\n${factText}`
  }).join('\n\n')
}

function getJsonContent(response) {
  const content = response?.choices?.[0]?.message?.content
  if (typeof content !== 'string') throw new LlmServiceError('Groq returned no structured response.', 'invalid_response', 502)
  try {
    return JSON.parse(content)
  } catch {
    throw new LlmServiceError('Groq returned invalid JSON.', 'invalid_response', 502)
  }
}

export async function analyzeInvoiceWithLlm(invoice, memories) {
  const apiKey = process.env.GROQ_API_KEY?.trim()
  if (!apiKey) throw new LlmServiceError('Groq is not configured. Set GROQ_API_KEY.', 'not_configured')

  const relevantMemories = selectRelevantMemories(memories)
  const currentInvoiceText = String(invoice?.invoiceText ?? '').trim() || [
    invoice?.vendor,
    invoice?.invoiceNumber,
    invoice?.date,
    invoice?.paymentTerms,
    invoice?.description,
    `Amount: ${invoice?.amount ?? 0}`,
    `Tax: ${invoice?.tax ?? 0}`,
  ].filter(Boolean).join('\n')

  const buildBody = (responseFormat, compact = false) => ({
    model: process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL,
    temperature: 0.1,
    max_completion_tokens: 2048,
    messages: [
      {
        role: 'system',
        content: [
          'You are an Accounts Payable investigation agent.',
          'Analyze the current invoice using the invoice text and the supplied organizational memories.',
          'Use historical information ONLY from the supplied Hindsight memories.',
          'Do not invent vendor history, previous incidents, resolutions, or payment behavior.',
          'If a historical fact is not present in the supplied memories, do not claim it.',
          'Identify discrepancies and recommend an appropriate AP action.',
          'Return only the requested structured output and include every required field: riskLevel, detectedIssues, historicalContext, recommendation, confidence, and reasoningSummary.',
          'Do not omit any field; use an empty string or empty array when a value is unavailable.',
        ].join(' '),
      },
      {
        role: 'user',
        content: [
          'CURRENT INVOICE',
          currentInvoiceText.slice(0, compact ? 6000 : 12000) || 'Invoice text was not supplied.',
          '',
          'HINDSIGHT MEMORIES',
          buildMemoryPrompt(compact ? relevantMemories.slice(0, 4).map((memory) => ({
            ...memory,
            text: memory.text.slice(0, 350),
          })) : relevantMemories),
        ].join('\n\n'),
      },
    ],
    response_format: responseFormat,
  })

  const attempts = [
    buildBody({
      type: 'json_schema',
      json_schema: { name: 'invoice_analysis', strict: true, schema: outputSchema },
    }),
    buildBody({ type: 'json_object' }, true),
  ]

  for (const [attemptIndex, body] of attempts.entries()) {
    let response
    try {
      response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      throw new LlmServiceError(timedOut ? 'Groq request timed out.' : 'Groq could not be reached.', timedOut ? 'timeout' : 'unavailable'      )
    }

    if (!response.ok) {
      const responseText = await response.text().catch(() => '')
      let errorDetails = ''
      let failedGeneration = null
      try {
        const parsed = JSON.parse(responseText)
        errorDetails = parsed?.error?.message || parsed?.message || ''
        failedGeneration = parsed?.error?.failed_generation ?? parsed?.failed_generation ?? null
      } catch {
        errorDetails = responseText.trim()
      }

      console.error('[llmService] Groq request failed', {
        status: response.status,
        responseBody: responseText,
        errorMessage: errorDetails,
        failedGeneration,
      })

      const isSchemaUnsupported = response.status === 400 && /response_format|json_schema|json_object/i.test(errorDetails || responseText)
      const generationFailed = response.status === 400
        && /failed to generate json|failed_generation/i.test(`${errorDetails} ${failedGeneration ?? ''} ${responseText}`)
      if (attemptIndex < attempts.length - 1 && (isSchemaUnsupported || generationFailed)) {
        continue
      }

      throw new LlmServiceError(
        errorDetails ? `Groq returned HTTP ${response.status}. ${errorDetails}` : `Groq returned HTTP ${response.status}.`,
        'upstream_error',
        502,
      )
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      throw new LlmServiceError('Groq returned an invalid JSON response.', 'invalid_response', 502)
    }

    const output = getJsonContent(payload)
    const historicalMemoryIds = relevantMemories.map((memory) => memory.id)
    const allowedHistoryIds = new Set(historicalMemoryIds)

    const extractedHistoryIds = Array.isArray(output.historicalContext)
      ? output.historicalContext.filter((id) => typeof id === 'string' && allowedHistoryIds.has(id))
      : historicalMemoryIds

    const confidence = typeof output.confidence === 'number'
      ? Math.min(100, Math.max(0, Math.round(output.confidence)))
      : typeof output.confidence === 'string'
        ? output.confidence.toUpperCase()
        : 'LOW'

    if (!['LOW', 'MEDIUM', 'HIGH'].includes(String(output.riskLevel).toUpperCase())
      || !Array.isArray(output.detectedIssues)
      || (typeof output.historicalContext !== 'string' && !Array.isArray(output.historicalContext))
      || typeof output.recommendation !== 'string'
      || typeof output.reasoningSummary !== 'string') {
      throw new LlmServiceError('Groq response did not match the analysis schema.', 'invalid_response', 502)
    }

    return {
      riskLevel: String(output.riskLevel).toUpperCase(),
      detectedIssues: output.detectedIssues.filter((item) => typeof item === 'string').slice(0, 3),
      historicalMemoryIds: extractedHistoryIds,
      recommendation: output.recommendation.slice(0, 220),
      confidence,
      reasoningSummary: output.reasoningSummary.slice(0, 420),
    }
  }

  throw new LlmServiceError('Groq returned no usable response.', 'invalid_response', 502)
}