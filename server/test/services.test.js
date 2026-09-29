import assert from 'node:assert/strict'
import test from 'node:test'
import { recallMemory, retainMemory, MemoryServiceError } from '../src/services/memoryService.js'
import { analyzeInvoiceWithLlm, LlmServiceError } from '../src/services/llmService.js'
import { createResponse, buildRecallQuery } from '../src/index.js'

const envKeys = ['HINDSIGHT_API_KEY', 'HINDSIGHT_BASE_URL', 'HINDSIGHT_BANK_ID', 'GROQ_API_KEY', 'GROQ_MODEL']

function setEnvironment(values) {
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) {
    if (values[key] === undefined) delete process.env[key]
    else process.env[key] = values[key]
  }
  return () => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload }
}

test('Hindsight recall sends bearer auth, query, budget and normalizes actual results', async () => {
  const restoreEnvironment = setEnvironment({
    HINDSIGHT_API_KEY: 'test-hindsight-secret',
    HINDSIGHT_BASE_URL: 'https://hindsight.test/',
    HINDSIGHT_BANK_ID: 'ap/bank',
  })
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return jsonResponse({ results: [{ id: 'mem-1', text: 'Vendor used net-30 terms.', type: 'world', context: 'AP history', timestamp: '2026-05-01T00:00:00Z', score: 0.92 }] })
  }
  try {
    const recalled = await recallMemory('vendor payment terms', { maxTokens: 700, tags: ['ap'] })
    assert.equal(request.url, 'https://hindsight.test/v1/default/banks/ap%2Fbank/memories/recall')
    assert.equal(request.options.headers.Authorization, 'Bearer test-hindsight-secret')
    assert.deepEqual(JSON.parse(request.options.body), { query: 'vendor payment terms', budget: 'mid', max_tokens: 700, tags: ['ap'] })
    assert.equal(recalled.results[0].text, 'Vendor used net-30 terms.')
    assert.equal(recalled.results[0].score, 0.92)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironment()
  }
})

test('Hindsight retain stores items synchronously in the configured bank', async () => {
  const restoreEnvironment = setEnvironment({
    HINDSIGHT_API_KEY: 'retain-test-secret',
    HINDSIGHT_BASE_URL: 'https://hindsight.test',
    HINDSIGHT_BANK_ID: 'ap-bank',
  })
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return jsonResponse({ success: true, bank_id: 'ap-bank', items_count: 1 })
  }
  try {
    const result = await retainMemory({ content: 'Invoice INV-42 approved after tax correction.', context: 'AP resolution', tags: ['ap', 'resolution'], timestamp: '2026-09-01T00:00:00Z' })
    assert.equal(request.url, 'https://hindsight.test/v1/default/banks/ap-bank/memories')
    assert.equal(request.options.headers.Authorization, 'Bearer retain-test-secret')
    assert.deepEqual(JSON.parse(request.options.body), {
      items: [{ content: 'Invoice INV-42 approved after tax correction.', context: 'AP resolution', tags: ['ap', 'resolution'], timestamp: '2026-09-01T00:00:00Z' }],
      async: false,
    })
    assert.equal(result.result.items_count, 1)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironment()
  }
})

test('Hindsight missing credentials fail explicitly without making a request', async () => {
  const restoreEnvironment = setEnvironment({})
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; return jsonResponse({ results: [] }) }
  try {
    await assert.rejects(recallMemory('invoice history'), (error) => error instanceof MemoryServiceError && error.code === 'not_configured')
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironment()
  }
})

test('Groq receives invoice and Hindsight evidence and filters unknown history IDs', async () => {
  const restoreEnvironment = setEnvironment({ GROQ_API_KEY: 'groq-test-secret', GROQ_MODEL: 'openai/gpt-oss-20b' })
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({
      riskLevel: 'MEDIUM',
      detectedIssues: ['Verify invoice tax against vendor terms.'],
      historicalContext: 'Previous invoice tax was corrected by the vendor. Memory mem-1 supports this.',
      recommendation: 'Verify the tax calculation before approval.',
      confidence: 'High',
      reasoningSummary: 'The invoice tax requires review against the retrieved vendor history.',
    }) } }] })
  }
  try {
    const result = await analyzeInvoiceWithLlm(
      { vendor: 'ABC Cloud Services', invoiceNumber: 'INV-1042', amount: 150000, tax: 27000, invoiceText: 'vendor history and tax issue' },
      [{ id: 'mem-1', text: 'Earlier invoice tax was corrected by the vendor.' }],
    )
    const body = JSON.parse(request.options.body)
    assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions')
    assert.equal(request.options.headers.Authorization, 'Bearer groq-test-secret')
    assert.equal(body.response_format.json_schema.strict, true)
    assert.match(body.messages[1].content, /HINDSIGHT MEMORIES/i)
    assert.deepEqual(result.historicalMemoryIds, ['mem-1'])
    assert.equal(result.recommendation, 'Verify the tax calculation before approval.')
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironment()
  }
})

test('Groq retries with a compatible JSON response format when strict schema is rejected', async () => {
  const restoreEnvironment = setEnvironment({ GROQ_API_KEY: 'groq-test-secret', GROQ_MODEL: 'openai/gpt-oss-20b' })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body))
    if (calls.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: { message: 'response_format is not supported for this model' } }),
        json: async () => ({ error: { message: 'response_format is not supported for this model' } }),
      }
    }
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({
      riskLevel: 'LOW',
      detectedIssues: [],
      historicalContext: [],
      recommendation: 'Proceed after a normal verification.',
      confidence: 88,
      reasoningSummary: 'The invoice is consistent with the provided details.',
    }) } }] })
  }
  try {
    const result = await analyzeInvoiceWithLlm(
      { vendor: 'Acme', invoiceNumber: 'INV-42', amount: 1000, tax: 90 },
      [],
    )
    assert.equal(calls.length, 2)
    assert.equal(calls[0].response_format.type, 'json_schema')
    assert.equal(calls[1].response_format.type, 'json_object')
    assert.equal(result.recommendation, 'Proceed after a normal verification.')
    assert.equal(result.riskLevel, 'LOW')
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironment()
  }
})

test('Groq retries JSON generation failures with a compact JSON-object prompt', async () => {
  const restoreEnvironment = setEnvironment({ GROQ_API_KEY: 'groq-test-secret', GROQ_MODEL: 'openai/gpt-oss-20b' })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body))
    if (calls.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: {
          message: 'Failed to generate JSON. Please adjust your prompt.',
          failed_generation: 'incomplete generated JSON',
        } }),
      }
    }
    return jsonResponse({ choices: [{ message: { content: JSON.stringify({
      riskLevel: 'LOW',
      detectedIssues: [],
      historicalContext: '',
      recommendation: 'Proceed after normal verification.',
      confidence: 'High',
      reasoningSummary: 'No significant discrepancy was found.',
    }) } }] })
  }
  try {
    const result = await analyzeInvoiceWithLlm(
      { vendor: 'Acme', invoiceNumber: 'INV-42', amount: 1000, tax: 90, invoiceText: 'Invoice details' },
      Array.from({ length: 56 }, (_, index) => ({ id: `memory-${index}`, text: 'Previous invoice history '.repeat(100) })),
    )
    const firstBody = calls[0]
    const retryBody = calls[1]
    assert.equal(calls.length, 2)
    assert.equal(firstBody.response_format.type, 'json_schema')
    assert.equal(retryBody.response_format.type, 'json_object')
    assert.ok(retryBody.messages[1].content.length < firstBody.messages[1].content.length)
    assert.equal(result.riskLevel, 'LOW')
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironment()
  }
})

test('Groq missing credentials fail explicitly', async () => {
  const restoreEnvironment = setEnvironment({})
  try {
    await assert.rejects(analyzeInvoiceWithLlm({}, []), (error) => error instanceof LlmServiceError && error.code === 'not_configured')
  } finally {
    restoreEnvironment()
  }
})

test('Hindsight 400 responses surface the upstream error body instead of being treated as a no-memory success', async () => {
  const restoreEnvironment = setEnvironment({
    HINDSIGHT_API_KEY: 'test-hindsight-secret',
    HINDSIGHT_BASE_URL: 'https://hindsight.test/',
    HINDSIGHT_BANK_ID: 'ap/bank',
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error: { message: 'Incorrect payload: missing field "query".' } }),
    json: async () => ({ error: { message: 'Incorrect payload: missing field "query".' } }),
  })

  try {
    await assert.rejects(recallMemory('vendor payment terms'), (error) => {
      return error instanceof MemoryServiceError
        && error.code === 'upstream_error'
        && /Hindsight returned HTTP 400\./.test(error.message)
        && /missing field/.test(error.message)
        && /query/.test(error.message)
    })
  } finally {
    globalThis.fetch = originalFetch
    restoreEnvironment()
  }
})

test('buildRecallQuery keeps recall requests concise and excludes the full invoice text', () => {
  const longText = 'Invoice line '.repeat(120)
  const query = buildRecallQuery({
    vendor: 'Infosys Limited',
    invoiceNumber: 'INF-INV-2026-2048',
    date: '2026-09-15',
    amount: 275000,
    tax: 24750,
    paymentTerms: 'Net 30',
    description: 'Cloud hosting, application monitoring, technical support',
    currency: 'INR',
    invoiceText: longText,
  })

  assert.match(query, /Infosys Limited/i)
  assert.doesNotMatch(query, /Invoice line/i)
  assert.doesNotMatch(query, /invoice text excerpt/i)
  assert.ok(query.length < 1200, `Query should stay compact for Hindsight recall: ${query.length} chars`)
})

test('buildRecallQuery does not treat an unidentified vendor placeholder as a real vendor', () => {
  const query = buildRecallQuery({
    vendor: 'Vendor not identified',
    invoiceNumber: 'INV-42',
    amount: 1000,
    tax: 90,
    currency: 'INR',
  })

  assert.doesNotMatch(query, /Vendor: Vendor not identified/i)
  assert.match(query, /Do not assume the vendor identity/i)
})

test('CreateResponse distinguishes Hindsight API errors from successful no-memory results', () => {
  const errorResponse = createResponse(
    { vendor: 'Apex Digital', invoiceNumber: 'INV-2048', amount: 250000, tax: 30000, paymentTerms: 'Net 30', description: 'Hosting', currency: 'INR' },
    { results: [], rawCount: 0 },
    { status: 'error', message: 'Hindsight returned HTTP 400. {"error":{"message":"Incorrect payload: missing field \"query\"."}}', returnedCount: 0 },
    {
      riskLevel: 'MEDIUM',
      detectedIssues: ['Tax mismatch flagged.'],
      historicalMemoryIds: [],
      recommendation: 'Verify the tax calculation before approval.',
      confidence: 'Low',
      reasoningSummary: 'The invoice tax should be verified with vendor history.',
    },
    null,
  )

  assert.equal(errorResponse.memoryFound, false)
  assert.equal(errorResponse.memoryStatus.status, 'error')
  assert.match(errorResponse.response, /Memory search failed: Hindsight returned HTTP 400\./)
  assert.doesNotMatch(errorResponse.response, /No relevant historical experience found\./)
})

test('CreateResponse keeps concise AP summaries for discrepancy and no-memory cases', () => {
  const discrepancy = createResponse(
    { vendor: 'Apex Digital', invoiceNumber: 'INV-2048', amount: 250000, tax: 30000, paymentTerms: 'Net 30', description: 'Hosting' },
    { results: [{ id: 'mem-1', text: 'Earlier tax mismatch was corrected before approval.', type: 'history', context: 'AP history', timestamp: '2026-09-01T00:00:00Z' }], rawCount: 1 },
    { status: 'ready', message: '', returnedCount: 1 },
    { riskLevel: 'MEDIUM', detectedIssues: ['GST amount appears inconsistent with the taxable amount.'], historicalMemoryIds: ['mem-1'], recommendation: 'Verify the GST calculation and request correction before approval.', confidence: 87, reasoningSummary: '• The current tax calculation differs from the expected amount. • Hindsight found a similar issue previously.' },
    null,
  )

  assert.equal(discrepancy.risk, 'MEDIUM')
  assert.equal(discrepancy.confidence, 87)
  assert.match(discrepancy.response, /GST amount appears inconsistent/i)
  assert.match(discrepancy.recommendation, /request correction before approval/i)

  const noMemory = createResponse(
    { vendor: 'BrightWorks', invoiceNumber: 'INV-919', amount: 140000, tax: 12000, paymentTerms: 'Net 15', description: 'Consulting' },
    { results: [], rawCount: 0 },
    { status: 'ready', message: '', returnedCount: 0 },
    { riskLevel: 'LOW', detectedIssues: ['No significant discrepancy detected.'], historicalMemoryIds: [], recommendation: 'Proceed with normal invoice verification.', confidence: 92, reasoningSummary: '• No significant discrepancy detected.' },
    null,
  )

  assert.equal(noMemory.risk, 'LOW')
  assert.match(noMemory.response, /No relevant historical experience found\./i)
  assert.match(noMemory.recommendation, /Proceed with normal invoice verification\./i)
})
