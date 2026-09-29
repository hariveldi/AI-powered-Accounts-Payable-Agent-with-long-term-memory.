import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import Tesseract from 'tesseract.js'

const PDF_WORKER_SOURCE = new URL('../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', import.meta.url).href
pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SOURCE

function normalizeCurrency(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  let cleaned = String(raw ?? '').replace(/[^0-9.,-]/g, '').trim()
  if (!cleaned) return 0

  const negative = cleaned.startsWith('-')
  cleaned = cleaned.replace(/-/g, '')

  if (cleaned.includes(',') && cleaned.includes('.')) {
    cleaned = cleaned.replace(/,/g, '')
  } else if (!cleaned.includes(',') && cleaned.includes('.')) {
    const [whole, fractional = ''] = cleaned.split('.')
    if (fractional.length >= 3 && whole.length <= 3 && !/[A-Za-z]/.test(cleaned)) {
      cleaned = `${whole}${fractional}`
    }
  }

  const normalized = cleaned.replace(/,/g, '')
  const typed = Number(normalized)
  return Number.isFinite(typed) ? (negative ? -typed : typed) : 0
}

function normalizeDate(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return ''

  const isoLike = value.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (isoLike) return `${isoLike[1]}-${String(isoLike[2]).padStart(2, '0')}-${String(isoLike[3]).padStart(2, '0')}`

  const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const textual = value.match(/(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{4})/i)
  if (textual) {
    const [, day, month, year] = textual
    return `${year}-${String(monthNames.indexOf(month.toLowerCase()) + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const slashMatch = value.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
  if (slashMatch) {
    const [, first, second, third] = slashMatch
    const year = third.length === 2 ? `20${third}` : third
    const firstNumber = Number(first)
    const secondNumber = Number(second)
    if (firstNumber > 12 && secondNumber <= 12) {
      return `${year}-${String(secondNumber).padStart(2, '0')}-${String(firstNumber).padStart(2, '0')}`
    }
    if (secondNumber > 12 && firstNumber <= 12) {
      return `${year}-${String(firstNumber).padStart(2, '0')}-${String(secondNumber).padStart(2, '0')}`
    }
    return `${year}-${String(secondNumber).padStart(2, '0')}-${String(firstNumber).padStart(2, '0')}`
  }

  return value
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/\r/g, ' ')
    .replace(/[\u0000-\u001F\u007F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanField(value) {
  return String(value ?? '')
    .replace(/^[\-:•*,;\s]+|[\-:•*,;\s]+$/g, '')
    .replace(/\bhesing\b/gi, 'hosting')
    .replace(/\bNetdo\b/gi, 'Net 30')
    .replace(/\bNeto\b/gi, 'Net 30')
    .replace(/\bInfsys\b/gi, 'Infosys')
    .replace(/\bTox\b/gi, 'Tax')
    .replace(/\b([A-Za-z]+)Lid\b/gi, '$1 Ltd.')
    .replace(/\bLid\b/gi, 'Ltd.')
    .replace(/\b([A-Za-z]+)Ltd\b/gi, '$1 Ltd.')
    .replace(/\s+/g, ' ')
    .trim()
}

function getFirstMeaningfulLine(lines, pattern) {
  return lines.find((line) => pattern.test(line)) ?? ''
}

function isNoiseLine(line) {
  return /(?:invoice|date|amount|tax|gst|cgst|sgst|igst|total|payment|terms|due|description|status|pending|review|vendor|supplier|bill\s*to|net\s*\d|inr|₹|%)/i.test(line)
}

function findMoneyValue(text, labels) {
  const safeLabels = labels
    .slice()
    .sort((left, right) => right.length - left.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')
  const pattern = new RegExp(`(?<![A-Za-z])(?:${safeLabels})(?![A-Za-z])\\s*(?:\\([^)]*\\)|[:\\-])?\\s*(?:INR|₹)?\\s*(?:m)?\\s*([0-9][0-9,]*(?:\\.\\d{1,6})?)`, 'i')
  const result = text.match(pattern)
  return result ? result[1] : ''
}

function stripTrailingAmount(value) {
  return String(value ?? '')
    .replace(/\s+[0-9][0-9,]*(?:\.\d{1,6})?\s*$/, '')
    .replace(/\s+\d{1,2}%\s*$/, '')
    .trim()
}

function dedupeVendor(value) {
  return cleanField(value)
    .replace(/\s+(?:description|amount|tax|total|gst|balance|status|pending|review|due|net(?:\s*\d+)?|neto|terms?|payment\s*terms?|invoice|bill\s*to|vendor|supplier)[\s:.-].*$/i, '')
    .replace(/\s+[0-9][0-9,]*(?:\.\d{1,6})?\s*$/g, '')
    .replace(/\b(?:invoice|bill to|vendor|supplier|terms|status|date|due|total|amount|pending|review)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function extractInvoiceDataFromText(rawText) {
  const sourceLines = String(rawText ?? '').split(/\r?\n|\r/).map((line) => cleanText(line)).filter(Boolean)
  const text = cleanText(rawText)
  if (!text) {
    return {
      vendor: null,
      number: null,
      date: null,
      dueDate: null,
      subtotal: null,
      tax: null,
      total: null,
      amount: null,
      paymentTerms: null,
      description: null,
      sourceText: '',
      extractionConfidence: 'low',
    }
  }

  const invoiceNumber = text.match(/(?:invoice\s*(?:no|number)?|inv(?:oice)?\s*#?)\s*[:#.-]?\s*([A-Z]{1,6}[- ]?\d{3,})/i)?.[1] ??
    text.match(/\b([A-Z]{2,}-\d{3,})\b/)?.[1] ??
    text.match(/(?:inv(?:oice)?\s*#?)\s*[:#.-]?\s*([A-Z0-9-]*\d[A-Z0-9-]*)/i)?.[1] ??
    null

  const labeledVendorIndex = sourceLines.findIndex((line) => /\b(?:from|vendor|supplier)\b/i.test(line))
  const billToIndex = sourceLines.findIndex((line) => /bill\s*to/i.test(line))
  const explicitVendorCandidate = labeledVendorIndex >= 0
    ? (
      sourceLines[labeledVendorIndex].match(/\b(?:vendor|supplier)\s*[:#.-]\s*(.+)$/i)?.[1]
        ?? sourceLines[labeledVendorIndex].match(/\bfrom\s*[:#.-]?\s*(.+)$/i)?.[1]
    )?.trim()
      || sourceLines[labeledVendorIndex + 1]?.trim()
      || ''
    : billToIndex >= 0
      ? sourceLines[billToIndex + 1]?.trim() ?? ''
      : ''
  const prefixVendorCandidate = text.match(/^([A-Z][A-Za-z0-9 .&'-]+?)(?=\s+(?:invoice|inv|bill|vendor|supplier|date|payment|total|due|gst|tax)\b)/i)?.[1] ?? ''

  const lineVendorCandidates = sourceLines.filter((line) => {
    if (!/[A-Za-z]/.test(line) || /^\d/.test(line)) return false
    if (isNoiseLine(line)) return false
    if (/(?:\d[.,]?\d*%|[₹₹]|\bINR\b|\b(?:[A-Z]{3,})\b.*\d)/i.test(line)) return false
    return true
  })

  const vendorCandidates = [
    prefixVendorCandidate,
    explicitVendorCandidate,
    ...lineVendorCandidates,
    ...sourceLines.filter((line) => /^(?!.*(?:invoice|date|amount|tax|gst|total|payment|due|description|status|terms|balance|review|receipt|pending|support|hosting|consulting|subscription|monitoring))[A-Za-z][A-Za-z0-9 .&'-]+$/.test(line)).slice(0, 4),
  ].filter(Boolean)

  const dedupedVendorCandidates = [...new Set(vendorCandidates.map((candidate) => dedupeVendor(candidate)).filter((candidate) => candidate && candidate.length > 3 && !/^(?:Bengaluru|India|Net|Terms|Status|Pending|Review|Payment)$/i.test(candidate))) ]

  const vendor = dedupedVendorCandidates.find((candidate) => /(Ltd|Pvt|Services|Technologies|Labs|Inc|LLC|Group|Solutions)/i.test(candidate))
    ?? dedupedVendorCandidates.find((candidate) => candidate.split(/\s+/).length <= 4 && !/^(?:Bengaluru|India|Net|Terms|Status|Pending|Review|Payment)$/i.test(candidate))
    ?? dedupedVendorCandidates[0]
    ?? null

  const subtotalText = findMoneyValue(text, ['subtotal', 'sub total', 'net amount']) ||
    sourceLines
      .filter((line) => /(?:subtotal|sub\s*total|net\s*amount|amount\s*due)\b/i.test(line) && !/tax|gst|vat|total|balance/i.test(line))
      .map((line) => line.match(/([0-9][0-9,]*(?:\.\d{1,6})?)(?!.*\d)/)?.[1] ?? '')
      .find(Boolean) ||
    ''
  const taxText = findMoneyValue(text, ['gst', 'tax', 'vat', 'sales tax', 'tox', 'cgst', 'sgst', 'igst'])
    || sourceLines
      .filter((line) => /(gst|tax|vat|cgst|sgst|igst|tox)/i.test(line))
      .map((line) => {
        const matches = line.match(/(?:gst|tax|vat|cgst|sgst|igst|tox)[^\d%]*[A-Za-z]*\s*([0-9][0-9,]*(?:\.\d{1,6})?)/i)
        return matches?.[1] ?? null
      })
      .find(Boolean)
    || ''
  const totalText = findMoneyValue(text, ['total due', 'total', 'grand total'])
  const computedTotal = subtotalText && taxText ? Number(normalizeCurrency(subtotalText)) + Number(normalizeCurrency(taxText)) : null

  const descriptionAmountText = sourceLines
    .filter((line) => /description|services?|support|hosting|consulting|subscription|monitoring/i.test(line) && !/tax|gst|total|due|balance|amount\s*[:=]/i.test(line) && /[0-9]/.test(line))
    .map((line) => {
      const numericMatch = line.match(/(?:[A-Za-z\s&/.-]+)?([0-9][0-9,]*(?:\.\d{1,6})?)(?!.*\d)/i)
      return numericMatch?.[1] ?? ''
    })
    .find(Boolean) || ''

  const amountMatch = text.match(/(?:total\s*amount|grand\s*total|invoice\s*total|amount\s*payable|net\s*amount|amount\s*due|balance\s*due)\s*[:\-]?\s*(?:INR|₹)?\s*([0-9,]+(?:\.\d{1,6})?)/i) ??
    text.match(/(?:amount)\s*[:\-]?\s*(?:INR|₹)?\s*([0-9,]+(?:\.\d{1,6})?)/i) ??
    null

  const invoiceDate = text.match(/(?:invoice\s*date|date)\s*[:\-]?\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4}|[0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2}|[0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4})/i)?.[1] ??
    text.match(/\b(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})\b/)?.[1] ??
    null

  const dueDate = text.match(/(?:due\s*date|payment\s*due)\s*[:\-]?\s*([0-9]{1,2}[/-][0-9]{1,2}[/-][0-9]{2,4}|[0-9]{4}[-/.][0-9]{1,2}[-/.][0-9]{1,2}|[0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4})/i)?.[1] ??
    null

  const paymentTermsLine = getFirstMeaningfulLine(sourceLines, /payment\s*terms?/i) || getFirstMeaningfulLine(sourceLines, /terms?/i)
  const paymentTerms = paymentTermsLine
    ? cleanField(paymentTermsLine.replace(/^.*?payment\s*terms?\s*[:\-]?/i, '').replace(/^.*?terms?\s*[:\-]?/i, '').trim())
    : text.match(/payment\s*terms?\s*[:\-]?\s*([A-Za-z0-9 &.,/-]{2,80})/i)?.[1]?.trim() ?? null

  const descriptionLine = sourceLines.find((line) => /description/i.test(line) && !/amount|tax|total|due|balance|gst|subtotal/i.test(line))
    || sourceLines.find((line) => /services?|support|hosting|consulting|subscription|monitoring/i.test(line) && !/tax|gst|total|due|balance|amount/i.test(line))
    || getFirstMeaningfulLine(sourceLines, /services?|support|hosting|consulting|subscription|monitoring/i)
  const description = descriptionLine
    ? (() => {
        const cleaned = cleanField(stripTrailingAmount(descriptionLine.replace(/^.*?description\s*[:\-]?/i, '').trim()))
        if (!cleaned || /^(amount|tax|total|due|balance|gst|subtotal)$/i.test(cleaned)) return null
        return cleaned
      })()
    : text.match(/(?:services?|subscription|support|hosting|platform|consulting|monitoring)\s+[A-Za-z0-9 &.,/-]{6,120}/i)?.[0]?.trim() ?? null

  const normalizedSubtotal = subtotalText ? Number(normalizeCurrency(subtotalText)) : null
  const normalizedTax = taxText ? Number(normalizeCurrency(taxText)) : null
  const normalizedTotal = totalText ? Number(normalizeCurrency(totalText)) : computedTotal
  const normalizedAmount = amountMatch
    ? Number(normalizeCurrency(amountMatch[1] ?? '0'))
    : descriptionAmountText
      ? Number(normalizeCurrency(descriptionAmountText))
      : normalizedSubtotal ?? normalizedTotal ?? null

  return {
    vendor,
    number: invoiceNumber,
    date: invoiceDate ? normalizeDate(invoiceDate) : null,
    dueDate: dueDate ? normalizeDate(dueDate) : null,
    subtotal: normalizedSubtotal,
    tax: normalizedTax,
    total: normalizedTotal,
    amount: normalizedAmount,
    paymentTerms: paymentTerms && paymentTerms.length > 1 ? paymentTerms : null,
    description: description && description.length > 2 ? description : null,
    sourceText: text,
    extractionConfidence: invoiceNumber && vendor && (normalizedTotal ?? normalizedAmount) ? 'medium' : 'low',
  }
}

async function extractPdfText(file) {
  const source = file?.buffer instanceof Buffer
    ? new Uint8Array(file.buffer)
    : new Uint8Array(await file.arrayBuffer())
  const pdfDoc = await pdfjsLib.getDocument({
    data: source,
    standardFontDataUrl: new URL('../../../node_modules/pdfjs-dist/legacy/build/gmrv1.2/', import.meta.url).href,
  }).promise
  const pages = []

  for (let pageIndex = 1; pageIndex <= pdfDoc.numPages; pageIndex += 1) {
    const page = await pdfDoc.getPage(pageIndex)
    const content = await page.getTextContent()
    const pageText = content.items.map((item) => item.str).join(' ')
    pages.push(pageText)
  }

  return pages.join('\n')
}

async function extractImageText(file) {
  const imageSource = file?.buffer instanceof Buffer
    ? file.buffer
    : Buffer.from(await file.arrayBuffer())

  const result = await Tesseract.recognize(imageSource, 'eng', {
    logger: () => {},
  })
  return result?.data?.text ?? ''
}

export async function extractInvoiceFromFile(file) {
  if (!file) throw new TypeError('An invoice file is required.')

  const fileName = String(file.originalname ?? file.name ?? '').toLowerCase()
  const mimeType = String(file.mimetype ?? file.type ?? '').toLowerCase()
  const displayName = String(file.originalname ?? file.name ?? 'uploaded_invoice')

  if (fileName.endsWith('.pdf')) {
    const text = await extractPdfText(file)
    const invoice = extractInvoiceDataFromText(text)
    return { ...invoice, filename: displayName, fileSize: `${(file.size / (1024 * 1024)).toFixed(1)} MB` }
  }

  if (mimeType.startsWith('image/') || /\.(png|jpg|jpeg)$/i.test(fileName)) {
    const text = await extractImageText(file)
    const invoice = extractInvoiceDataFromText(text)
    return { ...invoice, filename: displayName, fileSize: `${(file.size / (1024 * 1024)).toFixed(1)} MB` }
  }

  throw new TypeError('Unsupported invoice file type. Please upload a PDF or image invoice.')
}
