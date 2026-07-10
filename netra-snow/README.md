# Netra on ServiceNow 🎙️ v2.0.0 — R5

A voice-first, fully accessible assistant that runs **natively inside ServiceNow** as a scoped Service Portal application. Talk to it; it triages your work, answers questions, and takes action on your behalf under your own permissions.

Netra runs as a floating-mic widget in the Service Portal. The browser handles speech-to-text and text-to-speech (Web Speech + neural TTS), and a single scoped-app server brain — a Gemini function-calling dispatcher over ~90 tools — does all the ServiceNow work. **No paid services; the conversational brain and TTS run on free-tier Gemini + browser/Edge neural voices.** (Earlier docs said "zero external services" — that is only true of the original regex build; the current build calls Gemini's free tier.)

> Designed first for blind and visually-impaired users, but the R5 release makes Netra a genuine **vulnerability-analyst copilot** for ServiceNow Vulnerability Response — see the VR command reference below.

---

## R5 — what's new

**Vulnerability Response analyst suite.** Netra now covers a VR analyst's full day by voice, with proper role-based access (it never bypasses ACLs — a VR role is required):

- **Triage & exposure** — list your queue with rich filters (risk band, CVE, asset, age, SLA), org-wide top risk, exposure summary, most-vulnerable assets, per-asset vulnerabilities, guided "walk me through my queue" mode.
- **Understand** — full VIT detail with CVE summary + remediation, CVE lookup with blast radius, vulnerability-library keyword search.
- **Lifecycle** — assign (with spoken-name disambiguation), change state, **defer with a mandatory reason and optional review date**, **resolve/close with a mandatory note**, **mark false positive**, reopen — every change writes an audit work note.
- **Remediation** — raise a change request straight from a VIT, linked back to it.
- **Scale** — **preview-then-confirm bulk actions** (assign/defer/state/note) across a filter, capped and audited.
- **Reporting** — overdue items, aging buckets, opened-vs-closed trend with rough MTTR, vulnerability groups.
- **Proactive** — the 3-minute scanner now announces vulnerable items newly assigned to you.

**Instance performance tooling.** Ask *"Netra, instance health"* for a read-only snapshot of scheduler load, slow transactions, and integrations. A separate reviewed one-shot script (`install/perf-audit.js`) safely pauses non-essential jobs with a snapshot/restore path and a hard-coded protected list — see [`docs/PERF-RUNBOOK.md`](docs/PERF-RUNBOOK.md).

**Engineering.** A real zero-dependency **test harness** (261 assertions), a **deterministic update-set generator** that rebuilds the batch XML from source with round-trip verification, RBAC gates, encoded-query injection hardening, and a fix for an XML-illegal control-char sentinel that had silently broken the update-set export.

---

## Voice command reference

### Vulnerability analyst (R5)
Requires a VR role (`sn_vul.vulnerability_analyst`, `sn_vul.admin`, or read/write VR roles; extra roles grantable via properties).

| You say | Netra does |
|---|---|
| *"What's my vulnerability exposure?"* | Open counts by risk band, top groups, your open total |
| *"Show my critical vulnerable items"* | Your queue filtered to critical risk |
| *"What are the top risks across the org?"* | Highest-risk active VITs everywhere |
| *"Walk me through my queue"* | Highest-risk open item; *"next one"* advances |
| *"Tell me about VIT0001234"* | Detail + CVE summary + recommended fix |
| *"Look up CVE-2021-44228"* | Advisory summary + how many items it hits + worst risk |
| *"Which assets are most vulnerable?"* | Hosts carrying the most open items |
| *"Assign VIT0001234 to the Security team"* | Assigns (asks which if the name is ambiguous) |
| *"Defer VIT0001234, compensating control in place, review in ninety days"* | Defers with reason + review date, audit note |
| *"Resolve VIT0001234, patched to 2.17.1"* | Resolves with a mandatory note |
| *"Mark VIT0001234 a false positive, not exploitable"* | Closes as false positive with reason |
| *"What's overdue?"* / *"Show me the aging report"* | SLA/age-based overdue list; aging buckets |
| *"How are we trending this week?"* | Opened vs closed + rough MTTR |
| *"Preview deferring everything for CVE-2021-44228"* | Counts the matches and reads them back |
| *"Yes, defer them all, patch scheduled"* | Applies the bulk action (capped, audited) |
| *"Raise a change to fix VIT0001234"* | Creates a linked change request |

### Instance health (admin)
Read-only; requires `admin` (or roles in `perf_read_roles`).

| You say | Netra does |
|---|---|
| *"Instance health"* | Active jobs, runs due next hour, busiest job, slow transactions, standing flags |
| *"List the heaviest jobs"* | Top repeating jobs by runs/day, each classified protected/candidate/review |
| *"Integration report"* | Scheduled imports, LDAP, outbound REST, MID inventory |

### Everyday ITSM (unchanged)
Tickets (*"create a ticket for my email is broken"*, *"list my tickets"*, *"resolve INC0001234"*, *"status of INC0001234"*), approvals (*"list my approvals"*, *"approve CHG0001234"*), knowledge (*"search knowledge for VPN"*), drafts, watchlist, briefings, pause/resume (*"pause for two hours"*, *"resume"*), and conversational social turns. See [`docs/DEMO-SCRIPT.md`](docs/DEMO-SCRIPT.md) for a guided run.

---

## Install

| Path | Files | Steps |
|---|---|---|
| **A. Background Script (Recommended)** | `install/setup-netra.js` | Create scope, paste + Run, drop widget on a portal page |
| B. Update Set XML (batch) | `update-set/Netra_v2.0.0-R5_Batch.xml` | Import XML, Preview & Commit the parent set — 7 children commit automatically |

Then: set the `gemini_api_key` property, and assign VR roles to your analyst/service account. Full click-by-click walkthrough (incl. role setup and a smoke test) in [`INSTALL.md`](INSTALL.md).

---

## Repository layout

```
netra-snow/
├── README.md · INSTALL.md
├── install/
│   ├── setup-netra.js                        ← single Background Script: builds the whole app
│   ├── cross-scope-privileges.js             ← standalone privilege bootstrapper
│   ├── restore-cross-scope-privileges.js     ← privilege disaster-recovery
│   └── perf-audit.js                         ← R5: one-shot instance perf audit / safe-pause / restore
├── update-set/
│   ├── Netra_v2.0.0-R5_Batch.xml             ← R5 batch: parent + 7 children, single import (canonical)
│   └── Netra_v2.0.0-R4.7_Batch.xml           ← prior release (also the generator's base)
├── scripts/
│   ├── build-setup-script.mjs                ← regenerates setup-netra.js from source/ (Node)
│   └── build-update-set.mjs                  ← R5: regenerates the batch XML from source/ (Node)
├── tests/                                    ← R5: zero-dependency test harness (node run-tests.mjs)
│   ├── glide-mock.js · fixtures.js · run-tests.mjs
│   └── test-vulnerability · test-performance · test-intent-regression · test-server-static · test-update-set
├── docs/
│   ├── TDD.md · TDD-R5-ADDENDUM.md
│   ├── DEMO-SCRIPT.md                         ← R5: 7-minute demo storyline
│   ├── PERF-RUNBOOK.md                        ← R5: performance audit + safe-pause procedure
│   └── TEST-REPORT-R5.md
└── source/
    ├── script_includes/
    │   ├── NetraIntent · NetraTools · NetraResponder · NetraScanner · NetraKnowledge
    │   ├── NetraChat · NetraSummarizer · NetraContext · NetraNavigator
    │   ├── NetraVulnerability.js              ← VR analyst operations (R5-expanded)
    │   └── NetraPerformance.js                ← R5: read-only instance analytics
    ├── widget/                               ← Netra Mic widget (template/client/server/scss)
    ├── scripted_rest/  · business_rule/  · scheduled_jobs/  · fix_script/  · tables/
```

---

## Architecture (current build)

The widget is a thin AngularJS shell: it captures speech, streams the transcript to the widget **server script** via `c.server.update()`, and speaks the reply. All domain logic is server-side, in scope `x_196061_netra_v1`, under the calling user's permissions.

```
Browser (Service Portal)                     Scoped app  x_196061_netra_v1
┌─────────────────────────┐                  ┌───────────────────────────────────────┐
│ Netra Mic widget        │   c.server.update │ widget server.js                       │
│  • Web Speech STT        │ ───────────────► │   _chat → Gemini function-calling loop │
│  • neural TTS (Edge/…)   │ ◄─────────────── │   _runTool dispatch (~90 tools)         │
│  • orb UI, filler chain  │   {message,…}    │      ├─ NetraTools (ITSM CRUD)          │
│  • polls notifications   │                  │      ├─ NetraVulnerability (VR suite)   │
└─────────────────────────┘                  │      ├─ NetraPerformance (health, R5)   │
                                             │      └─ NetraKnowledge / Context / …    │
     Scheduled Job "Netra Watch" (3 min) → NetraScanner → notification table (incl. VITs, R5)
     Business Rule on comments → notification table
```

VR tables (`sn_vul_*`) are global-scope; the scoped app reaches them through curated cross-scope privileges shipped in the update set. Every VR read/write is gated on a VR role.

---

## Build & test

```bash
# after editing anything under source/
node netra-snow/scripts/build-setup-script.mjs      # regenerate the Background Script installer
node netra-snow/scripts/build-update-set.mjs        # regenerate the batch update-set XML (validates + round-trips)
node netra-snow/scripts/build-update-set.mjs --check # validate only, no write

# run the unit + static test suite
node netra-snow/tests/run-tests.mjs                 # 261 assertions across 5 suites
```

The update-set generator refreshes every code-bearing record from `source/`, adds the R5 artifacts to a new child set, and verifies each record's payload round-trips byte-for-byte to its source file. It refuses to emit XML-illegal control characters.

## License

MIT
