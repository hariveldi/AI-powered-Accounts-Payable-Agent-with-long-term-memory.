AI Accounts Payable Agent with Long-Term Organizational Memory

An AI-powered Accounts Payable Agent that analyzes invoice PDFs, retrieves relevant past experiences from long-term memory, reasons over the current invoice, and provides an explainable recommendation while keeping the final decision with the human user.

🚀 Overview

Accounts Payable teams process a large number of invoices from different vendors. Reviewing invoices manually can be time-consuming, especially when similar discrepancies or exceptions have already been handled in the past.

This project combines AI reasoning with long-term organizational memory.

The agent can:

📄 Read invoice PDFs
🔍 Extract relevant invoice information
🧠 Recall relevant previous invoice cases using Hindsight
🤖 Analyze the invoice using Grok
📊 Generate risk and confidence levels
🔎 Identify key findings and discrepancies
💡 Explain the reasoning behind its recommendation
👤 Keep the final decision with the human user
💾 Store invoice resolutions back into Hindsight for future use
🔄 How It Works
                ┌─────────────────┐
                │  Upload Invoice │
                └────────┬────────┘
                         ↓
                ┌─────────────────┐
                │  PDF Processing │
                └────────┬────────┘
                         ↓
                ┌─────────────────┐
                │ Extract Invoice │
                │    Information  │
                └────────┬────────┘
                         ↓
                ┌─────────────────┐
                │ Hindsight Memory│
                │     Recall      │
                └────────┬────────┘
                         ↓
              ┌──────────────────────┐
              │ Invoice + Historical │
              │       Context        │
              └──────────┬───────────┘
                         ↓
                ┌─────────────────┐
                │   Grok AI       │
                │    Reasoning    │
                └────────┬────────┘
                         ↓
                ┌─────────────────┐
                │ Risk / Findings │
                │ Recommendation  │
                └────────┬────────┘
                         ↓
                ┌─────────────────┐
                │  Human Decision │
                │ Approve /       │
                │ Request         │
                │ Correction      │
                └────────┬────────┘
                         ↓
                ┌─────────────────┐
                │ Save Resolution │
                │  to Hindsight   │
                └─────────────────┘
🧠 Long-Term Memory

A key part of the system is Hindsight, which acts as the agent's long-term organizational memory.

Instead of treating every invoice as an isolated task, the agent can retrieve relevant information from previous cases.

For example:

Previous Invoice
      ↓
Discrepancy Found
      ↓
Human Reviews
      ↓
Resolution Saved
      ↓
Future Similar Invoice
      ↓
Hindsight Recalls Previous Case
      ↓
Agent Uses It as Context

This allows previous invoice experiences and resolutions to become useful context for future analysis.

🤖 AI Reasoning

Grok is used as the reasoning layer.

The agent provides Grok with:

Current invoice information
Relevant historical memories
Previous invoice experiences
Resolutions retrieved from Hindsight

Grok then generates a structured analysis containing:

Risk Level
Confidence Level
Key Findings
Historical Context
Recommendation
Reason for Recommendation
👤 Human-in-the-Loop

The AI does not make the final financial decision or transfer money.

Instead, it provides an analysis and recommendation to the Accounts Payable user.

The user can choose:

✅ Approve
🔄 Request Correction

The selected resolution can then be saved into Hindsight.

This creates a continuous memory cycle:

Analyze → Recommend → Human Decision → Remember

🛠️ Tech Stack
Frontend
React
Vite
Backend
Node.js
Express.js
REST APIs
AI
Grok
Model: openai/gpt-oss-20b
Memory
Hindsight
Long-term organizational memory
Document Processing
PDF text extraction
📁 Project Structure
project/
│
├── frontend/
│   ├── src/
│   ├── public/
│   └── ...
│
├── backend/
│   ├── services/
│   ├── routes/
│   ├── server.js
│   └── ...
│
├── .env
├── package.json
└── README.md

The exact folder structure may vary depending on the current project implementation.

🔑 Environment Variables

Create a .env file in the backend/root environment:

GROQ_API_KEY=your_groq_api_key
HINDSIGHT_API_KEY=your_hindsight_api_key
HINDSIGHT_BANK_ID=your_hindsight_bank_id
GROQ_MODEL=openai/gpt-oss-20b
⚠️ Security

Never commit your .env file or API keys to GitHub.

Add:

.env

to your .gitignore.

🔌 API Endpoints
Health Check
GET /api/health

Checks whether the backend is running.

Seed Memory
POST /api/memory/seed

Adds initial organizational memories to Hindsight.

Analyze Invoice
POST /api/analyze

Processes the uploaded invoice, recalls relevant memories, and sends the information to the AI reasoning layer.

Save Resolution
POST /api/memory/resolutions

Stores the user's final invoice resolution in Hindsight.

▶️ Running the Project
1. Install dependencies

Frontend:

npm install

Backend:

npm install
2. Configure environment variables

Add the required API keys to .env.

3. Start the backend
npm run dev
4. Start the frontend
npm run dev

Open the frontend in your browser.

📊 Example Analysis

The agent can produce results such as:

Risk: LOW

Confidence: LOW

Key Findings:
No significant discrepancy detected.

Historical Context:
Previous invoice cases and resolutions retrieved
from organizational memory.

Recommendation:
Approve payment.

Why:
Invoice information and available tax calculations
appear consistent with the available context.

The confidence level communicates how certain the AI is about its analysis, allowing the user to apply appropriate human review.

🔐 Important Design Principle

The system follows a human-in-the-loop approach.

The AI:

Reads → Recalls → Reasons → Recommends

The human:

Reviews → Decides → Resolves

The system then:

Remembers the resolution for future cases.

💡 Core Idea

The goal is not simply to build an AI that can read invoices.

The goal is to create an agent that can:

Understand the current invoice → Remember relevant past experiences → Reason using that context → Explain its recommendation → Keep humans in control → Remember the final resolution.

This creates an AI workflow where organizational experience can continuously become part of future invoice analysis.

📌 Disclaimer

This project is intended for demonstration and educational purposes. It does not independently authorize payments, transfer funds, or replace human financial decision-making.
