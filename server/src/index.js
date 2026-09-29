import dotenv from 'dotenv'
import express from 'express'
import multer from 'multer'
import { fileURLToPath } from 'node:url'
import { ensureInitialApMemories } from './services/apMemorySeed.js'
import { extractInvoiceFromFile } from './services/invoiceExtraction.js'
import { groqReadiness, analyzeInvoiceWithLlm, LlmServiceError } from './services/llmService.js'
import { hindsightReadiness, recallMemory, retainMemory, MemoryServiceError } from './services/memoryService.js'

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })

const app = express()
const port = Number(process.env.PORT ?? 3001)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })
const MAX_ANALYSIS_MEMORIES = 8
app.use(express.json({ limit: '1mb' }))

let seedState = { status: 'pending', count: 0 }
let seedPromise

function initializeMemoryDataset() {
  if (!hindsightReadiness().configured) {
    seedState = { status: 'not_configured', count: 0 }
    return Promise.resolve(seedState)
  }
  if (!seedPromise) {
    seedPromise = ensureInitialApMemories()
      .then((result) => {
        seedState = result
        console.info(`Hindsight AP seed status: ${result.status} (${result.count} memories).`)
        return result
      })
      .catch((error) => {
        seedState = { status: 'unavailable', count: 0, code: error.code ?? 'seed_failed' }
        console.warn(`Hindsight AP seed could not be confirmed: ${seedState.code}.`)
        return seedState
      })
  }
  return seedPromise
}

const seedInitialization = initializeMemoryDataset()

function normalizeInvoice(body) {
  const vendor = String(body?.vendor ?? '').trim()
  const invoiceNumber = String(body?.number ?? '').trim()
  const amount = Number(body?.amount)
  const tax = Number(body?.tax)
  if (!vendor || !invoiceNumber) throw new TypeError('Vendor and invoice number are required.')
  if (!Number.isFinite(amount) || amount < 0) throw new TypeError('A valid non-negative invoice amount is required.')
  if (!Number.isFinite(tax) || tax < 0) throw new TypeError('A valid non-negative tax amount is required.')

  return {
    vendor,
    invoiceNumber,
    date: String(body?.date ?? '').trim(),
    amount,
    tax,
    paymentTerms: String(body?.paymentTerms ?? '').trim(),
    description: String(body?.description ?? '').trim(),
    filename: String(body?.filename ?? '').trim(),
    currency: String(body?.currency ?? 'INR').trim(),
  }
}

function compactMemoryText(value, maxLength = 180) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function buildRecallQuery(invoice) {
  const vendor = (invoice.vendor || '').trim()
  const vendorIsKnown = vendor && !/^(?:vendor not identified|unknown vendor|not identified|unknown)$/i.test(vendor)
  const invoiceNumber = (invoice.invoiceNumber || '').trim()
  const currency = (invoice.currency || 'INR').trim() || 'INR'
  const queryParts = []

  if (vendorIsKnown) queryParts.push(`Vendor: ${vendor}.`)
  if (invoiceNumber) queryParts.push(`Invoice: ${invoiceNumber}.`)
  if (invoice.date) queryParts.push(`Invoice date: ${invoice.date}.`)
  if (invoice.paymentTerms) queryParts.push(`Payment terms: ${invoice.paymentTerms}.`)
  if (invoice.description) queryParts.push(`Services or goods: ${compactMemoryText(invoice.description, 180)}.`)
  if (Number.isFinite(Number(invoice.amount)) && Number(invoice.amount) > 0) {
    queryParts.push(`Invoice amount: ${currency} ${Number(invoice.amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}.`)
  }
  if (Number.isFinite(Number(invoice.tax)) && Number(invoice.tax) > 0) {
    queryParts.push(`Tax amount: ${currency} ${Number(invoice.tax).toLocaleString('en-IN', { maximumFractionDigits: 2 })}.`)
  }

  queryParts.push(vendorIsKnown
    ? 'Recall prior accounts payable issues, payment terms, tax or GST discrepancies, corrections, and resolutions relevant to this vendor and invoice type.'
    : 'Recall prior accounts payable issues, payment terms, tax or GST discrepancies, corrections, and resolutions relevant to this invoice type. Do not assume the vendor identity.')
  let query = queryParts.join(' ').replace(/\s+/g, ' ').trim()

  if (!query) {
    query = 'Recall prior accounts payable vendor issues, payment terms, and tax discrepancies relevant to this invoice.'
  }

  if (query.length > 1200) {
    query = query.slice(0, 1100).trim()
    const sentenceEnd = query.lastIndexOf('.')
    if (sentenceEnd > 80) query = query.slice(0, sentenceEnd + 1)
  }

  return query
}

function toClientMemory(memory) {
  const firstLine = memory.text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? memory.text
  return {
    id: memory.id,
    kind: memory.type || 'Recalled experience',
    title: firstLine.length > 86 ? `${firstLine.slice(0, 83)}...` : firstLine,
    detail: memory.text,
    date: memory.timestamp ? String(memory.timestamp) : 'Date not provided by memory',
    context: memory.context,
    score: memory.score,
  }
}

function deterministicFallback(invoice, memories, memoryStatus, llmError) {
  const hasTaxHistory = memories.some((memory) => /tax|gst|vat|discrepanc/i.test(memory.text))
  const recommendation = hasTaxHistory
    ? 'Verify the tax calculation against the recalled vendor history before approval.'
    : 'Review the submitted invoice details before approval.'
  const historyIntro = memoryStatus?.status === 'ready'
    ? memories.length
      ? `Hindsight returned ${memoryStatus.returnedCount ?? memories.length} relevant memory ${(memoryStatus.returnedCount ?? memories.length) === 1 ? 'item' : 'items'} for ${invoice.vendor}; ${memories.length} selected for analysis.`
      : `Hindsight recall completed and returned no relevant memories for ${invoice.vendor}.`
    : memoryStatus?.status === 'error'
      ? `Historical memory search failed: ${memoryStatus.message}. No historical facts were used.`
      : 'Historical memory is unavailable. No historical facts were used.'
  const evidence = memories.map((memory) => memory.text).join('\n\n')

  return {
    riskLevel: hasTaxHistory ? 'MEDIUM' : 'LOW',
    detectedIssues: [],
    historicalMemoryIds: memories.map((memory) => memory.id),
    recommendation,
    confidence: 'Low',
    reasoningSummary: `Groq analysis is unavailable (${llmError.message}). ${historyIntro}`,
    response: [historyIntro, evidence, `For ${invoice.invoiceNumber}, I recommend: ${recommendation}`].filter(Boolean).join('\n\n'),
    status: 'fallback',
  }
}

function createResponse(invoice, memoryResult, memoryStatus, llmResult, llmError) {
  const clientMemories = memoryResult.results.map(toClientMemory)
  if (llmError) {
    const fallback = deterministicFallback(invoice, memoryResult.results, memoryStatus, llmError)
    const memoryFailureMessage = memoryStatus.status === 'error'
      ? `Memory search failed: ${memoryStatus.message}`
      : memoryStatus.status === 'ready' && clientMemories.length > 0
        ? `Hindsight found relevant history for ${invoice.vendor}. ${fallback.recommendation}`
        : `No relevant historical experience found. ${fallback.recommendation}`
    return {
      mode: 'fallback',
      vendor: invoice.vendor,
      invoiceNumber: invoice.invoiceNumber,
      amount: invoice.amount,
      tax: invoice.tax,
      paymentTerms: invoice.paymentTerms || 'Not supplied',
      memoryFound: memoryStatus.status === 'ready' && clientMemories.length > 0,
      memoryStatus,
      llmStatus: { status: 'unavailable', message: llmError.message },
      memories: clientMemories,
      previousIssue: '',
      previousResolution: '',
      outcome: '',
      detectedIssues: fallback.detectedIssues.slice(0, 3),
      historicalContext: clientMemories.slice(0, 2),
      recommendation: fallback.recommendation,
      response: memoryFailureMessage,
      reasoningSummary: fallback.reasoningSummary.slice(0, 420),
      risk: fallback.riskLevel,
      confidence: fallback.confidence,
    }
  }

  const trustedHistoricalContext = llmResult.historicalMemoryIds
    .map((id) => clientMemories.find((memory) => memory.id === id))
    .filter(Boolean)
  const historyText = memoryStatus.status === 'error'
    ? `Memory search failed: ${memoryStatus.message}`
    : trustedHistoricalContext.length
      ? `Previous vendor experience: ${trustedHistoricalContext[0].detail.replace(/\s+/g, ' ').slice(0, 180)}.`
      : 'No relevant historical experience found.'
  const responseText = [
    llmResult.detectedIssues.length ? llmResult.detectedIssues[0] : 'No significant discrepancy detected.',
    historyText,
    llmResult.recommendation,
  ].join(' ')

  return {
    mode: memoryStatus.status === 'ready' ? 'live' : 'fallback',
    vendor: invoice.vendor,
    invoiceNumber: invoice.invoiceNumber,
    amount: invoice.amount,
    tax: invoice.tax,
    paymentTerms: invoice.paymentTerms || 'Not supplied',
    memoryFound: memoryStatus.status === 'ready' && clientMemories.length > 0,
    memoryStatus,
    llmStatus: { status: 'ready', model: groqReadiness().model },
    memories: clientMemories,
    previousIssue: '',
    previousResolution: '',
    outcome: '',
    detectedIssues: llmResult.detectedIssues.slice(0, 3),
    historicalContext: trustedHistoricalContext.slice(0, 2),
    recommendation: llmResult.recommendation,
    response: responseText.slice(0, 260),
    reasoningSummary: llmResult.reasoningSummary.slice(0, 420),
    risk: llmResult.riskLevel,
    confidence: llmResult.confidence,
  }
}

app.get('/api/health', (_request, response) => {
  const hindsight = hindsightReadiness()
  const groq = groqReadiness()
  response.json({
    status: 'ok',
    services: {
      hindsight: { configured: hindsight.configured, missing: hindsight.missing, seed: seedState.status },
      groq: { configured: groq.configured, model: groq.model },
    },
  })
})

app.post('/api/memory/seed', async (_request, response) => {
  try {
    const result = await initializeMemoryDataset()
    if (result.status === 'not_configured') {
      response.status(503).json({ status: result.status, missing: hindsightReadiness().missing })
      return
    }
    if (result.status === 'unavailable') {
      response.status(502).json({ status: result.status, message: 'Hindsight seed check or retain failed; no successful seed is claimed.' })
      return
    }
    response.json({ status: result.status, retainedCount: result.count })
  } catch (error) {
    response.status(error.status ?? 502).json({ status: 'unavailable', message: error.message })
  }
})

app.post('/api/extract', upload.single('invoice'), async (request, response) => {
  const file = request.file
  if (!file) {
    response.status(400).json({ error: 'A PDF or image invoice file is required.' })
    return
  }

  try {
    const extracted = await extractInvoiceFromFile(file)
    const payload = {
      success: true,
      invoice: {
        vendor: extracted.vendor,
        number: extracted.number,
        date: extracted.date,
        amount: extracted.amount,
        tax: extracted.tax,
        paymentTerms: extracted.paymentTerms,
        description: extracted.description,
        filename: extracted.filename,
        fileSize: extracted.fileSize,
      },
    }
    response.json(payload)
  } catch (error) {
    response.status(400).json({ success: false, error: error.message || 'Could not extract invoice information.' })
  }
})

app.post('/api/analyze', upload.single('file'), async (request, response) => {
  response.status(200)
  response.set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  response.flushHeaders()

  const emit = (event) => response.write(`${JSON.stringify(event)}\n`)

  let invoice
  try {
    if (request.file) {
      const extracted = await extractInvoiceFromFile(request.file)
      const invoiceText = String(extracted.sourceText || '').trim()
      if (!invoiceText) {
        throw new TypeError('Could not read this invoice PDF.')
      }

      invoice = {
        vendor: extracted.vendor || 'Vendor not identified',
        invoiceNumber: extracted.number || 'Number not identified',
        date: extracted.date ?? '',
        amount: Number(extracted.amount ?? 0),
        tax: Number(extracted.tax ?? 0),
        paymentTerms: extracted.paymentTerms ?? '',
        description: extracted.description ?? '',
        filename: extracted.filename ?? request.file.originalname ?? request.file.name,
        currency: 'INR',
        invoiceText,
      }
      console.info('[server] /api/analyze extracted from file', { vendor: invoice.vendor, invoiceNumber: invoice.invoiceNumber, invoiceTextLength: invoice.invoiceText.length })
    } else {
      invoice = normalizeInvoice(request.body)
      invoice.invoiceText = String(request.body?.invoiceText || '').trim() || String(request.body?.text || '').trim() || String(request.body?.content || '').trim()
      if (!invoice.invoiceText) {
        throw new TypeError('Could not read this invoice PDF.')
      }
      console.info('[server] /api/analyze received invoice', invoice)
    }
  } catch (error) {
    console.error('[server] /api/analyze invalid invoice payload', error)
    emit({ type: 'error', message: error instanceof Error ? error.message : 'Invoice analysis could not begin.' })
    response.end()
    return
  }

  try {
    emit({ type: 'stage', stage: 'RECEIVING', state: 'complete', text: 'Invoice details received by the backend.' })
    emit({ type: 'stage', stage: 'READING', state: 'complete', text: request.file
      ? 'Extracted invoice text from the uploaded PDF.'
      : 'Submitted invoice fields validated for review.' })
    emit({ type: 'stage', stage: 'UNDERSTANDING', state: 'complete', text: `${invoice.vendor} identified from the uploaded invoice.` })
    emit({ type: 'stage', stage: 'MEMORY_SEARCH', state: 'active', text: 'Calling Hindsight RECALL with the extracted invoice context.' })

    await seedInitialization
    let memoryResult = { results: [], rawCount: 0 }
    let memoryStatus
    try {
      const recalledMemories = await recallMemory(buildRecallQuery(invoice), { budget: 'mid', maxTokens: 3072 })
      memoryResult = { ...recalledMemories, results: recalledMemories.results.slice(0, MAX_ANALYSIS_MEMORIES) }
      memoryStatus = { status: 'ready', message: '', returnedCount: recalledMemories.rawCount, usedCount: memoryResult.results.length }
      console.info('[server] Hindsight RECALL returned', { count: recalledMemories.rawCount, usedCount: memoryResult.results.length, vendor: invoice.vendor })
      emit({
        type: 'stage',
        stage: 'MEMORY_FOUND',
        state: 'complete',
        text: memoryResult.results.length
          ? `Hindsight returned ${recalledMemories.rawCount} relevant memories; using the top ${memoryResult.results.length} for analysis.`
          : 'Hindsight recall completed; no relevant memories were returned.',
        count: memoryResult.results.length,
        memories: memoryResult.results.map(toClientMemory),
      })
    } catch (error) {
      const serviceError = error instanceof MemoryServiceError
        ? error
        : new MemoryServiceError('Hindsight recall failed.', 'unavailable')
      memoryStatus = { status: 'error', code: serviceError.code, message: serviceError.message, returnedCount: 0 }
      console.error('[server] Hindsight RECALL failed', serviceError)
      emit({ type: 'stage', stage: 'MEMORY_UNAVAILABLE', state: 'complete', text: `Memory search failed: ${serviceError.message}` })
    }

    emit({ type: 'stage', stage: 'COMPARING', state: 'complete', text: `Prepared the invoice and ${memoryResult.results.length} actual Hindsight result(s) for reasoning.` })
    emit({ type: 'stage', stage: 'REASONING', state: 'active', text: groqReadiness().configured
      ? 'Sending the invoice and retrieved Hindsight evidence to Groq.'
      : 'Groq is not configured; preparing a conservative backend fallback.' })

    let llmResult
    let llmError = null
    try {
      llmResult = await analyzeInvoiceWithLlm(invoice, memoryResult.results)
      console.info('[server] Groq analysis returned', { vendor: invoice.vendor, risk: llmResult?.riskLevel, recommendation: llmResult?.recommendation })
    } catch (error) {
      llmError = error instanceof LlmServiceError
        ? error
        : new LlmServiceError('Groq analysis failed.', 'unavailable')
      console.error('[server] Groq analysis failed', llmError)
    }

    const analysis = createResponse(invoice, memoryResult, memoryStatus, llmResult, llmError)
    console.info('[server] /api/analyze response ready', { mode: analysis.mode, vendor: analysis.vendor, invoiceNumber: analysis.invoiceNumber })
    emit({ type: 'stage', stage: 'COMPLETE', state: 'complete', text: 'Analysis response prepared from the backend result.' })
    emit({ type: 'result', analysis })
  } catch (error) {
    console.error('[server] /api/analyze unexpected failure', error)
    emit({ type: 'error', message: error instanceof Error ? error.message : 'Invoice analysis failed unexpectedly. Check backend logs and service configuration.' })
  } finally {
    response.end()
  }
})

app.post('/api/memory/resolutions', async (request, response) => {
  const invoiceBody = request.body?.invoice
  const vendor = String(invoiceBody?.vendor ?? '').trim()
  const invoiceNumber = String(invoiceBody?.number ?? '').trim()
  const decision = String(request.body?.decision ?? '').trim()
  const resolution = String(request.body?.resolution ?? '').trim()
  const analysis = request.body?.analysis
  if (!vendor || !invoiceNumber || !decision || !resolution) {
    response.status(400).json({ error: 'Invoice, decision, and resolution are required.' })
    return
  }
  if (!['approved', 'correction requested'].includes(decision.toLowerCase())) {
    response.status(400).json({ error: 'Decision must be approved or correction requested.' })
    return
  }

  const issues = Array.isArray(analysis?.detectedIssues) ? analysis.detectedIssues : []
  const content = [
    'Accounts payable invoice outcome and resolution.',
    `Vendor: ${vendor}.`,
    `Invoice: ${invoiceNumber}.`,
    `Amount: ${String(invoiceBody.amount ?? 'not supplied')} ${String(invoiceBody.currency ?? 'INR')}.`,
    `Tax: ${String(invoiceBody.tax ?? 'not supplied')} ${String(invoiceBody.currency ?? 'INR')}.`,
    `Payment terms: ${String(invoiceBody.paymentTerms || 'not supplied')}.`,
    `Issue: ${issues.length ? issues.join('; ') : 'No issue recorded by the agent.'}`,
    `Resolution: ${resolution}.`,
    `Outcome: ${decision.toLowerCase() === 'approved' ? 'Invoice approved.' : 'Correction requested; invoice not approved.'}`,
  ].join('\n')

  try {
    const retained = await retainMemory({
      content,
      context: `Accounts payable resolution for ${vendor} invoice ${invoiceNumber}.`,
      tags: ['accounts-payable', 'invoice-resolution', vendor.toLowerCase().replace(/[^a-z0-9]+/g, '-')],
      timestamp: new Date().toISOString(),
    })
    response.status(201).json({ status: 'retained', bankId: retained.bankId, result: retained.result })
  } catch (error) {
    const serviceError = error instanceof MemoryServiceError
      ? error
      : new MemoryServiceError('Hindsight retain failed.', 'unavailable')
    response.status(serviceError.status).json({ status: 'unavailable', code: serviceError.code, message: serviceError.message })
  }
})

export { createResponse, normalizeInvoice, buildRecallQuery }

app.listen(port, () => {
  console.log(`Invoice agent API listening on http://localhost:${port}`)
})
