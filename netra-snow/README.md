# Netra on ServiceNow 🎙️ v2.0.0

A voice-first, fully accessible assistant that runs **natively inside ServiceNow** as a scoped application. Zero external services, zero recurring cost. Designed for blind and visually-impaired ServiceNow users.

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

### Tickets
| You say | Netra does |
|---|---|
| *"Create a ticket for my email is broken"* | Opens INC, reads back the number |
| *"Open a ticket"* | Asks *"Sure, what's the issue?"* — you reply, she opens it |
| *"List my tickets"* / *"What's on my plate?"* | Reads up to 5 open tickets |
| *"Resolve INC0001234"* / *"Close INC0001234"* | Marks resolved |
| *"Resolve a ticket"* | Asks *"Which I N C number?"* |
| *"Update INC0001234 with I rebooted"* | Adds comment |
| *"Status of INC0001234"* | Reads state + priority + assignee |

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
