# Netra on ServiceNow 🎙️ v3.0.0 — R6 "Release X"

A voice-first, fully accessible assistant that runs **natively inside ServiceNow** as a scoped application. Zero external services, zero recurring cost. Designed for blind and visually-impaired ServiceNow users.

---

## v3 "Release X" — what's new

- **Human turn-taking** — interrupt Netra mid-sentence and she yields in ~100 ms (echo-scored hot mic, reflex "stop/wait", volume ducking while you start talking). She interjects politely too: soft "mm-hmm" backchannels, one gentle nudge on unanswered questions, "sorry to cut in" before mid-conversation notifications.
- **Read-only on tickets, by policy and by code** — Netra never creates or modifies tickets (creation tools removed from the model's toolset and hard-refused server-side; mutations gated behind `x_196061_netra_v1.ticket_writes`, default off). She remains the fastest way to *know* about tickets: status, summaries, search, briefings, watchlists.
- **Faster + more natural voice** — sentence-pipelined Edge TTS (first audio 2–4× sooner on long replies), adaptive command debounce (~0.5 s faster), automatic contractions, varied breath breaks, a blinking orb.
- **Expanded conversation limits** — 40-turn / 180 KB history, 8 tool calls per turn, 2048-token replies, 16 K-char inputs, 200-exchange long-term memory.
- **Violet voice-ring identity** — icon/logo/badge redrawn to match the in-app orb + favicon; dev console carries the `R6 · RELEASE X` badge and `TICKETS: READ-ONLY` pill.
- **REST deployment pipeline** — `scripts/deploy-release.mjs` pushes the whole source tree to an instance and captures it in a named update set. See [docs/RELEASE-X.md](docs/RELEASE-X.md).

---

## v2 — what's new

- **Conversational dialogue** — greetings, smalltalk, varied phrasing, "thank you" / "repeat that"
- **Multi-turn flow** — Netra asks follow-up questions (e.g. *"For how many hours should I pause?"*) and remembers context
- **Pause notifications** — natural duration parsing: *"two hours"*, *"30 minutes"*, *"the rest of the day"*
- **Scheduled scanner every 3 minutes** — wakes Netra up to announce new things assigned to you:
  - Incidents newly assigned to you
  - Change requests newly assigned to you
  - Service catalog tasks newly assigned to you
  - Approvals waiting on you
- **Business Rule still fires instantly** on new ticket comments — no 3-min lag for those
- **Bigger Update Set** — Script Includes, Business Rule, AND Scheduled Job all bundled

---

## Voice command reference

### Tickets (read-only since Release X)
| You say | Netra does |
|---|---|
| *"Create a ticket for my email is broken"* | Explains she's read-only, then **searches existing incidents** for "email is broken" and briefs you on what she finds |
| *"List my tickets"* / *"What's on my plate?"* | Reads up to 5 open tickets |
| *"Status of INC0001234"* | Reads state + priority + assignee |
| *"Summarize INC0001234"* | Full spoken summary: description, state, priority, assignee, latest comments |
| *"Watch INC0001234"* | Adds to her watchlist — she announces changes proactively |
| *"Resolve INC0001234"* / *"Update INC0001234 with…"* | Politely declines (modification is disabled unless the admin sets `ticket_writes=true`) |

### Pause / resume notifications
| You say | Netra does |
|---|---|
| *"Pause"* | Asks *"For how many hours should I pause?"* |
| *"Two hours"* (after the question) | Pauses, confirms the resume time |
| *"Pause for thirty minutes"* | Pauses for 30 min, one-shot |
| *"Mute for the rest of the day"* | Pauses ~8 hours |
| *"Resume"* / *"Wake up"* / *"Come back"* | Brings her back |

### Social
| You say | Netra does |
|---|---|
| *"Hi"* / *"Good morning Netra"* | Time-of-day greeting |
| *"Thanks"* / *"Good job"* | Varied acknowledgment |
| *"How are you?"* | Smalltalk reply |
| *"Repeat that"* | Re-speaks her last response |
| *"Help"* | Lists what she can do |
| *"Stop"* / *"Quiet"* / *"Cancel"* | Stops her mid-sentence |

---

## Install

**~3 minutes, two paths:**

| Path | Files | Manual steps |
|---|---|---|
| **A. Background Script (Recommended)** | `install/setup-netra.js` | Create scope (1 click), paste + Run script (1 click), drop widget on page (1 click) |
| B. Update Set XML (batch) | `update-set/Netra_v2.0.0-R4.7_Batch.xml` | Import XML, then Preview & Commit the parent set — children commit automatically |

See [`INSTALL.md`](INSTALL.md) for the click-by-click walkthrough.

## Repository layout

```
netra-snow/
├── README.md                                ← this file
├── INSTALL.md                               ← step-by-step setup
├── install/
│   └── setup-netra.js                       ← single Background Script: creates everything
├── update-set/
│   └── Netra_v2.0.0-R4.7_Batch.xml          ← batch update set: parent + 5 children, single import
├── scripts/
│   ├── build-setup-script.mjs               ← regenerates setup-netra.js from source/ (Node, cross-platform)
│   └── build-update-set.ps1                 ← regenerates the XML from source/
└── source/
    ├── script_includes/
    │   ├── NetraIntent.js                   ← intent parser (regex, smalltalk, multi-turn)
    │   ├── NetraTools.js                    ← incident CRUD + user prefs (pause/resume)
    │   ├── NetraResponder.js                ← composes varied spoken replies
    │   └── NetraScanner.js                  ← periodic scan: assignments, approvals, tasks
    ├── scripted_rest/
    │   ├── command.js                       ← POST /api/x_196061_netra/voice/command
    │   └── notifications.js                 ← GET  /api/x_196061_netra/voice/notifications
    ├── scheduled_jobs/
    │   └── netra_watch.js                   ← runs every 3 min, delegates to NetraScanner
    ├── business_rule/
    │   └── netra_notify_on_comment.js       ← instant alert on ticket comments
    ├── widget/                              ← Service Portal floating-mic widget
    │   ├── template.html
    │   ├── client.js
    │   ├── server.js
    │   ├── stylesheet.scss
    │   └── option_schema.json
    └── tables/
        ├── x_196061_netra_notification.md
        └── x_196061_netra_user_pref.md
```

---

## Architecture

```
                      ┌───────────────────────────────────┐
                      │   Service Portal in Chrome/Edge   │
                      │                                   │
                      │   ┌─────────────────────────────┐ │
                      │   │ Netra Mic widget            │ │
                      │   │                             │ │
                      │   │  ▸ wake word "Netra"        │ │
                      │   │  ▸ Web Speech STT (free)    │ │
                      │   │  ▸ Web Speech TTS (free)    │ │
                      │   │  ▸ pause/resume UI          │ │
                      │   │  ▸ polls /notifications 8s  │ │
                      │   └─────────────────────────────┘ │
                      └────────┬──────────────────────────┘
                               │
                  POST /command│         GET /notifications
                               ▼
   ┌─────────────────────────────────────────────────────────────┐
   │  Scripted REST API                                          │
   │                                                              │
   │  /command         /notifications                             │
   │      │                  │                                    │
   │      ▼                  ▼                                    │
   │  NetraIntent     pause check → if paused, return empty       │
   │      │                                                       │
   │      ▼                                                       │
   │  NetraResponder ──► NetraTools (GlideRecord ops, user prefs) │
   │                                                              │
   │  ────────────────────────────────────────────────────────    │
   │                                                              │
   │  Scheduled Job  "Netra Watch"  ── every 3 minutes ─►         │
   │                       │                                      │
   │                       ▼                                      │
   │                  NetraScanner                                │
   │                       │                                      │
   │     ┌─────────────────┴─────────────────┐                    │
   │     ▼                                   ▼                    │
   │  Iterates active users         For each user, scans:         │
   │  in x_196061_netra_user_pref          • incident.assigned_to        │
   │                                • change_request.assigned_to  │
   │                                • sc_task.assigned_to         │
   │                                • sysapproval_approver        │
   │                                Enqueues into                 │
   │                                x_196061_netra_notification          │
   │                                                              │
   │  Business Rule on sys_journal_field (incident comments)      │
   │  fires instantly — also enqueues to x_196061_netra_notification     │
   └─────────────────────────────────────────────────────────────┘
```

Every notification path lands in `x_196061_netra_notification`. The widget polls and announces. Pause is honored at every layer (widget UI, scanner skips paused users, notifications endpoint returns empty while paused).

---

## Re-generating

After editing any source file:

```powershell
# Regenerate the Background Script (recommended path)
node netra-snow/scripts/build-setup-script.mjs

# Regenerate the Update Set XML (alternative path)
powershell -ExecutionPolicy Bypass -File netra-snow\scripts\build-update-set.ps1
```

Both generators validate the output and report sizes.

## License

MIT
