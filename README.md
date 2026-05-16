# ServiceNow Voice Assistant

An accessible, voice-powered interface for ServiceNow ticket management — designed specifically for blind and visually impaired users.

## Features

- **Speech-to-text** via OpenAI Whisper (high accuracy, language-aware)
- **Natural language understanding** via Claude — says "my laptop won't connect" and it creates the ticket
- **Text-to-speech feedback** — every action is read aloud via the Web Speech API
- **Fully keyboard accessible** — Space to record, Escape to stop/cancel
- **Screen-reader compatible** — ARIA live regions, labels, roles throughout
- **High-contrast, large-text UI** — WCAG AA compliant

## Voice Commands

| What you say | What happens |
|---|---|
| "Create a ticket for my email is not working" | Opens an incident in ServiceNow |
| "List my tickets" | Fetches and reads your open tickets |
| "Resolve ticket INC0001234" | Marks the incident as resolved |
| "Update ticket INC0001234 with I restarted my computer" | Adds a comment to the ticket |
| "What is the status of ticket INC0001234" | Reads out the current state |

## Tech Stack

- **Next.js 14** (App Router + serverless API routes)
- **OpenAI Whisper** — speech-to-text
- **Anthropic Claude** — intent classification
- **ServiceNow REST API** — ticket CRUD
- **Tailwind CSS** — accessible styling
- **Web Speech API** — text-to-speech feedback

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/servicenow-voice-assistant.git
cd servicenow-voice-assistant
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
SERVICENOW_INSTANCE_URL=https://dev12345.service-now.com
SERVICENOW_USERNAME=admin
SERVICENOW_PASSWORD=your-password
```

### 3. Run locally

```bash
npm run dev
# Open http://localhost:3000
```

## Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → import your GitHub repo
3. In **Environment Variables**, add all five variables from `.env.example`
4. Click **Deploy**

That's it — Vercel handles the build automatically.

## Accessibility Notes

- The app announces every state change via an ARIA live region (`role="status" aria-live="polite"`)
- All interactive elements have descriptive `aria-label` attributes
- A skip-navigation link is present for keyboard-only users
- Focus is managed after actions so screen readers stay in context
- The microphone button uses `aria-pressed` and `aria-busy` states

## ServiceNow Developer Instance

Sign up free at [developer.servicenow.com](https://developer.servicenow.com) to get a personal dev instance. Use those credentials in `.env.local`.
