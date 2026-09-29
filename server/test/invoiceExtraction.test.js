import assert from 'node:assert/strict'
import test from 'node:test'
import { extractInvoiceDataFromText } from '../src/services/invoiceExtraction.js'

test('extractInvoiceDataFromText parses invoice metadata from actual document text', () => {
  const text = [
    'Apex Digital Services Pvt. Ltd.',
    'Invoice No. INV-2048',
    'Invoice Date: 15 Oct 2026',
    'Amount Due: INR 2,50,000.00',
    'GST: INR 18,750.00',
    'Payment Terms: Net 30',
    'Description: Managed cloud hosting and support',
  ].join('\n')

  const invoice = extractInvoiceDataFromText(text)

  assert.equal(invoice.vendor, 'Apex Digital Services Pvt. Ltd.')
  assert.equal(invoice.number, 'INV-2048')
  assert.equal(invoice.date, '2026-10-15')
  assert.equal(invoice.amount, 250000)
  assert.equal(invoice.tax, 18750)
  assert.equal(invoice.paymentTerms, 'Net 30')
  assert.equal(invoice.description, 'Managed cloud hosting and support')
})

test('extractInvoiceDataFromText preserves real OCR fields and native Indian invoice values', () => {
  const text = [
    'INVOICE',
    'Infosys',
    'Invoice #INV-2048',
    'Date: 2026.09.26',
    'Bill To',
    'InfosysLid',
    'Description Amount',
    'Cloud hesing and support 1.25000',
    'Tox (18%) m2500',
    'Total Due: 47500',
    'Payment Terms, Netdo',
    'Status Pending review',
  ].join('\n')

  const invoice = extractInvoiceDataFromText(text)

  assert.equal(invoice.vendor, 'Infosys Ltd.')
  assert.equal(invoice.number, 'INV-2048')
  assert.equal(invoice.date, '2026-09-26')
  assert.equal(invoice.amount, 125000)
  assert.equal(invoice.tax, 2500)
  assert.equal(invoice.total, 47500)
  assert.equal(invoice.paymentTerms, 'Net 30')
  assert.equal(invoice.description, 'Cloud hosting and support')
})

test('extractInvoiceDataFromText handles second-vendor invoice patterns without hardcoded values', () => {
  const text = [
    'Northwind Labs Pvt. Ltd.',
    'Invoice No.: INV-9914',
    'Invoice Date: 04/11/2026',
    'Due Date: 18/11/2026',
    'Subtotal: ₹87,500.00',
    'GST: ₹15,750.00',
    'Total: ₹1,03,250.00',
    'Payment Terms: Net 15',
    'Description: Security monitoring and managed support',
  ].join('\n')

  const invoice = extractInvoiceDataFromText(text)

  assert.equal(invoice.vendor, 'Northwind Labs Pvt. Ltd.')
  assert.equal(invoice.number, 'INV-9914')
  assert.equal(invoice.date, '2026-11-04')
  assert.equal(invoice.dueDate, '2026-11-18')
  assert.equal(invoice.subtotal, 87500)
  assert.equal(invoice.tax, 15750)
  assert.equal(invoice.total, 103250)
  assert.equal(invoice.paymentTerms, 'Net 15')
  assert.equal(invoice.description, 'Security monitoring and managed support')
})

test('extractInvoiceDataFromText recognizes a vendor written on the same line as its label', () => {
  const invoice = extractInvoiceDataFromText([
    'Vendor: Apex Digital Services Pvt. Ltd.',
    'Invoice No.: INV-2048',
    'Amount Due: INR 2,50,000.00',
    'GST: INR 18,750.00',
  ].join('\n'))

  assert.equal(invoice.vendor, 'Apex Digital Services Pvt. Ltd.')
})
