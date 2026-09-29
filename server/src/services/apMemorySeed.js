import { recallMemory, retainMemory } from './memoryService.js'

export const AP_MEMORY_SEED_TAG = 'ap-agent-bootstrap-v1'

export const initialApMemories = [
  {
    content: 'Vendor history: ABC Cloud Services provides cloud platform subscriptions. The agreed payment terms are 30 days. Prior invoices from this vendor have been approved after discrepancies were corrected.',
    context: 'Accounts payable vendor history for ABC Cloud Services.',
    tags: ['accounts-payable', 'vendor-history', 'abc-cloud-services', AP_MEMORY_SEED_TAG],
    timestamp: '2026-06-14T00:00:00Z',
  },
  {
    content: 'Previous invoice INV-0981 from ABC Cloud Services: taxable amount ₹1,50,000. The vendor invoice understated the agreed 18% tax as ₹16,200 instead of ₹27,000, a ₹10,800 discrepancy.',
    context: 'Accounts payable prior invoice and tax discrepancy.',
    tags: ['accounts-payable', 'invoice-issue', 'tax-discrepancy', 'abc-cloud-services', AP_MEMORY_SEED_TAG],
    timestamp: '2026-06-14T00:00:00Z',
  },
  {
    content: 'Resolution for ABC Cloud Services invoice INV-0981: Accounts Payable requested a corrected tax calculation. The vendor reissued the invoice with ₹27,000 tax at the agreed 18% rate. The corrected invoice was approved and paid within the 30-day payment terms.',
    context: 'Accounts payable prior resolution and outcome.',
    tags: ['accounts-payable', 'resolution', 'approved-outcome', 'abc-cloud-services', AP_MEMORY_SEED_TAG],
    timestamp: '2026-06-16T00:00:00Z',
  },
  {
    content: 'Vendor history: Northstar Office Co. invoices are due in 30 days. Invoice NS-2026-041 contained a duplicate chair line. The vendor removed the duplicate line and reissued the invoice before payment; the corrected invoice was approved.',
    context: 'Accounts payable vendor history, duplicate discrepancy, and resolution.',
    tags: ['accounts-payable', 'vendor-history', 'duplicate-invoice', 'northstar-office'],
    timestamp: '2026-08-19T00:00:00Z',
  },
  {
    content: 'Vendor history: Juniper Cloud software invoices use net-30 payment terms. Verify the subscription period against the contracted billing cycle before approval.',
    context: 'Accounts payable software vendor payment terms.',
    tags: ['accounts-payable', 'vendor-history', 'payment-terms', 'juniper-cloud'],
    timestamp: '2026-07-02T00:00:00Z',
  },
]

export async function ensureInitialApMemories() {
  const existing = await recallMemory('Accounts payable agent initial memory dataset marker', {
    tags: [AP_MEMORY_SEED_TAG],
    maxTokens: 512,
  })
  if (existing.results.length > 0) return { status: 'already_seeded', count: existing.results.length }

  const retained = await retainMemory(initialApMemories)
  return { status: 'seeded', count: initialApMemories.length, result: retained.result }
}