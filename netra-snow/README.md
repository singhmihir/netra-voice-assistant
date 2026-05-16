# Netra on ServiceNow 🎙️

A voice-first, fully accessible ticket-management assistant that runs **natively inside ServiceNow** as a scoped application — no external services, no API keys, zero cost.

Designed for blind and visually-impaired ServiceNow users.

---

## What it does

- **Voice-to-ticket** — say *"create a ticket for my email is broken"*, Netra opens an incident
- **Voice ticket management** — list, resolve, update, get status, all hands-free
- **Wake word "Netra"** — running in any Service Portal tab; just say her name
- **Push-to-talk** — `Alt+N` or click the floating mic button
- **TTS replies** — Netra speaks back the result of every action
- **Proactive comment alerts** — the moment a colleague comments on your ticket, a Business Rule queues a notification and your open Service Portal tab announces it within 8 seconds
- **Screen-reader friendly** — ARIA live regions, labels, roles throughout; full keyboard navigation

---

## Why on ServiceNow (vs. a desktop app)?

| Concern | Desktop daemon | ServiceNow-native |
|---|---|---|
| Cost | Paid APIs (Whisper, TTS, Claude) | **Free — uses browser Web Speech APIs** |
| Auth to ServiceNow | API key | Native — runs as the logged-in user |
| ACLs / row-level security | Bypassed via admin creds | Enforced by the platform |
| Latency on new comments | Polling every 60s | **Instant — Business Rule fires on insert** |
| Install effort | Python + 12 libs per machine | One Update Set import |
| Distribution | DIY | ServiceNow Store-ready |

The trade-off: Netra only listens while a Service Portal tab is open in your browser. She's not a system-wide always-on daemon. For most ServiceNow users this is exactly the right scope.

---

## How it works

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ServiceNow Scoped App: x_netra                │
│                                                                       │
│  ┌────────────────────────────┐                                       │
│  │  Service Portal Widget     │                                       │
│  │  "netra-mic"               │                                       │
│  │                            │                                       │
│  │  Web Speech STT ──┐        │                                       │
│  │  Wake word: "Netra"        │                                       │
│  │  Floating mic + Alt+N      │                                       │
│  │  SpeechSynthesis TTS ◄─┐   │                                       │
│  └─────┬──────────────────┼───┘                                       │
│        │ transcript       │ spoken reply                              │
│        ▼                  │                                           │
│  ┌─────────────────────────────────┐    ┌─────────────────────────┐  │
│  │  POST /api/x_netra/voice/command│───►│  NetraIntent (regex)    │  │
│  │  (Scripted REST API)            │    │  NetraResponder         │  │
│  │                                 │◄───│  NetraTools (GlideRecord)│ │
│  └─────────────────────────────────┘    └─────────────────────────┘  │
│        ▲                                                              │
│        │ GET /notifications  (polled every 8s)                        │
│        │                                                              │
│  ┌─────┴────────────────────────────┐    ┌─────────────────────────┐ │
│  │  x_netra_notification (table)    │◄───│  Business Rule:         │ │
│  │  user, ticket, kind, message     │    │  Netra Notify On Comment│ │
│  └──────────────────────────────────┘    │  (sys_journal_field, +i)│ │
│                                           └─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

Every piece is plain JavaScript running inside ServiceNow. Zero external dependencies. Zero recurring cost.

---

## Repository layout

```
netra-snow/
├── README.md                           ← you are here
├── INSTALL.md                          ← step-by-step install guide (8 min)
├── update-set/
│   └── netra-v1.0.0.xml                ← importable Update Set (Script Includes + Business Rule)
└── source/
    ├── script_includes/
    │   ├── NetraIntent.js              ← regex-based NL intent parser
    │   ├── NetraTools.js               ← incident CRUD via GlideRecord
    │   └── NetraResponder.js           ← composes spoken replies
    ├── scripted_rest/
    │   ├── command.js                  ← POST /api/x_netra/voice/command
    │   └── notifications.js            ← GET  /api/x_netra/voice/notifications
    ├── widget/
    │   ├── template.html               ← floating dock markup
    │   ├── client.js                   ← STT + wake word + TTS + polling
    │   ├── server.js                   ← server-side bootstrap
    │   ├── stylesheet.scss             ← accessible high-contrast styles
    │   └── option_schema.json
    ├── business_rule/
    │   └── netra_notify_on_comment.js  ← async after-insert on sys_journal_field
    └── tables/
        └── x_netra_notification.md     ← table schema reference
```

---

## Install

See [`INSTALL.md`](INSTALL.md) for the step-by-step walkthrough. Total time ~8 minutes:

1. Create the scoped app `x_netra` in Studio
2. Create the `x_netra_notification` table
3. Import the Update Set (`update-set/netra-v1.0.0.xml`)
4. Paste the Scripted REST API resources
5. Paste the Service Portal widget pieces
6. Drop the widget onto your portal page
7. Test

---

## Try Netra without installing

While Netra is installing, you can also run the [legacy web prototype](../app) at the root of this repo — a Next.js app that simulates Netra's behavior using mock data. Use it to demo the UX before the ServiceNow install.

---

## Voice command reference

| You say | Pattern matched | What Netra does |
|---|---|---|
| *"Create a ticket for my email is down"* | `create … ticket … for X` | Opens INC, reads back the number |
| *"Open a ticket about the printer"* | `open … ticket … about X` | Same |
| *"Report that the wifi is broken"* | `report (that) X` | Same |
| *"List my tickets"* | `(list\|show) … tickets` | Reads up to 5 open tickets |
| *"What's on my plate"* | `what's on my plate` | Same |
| *"Resolve INC0001234"* | `resolve … inc\d+` | Marks resolved |
| *"Close ticket INC0001234"* | `close … inc\d+` | Same |
| *"Update INC0001234 with I rebooted"* | `update inc\d+ with X` | Adds comment |
| *"Comment on INC0001234 — still broken"* | `comment on inc\d+ … X` | Same |
| *"Status of INC0001234"* | `status of inc\d+` | Reads state + assignee |
| *"Tell me about INC0001234"* | `tell me about inc\d+` | Same |
| *"Help"* | — | Lists what Netra can do |
| *"Stop"* / *"Cancel"* / *"Quiet"* | — | Stops Netra mid-sentence |

Ticket numbers tolerate spaces and informal speech (`"I N C 1234"` → `INC0001234`).

---

## License

MIT
