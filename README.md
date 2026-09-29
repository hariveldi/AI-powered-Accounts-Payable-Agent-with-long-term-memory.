AI Accounts Payable Agent

An AI-powered Accounts Payable (AP) Agent with long-term organizational memory. The system analyzes invoice PDFs, retrieves relevant past experiences from Hindsight, uses Grok for reasoning, and provides an explainable recommendation to the AP user.

🚀 Overview

Accounts Payable teams handle a large number of invoices from different vendors. Manually checking invoice details and remembering how previous exceptions were handled can be time-consuming.

Our prototype combines AI reasoning + organizational memory to assist with this process.

Instead of manually entering invoice information, the user simply uploads an invoice PDF. The system extracts the invoice information, searches previous experiences in Hindsight, and sends the current invoice together with relevant memories to Grok for analysis.

The agent then provides:

Risk level
Confidence
Key findings
Historical context
Recommendation
Explanation for the recommendation
Next action

The final financial decision always remains with the human AP user.

✨ Key Features
📄 Invoice PDF Upload

Upload an invoice directly as a PDF instead of manually entering invoice details.

🔍 Invoice Information Extraction

The backend extracts relevant information from the uploaded invoice, including:

Vendor
Invoice number
Invoice date
Due date
Payment terms
Line items
Taxes
Total amount
🧠 Hindsight Long-Term Memory

Hindsight acts as the agent's organizational memory.

The system retrieves relevant previous invoice experiences, including:

Previous invoice cases
Exceptions
Discrepancies
Previous resolutions

This allows the agent to use historical context when analyzing a new invoice.

🤖 Grok AI Reasoning

The current invoice and relevant historical memories are provided to Grok (openai/gpt-oss-20b).

Grok analyzes the information and produces a structured result containing:

Risk
Confidence
Key findings
Historical context
Recommendation
Reasoning
💡 Explainable Recommendations

The system doesn't only provide a recommendation.

It also explains why that recommendation was generated, allowing the AP user to understand the reasoning behind the result.

👤 Human-in-the-Loop

The AI does not automatically make payments.

The AP user can:

Approve
Request Correction

The human remains responsible for the final decision.

🔄 Resolution Memory

After the decision, the user can choose to save the resolution to Hindsight.

This creates a continuous memory cycle:

Analyze → Decide → Remember → Reuse

🏗️ Architecture
                    ┌──────────────────────┐
                    │     AP User          │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │   React Frontend     │
                    │   Invoice Upload     │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │    Node.js Backend   │
                    │  PDF Processing      │
                    └──────────┬───────────┘
                               │
                    ┌──────────┴───────────┐
                    ▼                      ▼
          ┌──────────────────┐   ┌──────────────────┐
          │     Hindsight    │   │       Grok       │
          │ Long-Term Memory │   │  AI Reasoning    │
          └────────┬─────────┘   └────────┬─────────┘
                   │                      │
                   └──────────┬───────────┘
                              ▼
                    ┌──────────────────────┐
                    │   Agent Analysis     │
                    │ Risk / Findings      │
                    │ Context / Recommend. │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │     AP User          │
                    │ Approve / Correction │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Hindsight RETAIN     │
                    │ Save Resolution      │
                    └──────────────────────┘
🔄 Workflow
Upload Invoice PDF
        ↓
Extract Invoice Information
        ↓
Search Hindsight Memory
        ↓
Retrieve Relevant Experiences
        ↓
Combine Current Invoice + Memory
        ↓
Grok AI Analysis
        ↓
Risk + Findings + Recommendation
        ↓
Human Decision
        ↓
Save Resolution to Hindsight
        ↓
Future Invoices Can Reuse This Experience
🛠️ Tech Stack
Frontend
React
Vite
Backend
Node.js
Express.js
AI
Grok
openai/gpt-oss-20b
Memory
Hindsight
Document Processing
PDF text extraction
Development
JavaScript
REST APIs
Environment variables
🔑 API Flow
Invoice Analysis
POST /api/analyze

Processes the uploaded invoice, retrieves relevant Hindsight memories, sends the information to Grok, and returns the agent analysis.

Hindsight Memory Recall
POST /api/memory/seed

Used for memory-related initialization/processing.

POST /api/memory/resolutions

Stores invoice resolutions back into long-term memory.

Health Check
GET /api/health

Checks whether the backend is running.

🧠 Why Hindsight Matters

A normal invoice AI can analyze the invoice that it receives.

Our agent goes one step further.

It can remember what happened in previous cases.

For example:

Previous Invoice
      ↓
AP Decision
      ↓
Resolution Stored
      ↓
Hindsight Memory
      ↓
Similar Future Invoice
      ↓
Memory Retrieved
      ↓
AI Uses Previous Experience

This allows organizational knowledge to remain useful across future invoice investigations.

🔐 Environment Variables

Create a .env file in the backend/project root:

GROQ_API_KEY=your_groq_api_key
HINDSIGHT_API_KEY=your_hindsight_api_key
HINDSIGHT_BANK_ID=your_hindsight_bank_id
GROQ_MODEL=openai/gpt-oss-20b

Never commit your .env file or API keys to GitHub.

Add:

.env

to .gitignore.

▶️ Running the Project
1. Install dependencies
npm install
2. Start the backend
npm run dev
3. Start the frontend
cd client
npm install
npm run dev

Open the frontend using the local URL shown by Vite.

📊 Example Agent Output
Risk: LOW

Confidence: LOW

Key Findings:
No significant discrepancy detected.

Historical Context:
Relevant previous organizational experiences retrieved
from Hindsight.

Recommendation:
Approve payment.

Why this recommendation?
The invoice information and tax calculations are
consistent and no significant discrepancy was identified.

The user can then choose:

Approve

or

Request Correction

and optionally save the resolution to Hindsight.

🎯 Core Idea

The core idea of this project is:

An AP agent should not only understand the current invoice — it should also remember previous organizational experiences and use them when handling future invoices.

This combines:

Invoice Understanding + AI Reasoning + Long-Term Memory + Human Decision

into a single Accounts Payable workflow.
