const DEFAULT_HINDSIGHT_BASE_URL = 'https://api.hindsight.vectorize.io'
const HINDSIGHT_API_PREFIX = '/v1/default/banks'
const REQUEST_TIMEOUT_MS = 20_000

export class MemoryServiceError extends Error {
  constructor(message, code, status = 503) {
    super(message)
    this.name = 'MemoryServiceError'
    this.code = code
    this.status = status
  }
}

function getConfig() {
  return {
    apiKey: process.env.HINDSIGHT_API_KEY?.trim(),
    baseUrl: (process.env.HINDSIGHT_BASE_URL?.trim() || DEFAULT_HINDSIGHT_BASE_URL).replace(/\/+$/, ''),
    bankId: process.env.HINDSIGHT_BANK_ID?.trim(),
  }
}

export function hindsightReadiness() {
  const config = getConfig()
  const missing = []
  if (!config.apiKey) missing.push('HINDSIGHT_API_KEY')
  if (!config.bankId) missing.push('HINDSIGHT_BANK_ID')
  return {
    configured: missing.length === 0,
    missing,
    baseUrlConfigured: Boolean(process.env.HINDSIGHT_BASE_URL?.trim()),
  }
}

function getUrl(route) {
  const { bankId, baseUrl } = getConfig()
  return `${baseUrl}${HINDSIGHT_API_PREFIX}/${encodeURIComponent(bankId)}${route}`
}

async function hindsightRequest(route, body) {
  const config = getConfig()
  if (!config.apiKey || !config.bankId) {
    const missing = []
    if (!config.apiKey) missing.push('HINDSIGHT_API_KEY')
    if (!config.bankId) missing.push('HINDSIGHT_BANK_ID')
    throw new MemoryServiceError(`Hindsight is not configured. Missing ${missing.join(' and ')}.`, 'not_configured')
  }

  let response
  try {
    response = await fetch(getUrl(route), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    throw new MemoryServiceError(
      timedOut ? 'Hindsight request timed out.' : 'Hindsight could not be reached.',
      timedOut ? 'timeout' : 'unavailable',
    )
  }

  if (!response.ok) {
    const rawText = await response.text()
    let detail = ''
    if (rawText) {
      try {
        const parsed = JSON.parse(rawText)
        detail = JSON.stringify(parsed)
      } catch {
        detail = rawText.trim()
      }
    }
    throw new MemoryServiceError(
      detail ? `Hindsight returned HTTP ${response.status}. ${detail}` : `Hindsight returned HTTP ${response.status}.`,
      'upstream_error',
      502,
    )
  }

  try {
    return await response.json()
  } catch {
    throw new MemoryServiceError('Hindsight returned an invalid JSON response.', 'invalid_response', 502)
  }
}

export async function retainMemory(memories) {
  const items = (Array.isArray(memories) ? memories : [memories]).map((memory) => {
    const content = String(memory?.content ?? '').trim()
    if (!content) throw new TypeError('Each memory requires non-empty content.')
    const item = { content }
    if (memory.context) item.context = String(memory.context)
    if (Array.isArray(memory.tags) && memory.tags.length) item.tags = memory.tags.map(String)
    if (memory.timestamp) item.timestamp = String(memory.timestamp)
    return item
  })

  if (items.length === 0) throw new TypeError('At least one memory is required.')
  const result = await hindsightRequest('/memories', { items, async: false })
  return { bankId: getConfig().bankId, result }
}

export async function recallMemory(query, options = {}) {
  const cleanQuery = String(query ?? '').trim()
  if (!cleanQuery) throw new TypeError('A meaningful recall query is required.')

  const body = {
    query: cleanQuery,
    budget: options.budget ?? 'mid',
    max_tokens: options.maxTokens ?? 2048,
  }
  if (Array.isArray(options.tags) && options.tags.length) body.tags = options.tags.map(String)

  const result = await hindsightRequest('/memories/recall', body)
  if (!Array.isArray(result?.results)) {
    throw new MemoryServiceError('Hindsight recall response did not contain a results array.', 'invalid_response', 502)
  }

  return {
    bankId: getConfig().bankId,
    results: result.results.map((item, index) => ({
      id: String(item.id ?? item.memory_id ?? item.chunk_id ?? `hindsight-${index + 1}`),
      text: String(item.text ?? item.content ?? item.memory ?? '').trim(),
      type: item.type ? String(item.type) : '',
      context: item.context ? String(item.context) : '',
      timestamp: item.timestamp ?? item.occurred_at ?? null,
      score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
    })).filter((item) => item.text),
    rawCount: result.results.length,
  }
}