import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Check,
  FileText,
  LoaderCircle,
  MemoryStick,
  RotateCcw,
  Sparkles,
  Upload,
} from 'lucide-react'
import './App.css'

type AgentStage = 'IDLE' | 'RECEIVING' | 'READING' | 'UNDERSTANDING' | 'MEMORY_SEARCH' | 'MEMORY_FOUND' | 'MEMORY_UNAVAILABLE' | 'COMPARING' | 'REASONING' | 'COMPLETE' | 'SAVING' | 'SAVED'
type ActivityState = 'active' | 'complete'
type Activity = { id: string; text: string; state: ActivityState }
type Memory = { id: string; kind: string; title: string; detail: string; date: string; context?: string; score?: number | null }
type ServiceStatus = { configured: boolean; missing?: string[]; seed?: string; model?: string }

type InvoiceDraft = {
  filename: string
  fileSize: string
  previewUrl: string
}

type Analysis = {
  mode: 'live' | 'fallback'
  vendor: string
  invoiceNumber: string
  amount: number
  tax: number
  paymentTerms: string
  memoryFound: boolean
  memories: Memory[]
  previousIssue: string
  previousResolution: string
  outcome: string
  recommendation: string
  response: string
  risk: 'LOW' | 'MEDIUM' | 'HIGH'
  confidence: number | 'High' | 'Medium' | 'Low'
  detectedIssues: string[]
  historicalContext: Memory[]
  reasoningSummary: string
  memoryStatus: { status: 'ready' | 'unavailable'; message: string; returnedCount: number; code?: string }
  llmStatus: { status: 'ready' | 'unavailable'; message?: string; model?: string }
}

type Decision = 'approved' | 'correction requested'

const emptyInvoice: InvoiceDraft = {
  filename: '',
  fileSize: '',
  previewUrl: '',
}

function App() {
  const [invoice, setInvoice] = useState<InvoiceDraft>(emptyInvoice)
  const [stage, setStage] = useState<AgentStage>('IDLE')
  const [activity, setActivity] = useState<Activity[]>([])
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [decision, setDecision] = useState<Decision | null>(null)
  const [resolution, setResolution] = useState('')
  const [message, setMessage] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [liveMemories, setLiveMemories] = useState<Memory[]>([])
  const [memoryCount, setMemoryCount] = useState(0)
  const [showAllMemories, setShowAllMemories] = useState(false)
  const [backendStatus, setBackendStatus] = useState<{ hindsight: ServiceStatus; groq: ServiceStatus } | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((response) => {
        if (!response.ok) throw new Error('Backend health check failed')
        return response.json() as Promise<{ services: { hindsight: ServiceStatus; groq: ServiceStatus } }>
      })
      .then((health) => setBackendStatus(health.services))
      .catch(() => setBackendStatus(null))
  }, [])

  function attachFile(file?: File) {
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setMessage('Upload a PDF invoice only. The agent flow expects a PDF document.')
      setStage('IDLE')
      return
    }
    if (invoice.previewUrl) URL.revokeObjectURL(invoice.previewUrl)
    const previewUrl = ''
    setSelectedFile(file)
    setInvoice((current) => ({ ...current, filename: file.name, fileSize: `${(file.size / (1024 * 1024)).toFixed(1)} MB`, previewUrl }))
    setMessage('Invoice PDF attached and ready for analysis.')
    setAnalysis(null)
    setDecision(null)
    setResolution('')
    setStage('IDLE')
    setActivity([])
    setLiveMemories([])
    setMemoryCount(0)
    setShowAllMemories(false)
  }

  function removeFile() {
    if (invoice.previewUrl) URL.revokeObjectURL(invoice.previewUrl)
    setSelectedFile(null)
    if (fileInput.current) fileInput.current.value = ''
    setInvoice((current) => ({ ...current, ...emptyInvoice, previewUrl: '' }))
    setAnalysis(null)
    setDecision(null)
    setResolution('')
    setActivity([])
    setLiveMemories([])
    setMemoryCount(0)
    setShowAllMemories(false)
    setStage('IDLE')
    setMessage('')
  }

  async function analyzeInvoice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!invoice.filename) {
      setMessage('Upload a PDF invoice before starting analysis.')
      return
    }

    const file = selectedFile ?? fileInput.current?.files?.[0] ?? null
    if (!file) {
      setMessage('No PDF invoice file is attached.')
      return
    }

    console.info('[client] analyzeInvoice start', { filename: file.name, size: file.size, type: file.type })
    setMessage('')
    setAnalysis(null)
    setDecision(null)
    setResolution('')
    setActivity([])
    setLiveMemories([])
    setMemoryCount(0)
    setShowAllMemories(false)
    setStage('RECEIVING')

    let response: Response | null = null
    try {
      const formData = new FormData()
      formData.append('file', file)

      response = await fetch('/api/analyze', {
        method: 'POST',
        body: formData,
      })
      console.info('[client] analyzeInvoice response', { status: response.status, ok: response.ok, contentType: response.headers.get('content-type') })

      if (!response.ok) {
        const rawBody = await response.text()
        let errorPayload: { error?: string; message?: string } | null = null
        if (rawBody) {
          try {
            errorPayload = JSON.parse(rawBody) as { error?: string; message?: string }
          } catch {
            console.error('[client] malformed error response', rawBody)
          }
        }
        throw new Error(errorPayload?.error || errorPayload?.message || `Agent analysis failed with HTTP ${response.status}.`)
      }

      if (!response.body) throw new Error('Backend did not provide an analysis event stream.')

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let completedAnalysis: Analysis | null = null
      let eventNumber = 0

      const processLine = (line: string) => {
        if (!line.trim()) return
        try {
          const agentEvent = JSON.parse(line) as {
            type: 'stage' | 'result' | 'error'
            stage?: AgentStage
            text?: string
            state?: ActivityState
            count?: number
            memories?: Memory[]
            analysis?: Analysis
            message?: string
          }

          if (agentEvent.type === 'stage' && agentEvent.stage && agentEvent.text) {
            setStage(agentEvent.stage)
            setActivity((current) => {
              const finished = current.map((item) => item.state === 'active' ? { ...item, state: 'complete' as const } : item)
              return [...finished, {
                id: `backend-${eventNumber++}`,
                text: agentEvent.text!,
                state: agentEvent.state ?? (agentEvent.stage === 'MEMORY_SEARCH' || agentEvent.stage === 'REASONING' ? 'active' : 'complete'),
              }]
            })
            if (agentEvent.stage === 'MEMORY_FOUND') {
              setMemoryCount(agentEvent.count ?? 0)
              setLiveMemories(agentEvent.memories ?? [])
            }
            return
          }

          if (agentEvent.type === 'result' && agentEvent.analysis) {
            completedAnalysis = agentEvent.analysis
            setAnalysis(agentEvent.analysis)
            setLiveMemories(agentEvent.analysis.memories)
            setMemoryCount(agentEvent.analysis.memories.length)
            return
          }

          if (agentEvent.type === 'error') {
            throw new Error(agentEvent.message || 'Agent analysis failed. Please try again.')
          }
        } catch (parseError) {
          console.error('[client] failed to parse agent event', { line, error: parseError instanceof Error ? parseError.message : parseError })
          throw parseError instanceof Error ? parseError : new Error('Invoice analysis stream is malformed.')
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) processLine(line)
        if (done) break
      }

      if (buffer.trim()) processLine(buffer)
      if (!completedAnalysis) throw new Error('Analysis stream ended without a result.')
      setStage('COMPLETE')
      console.info('[client] analyzeInvoice completed', completedAnalysis)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Agent analysis failed. Please try again.'
      console.error('[client] analyzeInvoice failed', error)
      setMessage(messageText)
      setStage('IDLE')
    } finally {
      if (fileInput.current) fileInput.current.value = ''
      setStage((current) => current === 'RECEIVING' ? 'IDLE' : current)
    }
  }

  function chooseDecision(nextDecision: Decision) {
    setDecision(nextDecision)
    const vendorName = analysis?.vendor || 'this vendor'
    setResolution(nextDecision === 'approved'
      ? 'Approved after checking the extracted invoice against the recalled historical evidence.'
      : `Requested a correction from ${vendorName} before payment approval.`)
  }

  async function saveResolution() {
    if (!analysis || !decision) return
    setStage('SAVING')
    setActivity((current) => [...current, { id: 'saving', text: 'Saving experience to agent memory...', state: 'active' }])
    setMessage('')
    try {
      const response = await fetch('/api/memory/resolutions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoice: {
            vendor: analysis?.vendor ?? (invoice.filename || 'Unknown vendor'),
            number: analysis?.invoiceNumber ?? 'N/A',
            date: analysis?.response ? '' : '',
            amount: analysis?.amount ?? 0,
            tax: analysis?.tax ?? 0,
            paymentTerms: analysis?.paymentTerms ?? '',
            description: analysis?.recommendation ?? '',
          },
          decision,
          resolution,
          analysis,
        }),
      })
      if (!response.ok) {
        const result = await response.json() as { message?: string }
        throw new Error(result.message || 'Hindsight did not confirm memory retention.')
      }
      setActivity((current) => current.map((eventItem) => eventItem.id === 'saving' ? { ...eventItem, text: 'Experience added to agent memory', state: 'complete' } : eventItem))
      setStage('SAVED')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Hindsight retain failed; the resolution was not saved.')
      setActivity((current) => current.map((eventItem) => eventItem.id === 'saving' ? { ...eventItem, text: 'Hindsight RETAIN failed; experience was not saved.', state: 'complete' } : eventItem))
      setStage('COMPLETE')
    }
  }

  const busy = ['RECEIVING', 'READING', 'UNDERSTANDING', 'MEMORY_SEARCH', 'MEMORY_FOUND', 'COMPARING', 'REASONING', 'SAVING'].includes(stage)
  const isInvestigating = busy
  const stageCaption: Record<AgentStage, string> = {
    IDLE: 'Ready',
    RECEIVING: 'Receiving invoice...',
    READING: 'Reading invoice...',
    UNDERSTANDING: 'Understanding invoice...',
    MEMORY_SEARCH: 'Searching previous experiences...',
    MEMORY_FOUND: `${memoryCount} relevant memories found`,
    MEMORY_UNAVAILABLE: 'Hindsight memory unavailable',
    COMPARING: 'Comparing with previous experiences...',
    REASONING: 'Reasoning...',
    COMPLETE: 'Recommendation ready',
    SAVING: 'Saving experience...',
    SAVED: 'Experience saved to memory',
  }
  const currentCaption = stage === 'MEMORY_FOUND'
    ? memoryCount ? `${memoryCount} relevant memories found` : 'Hindsight returned no relevant memories'
    : stageCaption[stage]

  const formatConfidence = (value: Analysis['confidence']) => {
    if (typeof value === 'number') return `${value}%`
    return value === 'High' ? 'High' : value === 'Medium' ? 'Medium' : value === 'Low' ? 'Low' : 'Low'
  }

  const getReasoningBullets = (reasoningSummary: string) => {
    const cleaned = reasoningSummary
      .replace(/\s*•\s*/g, ' • ')
      .replace(/\s*[-–]\s*/g, ' • ')
      .split('•')
      .map((item) => item.trim())
      .filter(Boolean)
    return cleaned.length > 0 ? cleaned.slice(0, 3) : ['No significant discrepancy detected.']
  }

  const visibleMemories = analysis ? (showAllMemories ? analysis.memories : analysis.memories.slice(0, 5)) : []
  const historicalSummary = analysis
    ? analysis.historicalContext.length > 0
      ? analysis.historicalContext.slice(0, 2).map((memory) => memory.detail.replace(/\s+/g, ' ').trim()).join(' ')
      : analysis.memories.length > 0
        ? `Previous records for ${analysis.vendor} showed ${analysis.memories.length} relevant experience${analysis.memories.length === 1 ? '' : 's'} that were reviewed before this recommendation.`
        : 'No relevant historical experience found.'
    : 'No relevant historical experience found.'

  return (
    <main className={`agent-app ${isInvestigating ? 'is-investigating' : ''}`}>
      <header className="app-header">
        <a className="wordmark" href="#top"><span className="wordmark-icon"><Sparkles size={16} /></span><span>AI Accounts Payable Agent<small>HINDSIGHT HACKATHON · AP AGENT</small></span></a>
        <span className="prototype-label"><span /> ONLINE <i>·</i> {backendStatus?.hindsight.configured ? 'HINDSIGHT CONFIGURED' : 'HINDSIGHT OFFLINE'}</span>
      </header>

      <section className="intro" id="top">
        <p className="overline">ORGANIZATIONAL MEMORY, AT WORK</p>
        <h1>An agent that learns from what happened before.</h1>
        <p>Give the agent an invoice. It will investigate, recall, reason, and recommend.</p>
      </section>

      {message && <div className="feedback" role="status"><span>{message}</span><button type="button" aria-label="Dismiss" onClick={() => setMessage('')}>×</button></div>}

      <form className="invoice-form" onSubmit={(event) => void analyzeInvoice(event)}>
        <div className="form-heading">
          <div className="form-title"><span className="step-number">INPUT</span><div><h2>Give the agent an invoice</h2><p>Upload an invoice PDF.</p></div></div>
          <input ref={fileInput} className="visually-hidden" type="file" aria-hidden="true" tabIndex={-1} accept=".pdf,application/pdf" onChange={(event) => { const nextFile = event.target.files?.[0]; if (nextFile) { attachFile(nextFile) } }} />
        </div>
        <div className="input-actions"><button className="upload-button" type="button" onClick={() => fileInput.current?.click()} disabled={busy}><Upload size={16} /> Upload PDF</button></div>
        {invoice.filename && <div className="attached-file">{invoice.previewUrl ? <img src={invoice.previewUrl} alt="Invoice preview" /> : <span className="file-icon"><FileText size={17} /></span>}<span className="attached-copy"><strong>{invoice.filename}</strong><small>{invoice.fileSize}</small></span><button type="button" className="remove-file" onClick={removeFile} disabled={busy}>Remove</button></div>}
        <div className="form-submit-row"><span>{invoice.filename ? 'Invoice attached' : 'Upload a PDF invoice to begin.'}</span><button className="analyze-button" type="submit" disabled={busy || !invoice.filename}>{busy ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}Analyze with Agent<ArrowRight size={15} /></button></div>
        {(stage === 'MEMORY_FOUND' || stage === 'MEMORY_UNAVAILABLE' || stage === 'COMPARING' || stage === 'REASONING') && <div className={`memory-discovery ${stage === 'MEMORY_UNAVAILABLE' || (analysis && !analysis.memoryFound) ? 'no-recall' : ''}`}><div className="memory-graph" aria-hidden="true"><span /><span /><span /><span /><span /><span /><i /><i /><i /><i /></div><div><strong>{stage === 'MEMORY_UNAVAILABLE' ? 'Hindsight memory unavailable' : memoryCount ? `${memoryCount} relevant memories found` : 'Hindsight recall returned no relevant memories'}</strong><p>{stage === 'MEMORY_UNAVAILABLE' ? activity.at(-1)?.text : memoryCount ? `Connected experiences from the uploaded invoice` : 'The agent is reasoning without recalled historical evidence.'}</p></div><span className="mock-indicator">{stage === 'MEMORY_UNAVAILABLE' ? 'NOT CONNECTED' : 'HINDSIGHT RECALL'}</span></div>}
      </form>

      <section className="agent-investigation" aria-live="polite">
        <div className="agent-hero">
          <div className={`agent-core stage-${stage.toLowerCase()}`} aria-label={`Agent status: ${currentCaption}`}>
            <div className="core-orbit orbit-one" /><div className="core-orbit orbit-two" /><div className="core-orbit orbit-three" />
            <div className="core-radials" />
            <div className="core-particles"><i /><i /><i /><i /><i /><i /><i /><i /></div>
            <span className="core-node node-one" /><span className="core-node node-two" /><span className="core-node node-three" /><span className="core-node node-four" />
            {(analysis?.memoryFound || stage === 'MEMORY_SEARCH') && ['memory-node-a', 'memory-node-b', 'memory-node-c', 'memory-node-d'].map((node) => <span key={node} className={`memory-node ${node}`} />)}
            {(stage === 'SAVING' || stage === 'SAVED') && <span className="retain-node" />}
            <div className="core-center"><Sparkles size={21} /></div>
          </div>
          <div className="core-status"><span className={`stage-dot ${busy ? 'working' : stage === 'SAVED' ? 'saved' : ''}`} />{currentCaption}</div>
          <p className="core-subtext">{stage === 'IDLE' ? 'Give me an invoice to investigate.' : stage === 'COMPLETE' ? 'I used organizational experience to reach this recommendation.' : stage === 'SAVED' ? 'I will carry this resolution into future reviews.' : 'Following the evidence through your organization’s experience.'}</p>
        </div>

        {activity.length > 0 && <div className="activity-stream"><div className="activity-label">AGENT ACTIVITY <span>{busy ? 'LIVE' : 'COMPLETE'}</span></div>{activity.map((item) => <div className={`activity-item ${item.state}`} key={item.id}><span className="activity-mark">{item.state === 'complete' ? <Check size={12} /> : <span className="activity-pulse" />}</span><span>{item.text}</span></div>)}</div>}

        {liveMemories.length > 0 && (stage === 'MEMORY_FOUND' || stage === 'COMPARING' || stage === 'REASONING') && <div className="live-memories"><div className="memories-title"><MemoryStick size={15} /><span>EXPERIENCES THE AGENT FOUND</span></div><div className="memory-cards">{liveMemories.map((memory, index) => <article className="knowledge-card" key={memory.id} style={{ animationDelay: `${index * 360}ms` }}><span className="knowledge-index">MEMORY 0{index + 1}</span><span className="knowledge-kind">{memory.kind}</span><strong>{memory.title}</strong><p>{memory.detail}</p><small>{memory.date}</small></article>)}</div></div>}

        {analysis && (stage === 'COMPLETE' || stage === 'SAVING' || stage === 'SAVED') && <div className="final-response">
          <div className="response-topline"><span className="complete-label"><Check size={13} /> ANALYSIS COMPLETE</span><button className="reset-button" type="button" onClick={() => { setStage('IDLE'); setActivity([]); setAnalysis(null); setDecision(null); setResolution(''); setShowAllMemories(false) }}><RotateCcw size={13} /> New investigation</button></div>

          <div className="result-panel">
            <div className="result-box">
              <div className="result-heading">RISK</div>
              <div className="result-value risk-value">● {analysis.risk}</div>
            </div>

            <div className="result-box">
              <div className="result-heading">CONFIDENCE</div>
              <div className="result-value">{formatConfidence(analysis.confidence)}</div>
            </div>
          </div>

          <div className="result-section">
            <div className="section-label">KEY FINDINGS</div>
            <ul className="result-list">
              {(analysis.detectedIssues.length ? analysis.detectedIssues : ['No significant discrepancy detected.']).slice(0, 3).map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>

          <div className="result-section">
            <div className="section-label">HISTORICAL CONTEXT</div>
            <p className="result-text">{historicalSummary}</p>
          </div>

          <div className="result-section">
            <div className="section-label">RELEVANT MEMORIES</div>
            <p className="result-text">{analysis.memories.length} relevant memories found{analysis.memories.length > 5 ? ' · showing 5 most relevant' : ''}</p>
            <div className="memory-cards" style={{ marginTop: '10px' }}>
              {visibleMemories.map((memory, index) => (
                <article className="knowledge-card" key={`${memory.id}-${index}`}>
                  <span className="knowledge-index">MEMORY {index + 1}</span>
                  <span className="knowledge-kind">{memory.kind || 'HISTORY'}</span>
                  <strong>{memory.title || memory.kind || 'Relevant memory'}</strong>
                  <p>{memory.detail.replace(/\s+/g, ' ').trim().slice(0, 180)}</p>
                  {memory.score != null && <small>Score: {Number(memory.score).toFixed(2)}</small>}
                </article>
              ))}
            </div>
            {analysis.memories.length > 5 && (
              <button type="button" className="retain-button" style={{ marginTop: '10px', width: 'fit-content' }} onClick={() => setShowAllMemories((current) => !current)}>
                {showAllMemories ? 'Show fewer' : 'View more'}
              </button>
            )}
          </div>

          <div className="result-section">
            <div className="section-label">RECOMMENDATION</div>
            <p className="result-text strong-text">{analysis.recommendation}</p>
          </div>

          <div className="result-section">
            <div className="section-label">WHY THIS RECOMMENDATION?</div>
            <ul className="result-list">
              {getReasoningBullets(analysis.reasoningSummary).map((item) => <li key={item}>{item}</li>)}
            </ul>
          </div>

          <div className="decision-area">
            <p>Next Action</p>
            <div className="decision-buttons">
              <button className={`decision-button approve ${decision === 'approved' ? 'chosen' : ''}`} type="button" onClick={() => chooseDecision('approved')}><Check size={16} /> Approve</button>
              <button className={`decision-button correction ${decision === 'correction requested' ? 'chosen' : ''}`} type="button" onClick={() => chooseDecision('correction requested')}><AlertCircle size={16} /> Request Correction</button>
            </div>
          </div>

          {decision && <div className="retain-panel"><div className="retain-prompt"><span className="retain-icon"><MemoryStick size={17} /></span><div><strong>Should I remember this resolution?</strong><p>Help the agent make better decisions from this experience.</p></div></div><label className="resolution-field" htmlFor="resolution">RESOLUTION<textarea id="resolution" rows={2} value={resolution} onChange={(event) => setResolution(event.target.value)} /></label><button className="retain-button" type="button" disabled={stage === 'SAVING' || stage === 'SAVED' || !resolution.trim()} onClick={() => void saveResolution()}>{stage === 'SAVING' ? <LoaderCircle className="spin" size={15} /> : stage === 'SAVED' ? <Check size={15} /> : <MemoryStick size={15} />}{stage === 'SAVED' ? 'Experience saved to memory' : stage === 'SAVING' ? 'Saving experience...' : 'Save to Memory'}</button><span className="retain-footnote">Hindsight RETAIN · saved to the configured memory bank</span></div>}
        </div>}
      </section>


      <footer className="prototype-footer">AI AP agent <span>·</span> backend integrations <span>·</span> credentials remain server-side</footer>
    </main>
  )
}

export default App
