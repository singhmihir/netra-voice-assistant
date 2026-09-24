# Netra on ServiceNow 🎙️ v7.0

A voice-first, fully accessible assistant that runs **natively inside ServiceNow** as a scoped application. Zero external services, zero recurring cost. Designed for blind and visually-impaired ServiceNow users.

---

## v7.0 — Tireless (2026-09)

The brief: make Netra work like a dedicated senior agent — investigate
before concluding, keep going across many steps, verify her own work, keep
working while you are away, recover instead of giving up, and report
honestly. The constraint that shaped everything: **the free Gemini tier
allows 20 generate calls per model per day** (Google says so in the 429
body — `quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier,
quotaValue: 20`), and every ordinary turn used to cost two. So v7 does the
heavy lifting deterministically and spends a model call only where
reasoning actually earns its keep.

- **Never goes dark.** A quota governor (`NetraBrain`, instance-wide ledger
  in `x_196061_netra_v1_brain`) remembers which model is out of quota and
  until when — per-day limits rest until the Pacific-midnight reset (US DST
  handled), per-minute limits for the RetryInfo delay, timeouts and
  overloads briefly — and **never sends HTTP to a resting model**. Chat
  *and* the reasoning tools share one governed chain across four models,
  each with its own daily pool. Per-turn call budget (default 5), at most 6
  tool calls a round. If the brain dies mid-turn she tells you what she
  already found instead of "I am thinking too much". *"How's your brain?"*
  reads the ledger for free.
- **Zero-call fast lane.** Ticket status (including *"i n c zero zero one
  zero zero one three"*), my tickets, my approvals, the away debrief, the
  work board, quota status, repeat, plan hops, and yes/no on anything she
  parked in the previous turn — all answered with **no model call**.
- **Basic mode.** When every model is resting she still reads tickets,
  lists work, searches by meaning (the embedding API has its own quota),
  raises a ticket with a read-back and a yes, refuses other writes *with a
  reason*, and says when her reasoning comes back.
- **Investigates like an engineer** (`NetraInvestigator`). *"Investigate
  INC0010013"* gathers a numbered evidence dossier — journal, audit trail,
  the CI and its neighbours, **changes that landed just before**, sibling
  incidents, open problems, KB, similar resolved tickets — for free, then
  spends **one** call to rank theories that must cite evidence. Code drops
  any theory with a missing or invented citation, caps confidence by
  evidence strength, and composes the spoken answer from the evidence
  fields so numbers and times can't drift. *"Evidence for two"*, *"what did
  you check"*, *"write it up"*, *"link that change"* — show-your-work at zero
  calls, writes confirm-gated and verified.
- **Change correlation** — *"what changed on this server before these
  tickets"* ranks changes by link, timing, type, risk and outcome, worded as
  correlation, never causation. The outage radar now names the likely
  trigger in the same announcement.
- **Keeps digging while you're away** — an evidence watch that reports only
  new facts, checks each theory's signal, and when the ticket resolves
  **grades its own theories** against the real close notes — including
  saying *"I got this one wrong"*.
- **Missions** (`NetraMissionRunner`) — *"work through the unassigned
  queue"*: the scanner reviews a few tickets per pass (routing, likely
  duplicate, known fix — embeddings only, never a generate call), you hear
  progress on the work board, and it applies only what you then say yes to
  — re-reading every write, skipping anything a human touched since, fully
  undoable.

**Verified live on a PDI** (seeded scenarios under `install/seed-*.js`):
a real turn skipped two daily-exhausted models without sending them a
request and answered on the first live one; fast-lane intents, undo and the
away debrief ran at 0 generate calls; change correlation ranked the one
direct change first and left the decoys out (dossier gathered in ~110 ms);
*"investigate"* spent exactly one call, cited only real evidence, came back
from cache for free on the second ask, and said "not enough evidence" on a
ticket with no CI instead of inventing a theory; the evidence watch reported
only new facts and graded its theory against the real close notes; a mission
reviewed 27 tickets with 27 embedding calls and **0** generate calls,
skipped the one a human had edited, applied 11 confirmed changes with
read-back, and undo restored all 11.

### Trust, by construction

- **She acts with your permissions, never the app's.** Every ticket, journal,
  attachment, approval, knowledge and vulnerability read or write she makes
  for you goes through `GlideRecordSecure`, with field-level checks, so the
  same ACLs as the ServiceNow forms apply. Checked live with a self-service
  caller: their own ticket is read with its comments but never its internal
  work notes, someone else's ticket is "not found, or you can not see it",
  "my tickets" lists only theirs, investigations and "similar past tickets"
  never draw on records they could not open, and a work note they may not
  write is refused before anything is read back. Platform code, Vulnerability
  Response and work-note alerts are limited to the roles in the `code_roles`,
  `vr_roles` and `fulfiller_roles` properties. Background jobs act only on
  what their owner authorised, and the `ticket_writes` kill switch stops every
  write path, undo included.
- **A "yes" only runs what you just heard.** Every write that needs consent is
  read back and parked with the turn it was proposed in; only your next turn
  can confirm it. Comments the caller sees, work notes, messages, batch
  changes and undo are always read back from their real arguments - the exact
  words, the resolved person - before they run. Once text written by other
  people (ticket descriptions, comments, attachments, articles) is in the
  conversation, every write the model asks for waits for your spoken yes, so
  an instruction hidden in a ticket can not act for you. A reply you never
  heard (you barged in, or it arrived late), two drafts in one turn, a stale
  plan, a yes from twelve minutes ago - all dropped or read back again.
- **Everything she changes is checked and undoable.** Writes are read back
  before she says "done" - a secure update can report success while the
  platform quietly dropped a field, so journal entries are checked in the
  journal itself. Undo restores what really changed (priority through impact
  and urgency, resolve with its close notes, batches ticket by ticket, whole
  plans step by step), never overwrites a change someone made since, says how
  long ago the change was, and says plainly what can not be taken back.
- **Nothing is lost while you are away.** Notifications are marked delivered
  only once she has spoken them - asleep or busy, they wait; the away debrief
  includes every report and the true count.
- **She checks herself.** *"Run a self check"* tests her key (against Google's
  free model list), her tables, her cross-scope reads, the background scanner's
  heartbeat, overdue standing orders, quota, memory coverage and recent errors
  — zero model calls — and says what is wrong and how to fix it.

### Tested without an instance

`node netra-snow/tests/run.js` runs the real widget and script-include code
against an in-memory ServiceNow and a scripted Gemini in about two seconds:
conversations through the real router for the confirm gate, fast-lane
routing, investigations, standing orders fired by the real background
runner, queue missions, permissions (with ACLs and roles), record facts,
spoken numbers and times, the client's local replies and the self-check,
plus static guarantees (everything parses, no secrets ship, every declared
tool has a handler, the router hoisting trap stays closed). GitHub Actions
runs it on every push (`.github/workflows/netra-tests.yml`). See
[`tests/README.md`](tests/README.md).

The v7 code was also put through an adversarial whole-codebase audit - an
auditor per slice, then a skeptic per slice trying to refute each finding -
and the confirmed defects were fixed with a test each.

### Her voice (v7.1)

Two things had quietly broken the neural voice, so every reply fell through
to the browser's default voice (the "tin can"):

- Microsoft's read-aloud service now closes the socket with *"SSML is
  invalid"* for anything but `<voice>` with one `<prosody>` round plain text.
  Every reply carried `<break>` and `<emphasis>` tags, so none was ever
  served. The pauses now live in punctuation (sentence ends, commas, dashes
  and "..."), which the voice honours anyway.
- The service also refuses the handshake from any browser that is not
  **Microsoft Edge** (the user agent cannot be changed for a socket), so in
  Chrome the neural voice is not on offer: Netra says so once in the Lab,
  skips the doomed handshake and uses the best voice the browser has
  (Google's online voices in Chrome). Open her in Edge for the neural voice.

**A second ear (v7.2).** The browser's recognizer sends your audio to
Google's or Microsoft's speech service; when that service returns no words
(a blocked network, a language it will not take, a grammar it rejects, a
session that died silently) the mic shows sound and Netra hears nothing,
which reads as "she is not listening". The page now watches for exactly
that - clear speech on the meter, nothing from the recognizer - and heals in
steps: it rebuilds without the grammar, tries plain en-US, and if the
recognizer stays deaf (or the speech service is unreachable, or the browser
has no recognizer at all) it opens its own ear: Whisper running inside the
browser in a worker, fed straight from the mic's audio graph, no speech
service involved. Every word it hears travels the same road a browser final
does, and the words so far show live while you are still speaking. On a
browser with WebGPU it runs the clearer *base* model with a light decoder,
elsewhere the quick *tiny* one; the Lab's **model** switch overrides that
and its **ear** switch forces the ear on or off; the status row says which
ear is listening, why, and how long the last utterance took. The model (about 40 MB, cached by the
browser after the first load) comes from the Hugging Face hub and the
runtime from jsDelivr, so those two hosts must be reachable once.

Along with that: the Lab's **HEARD (LIVE)** section shows the live
transcript and, for every final, what became of it ("answered on the page",
"sent to Netra", "dropped: my own echo", "asked to repeat"); the Lab's
**voice** row says what is really speaking; a bare "stop" is a quiet
acknowledgement, not sleep ("stop listening" still sleeps); "stop" spoken
over her voice stops her even when the mic catches a word of her own after
it, and a garbled barge-in is asked again rather than sent as a command;
clock times and greetings use the browser's timezone, not the profile's;
"search the web for X" (and "who founded X", "what is X") answers from
Wikipedia or Bing with the source named, and says so when nothing relevant
came back; the recognizer's network failures are reported instead of
swallowed. The whole loop was tested with real speech: Indian-English
audio played into the page's own recognition handlers, replies from the
real instance, echo from the speakers simulated.

**Known limits.** Free keys allow 20 generate calls per model per day, so a
heavy day will still put Netra into basic mode for a while — she says so and
says when she is back. Instances without a `caused_by` field on incident get
the change link as a cross-referenced work note on both records instead.
Some instances fence the system log off from scoped apps; the self-check then
says it could not look there rather than reporting "no errors".

---

## v6.0 — Trusted Agency (2026-09)

v5 made her reason. v6 makes her **act** — while you're away, across turns,
and increasingly the way *you* would — with every autonomous act bounded,
logged, spoken, and reversible by voice.

- **Standing orders** — *"watch INC0010031 and if nobody touches it for four
  hours, escalate it to P2"*. Said once, confirmed once, then executed by the
  5-minute scanner with **zero Gemini calls** — pure deterministic condition
  checks. Actions are deliberately small: notify, comment, nudge assignee,
  escalate priority. Autonomous reassign/resolve stays interactive, on purpose.
  The confirm is **structural, not prompt-discipline**: the create tool
  physically cannot arm an order in the turn that proposed it (the first live
  test caught the model trying).
- **Approval chaser / assignee nudger** — cadence-capped in *code*: max one
  nudge per person per 24h, three per task, quiet hours 19:00–08:00 (re-armed
  for morning, not dropped). Nudges are attributed honestly: *"Reminder from
  Mihir via Netra…"*.
- **While-you-were-away debrief** — on return she reads a numbered ledger of
  what she did: *"One: escalated INC-thirty-one at 6:40, as you authorized.
  Say undo one if I got any of it wrong."* — and **"undo one" works**, restoring
  recorded before-values, refusing if a human touched the record after her.
- **Plans (compound commands that finish)** — *"resolve these three with note
  X and bump the last one to P2"* becomes a filed plan, read back, then executed
  in budgeted chunks (4 writes/transaction, auto-continuing across turns,
  hop-capped). A failed step **halts** the plan with an honest report; *"undo
  the plan"* walks the undo stack in reverse.
- **She learns you** — overrides of her triage advice, undos of her writes, and
  `remember that…` facts feed a per-user profile injected into every turn.
  `suggest_triage` now blends instance history with *your* history and **flags
  disagreement instead of silently picking**: *"history says Hardware, but
  you've sent these to Field Services three times — which way?"*
- **Verify-after-write, everywhere** — found live: on stock incident, priority
  is recalculated from impact × urgency, so direct writes "succeeded" while
  changing nothing. Every field write now reads back what actually stored, uses
  the impact/urgency matrix when priority is derived, and *says so honestly*
  when the platform stomped the change.

### Gemini 3 migration (the 2.5 family retires as early as 2026-10-16)

- Pinned, measured chain — no more `-latest` roulette: primary
  `gemini-2.5-flash-lite` (0.5s, until Google turns it off) → `gemini-3.6-flash`
  (6s, also the complex-turn brain) → `gemini-3-flash-preview`. The dead 2.0
  ids are gone. HTTP 0 (timeout) now counts as transient so the chain falls
  through instead of dying.
- Generation-aware knobs: `thinkingLevel` on 3.x (`thinkingBudget` → 400 there,
  verified live), `thinkingBudget: 0` kept for 2.5-flash, temperature forced to
  1.0 on 3.x per Google's guidance.
- **Thought signatures**: Gemini 3 rejects any unsigned `functionCall` in
  history — and a mixed-generation fallback chain produces exactly those (a
  2.5 model answers hop 1, a 3.x model reads it back on hop 2 → 400, chat
  dead). Fix verified against the live API: signatures are echoed verbatim,
  preserved through history truncation, and foreign/unsigned calls get
  Google's documented migration token.
- **Timezone-proof scheduling**: assigning a date *string* to a GlideRecord
  field re-interprets it in the session timezone (our first standing order
  armed itself 7 hours late). All load-bearing date writes now go through
  `setDateNumericValue()`.

---

## v5.0 — Netra Intelligence (2026-07)

Up to v4 Netra did what you asked. v5 makes her reason over your instance's
own history and tell you things you *didn't* ask for but needed to know.
All of it rides on the embedding cache (`gemini-embedding-001`, 768-dim,
cosine over locally cached vectors) — no new tables, no extra services.

- **Resolution memory** — describe a symptom and she searches *resolved*
  tickets by meaning, then leads with **what actually fixed it**:
  *"this bit us in March — INC0012345, turned out to be the DNS cache."*
- **Predictive triage** — where tickets like this really end up. Assignment
  group / category / priority weighted by how similar each past ticket is,
  with the sample size and example tickets behind it.
- **Duplicate guard** — runs automatically before every create. Stops the
  fourth ticket for one outage from ever existing.
- **Major-incident radar** — three tickets on one CI (or five in a category)
  inside two hours isn't three tickets, it's an outage. Available on demand
  *and* proactively: the 5-minute scanner announces clusters unprompted,
  deduped per cluster per hour.
- **Pattern analysis** — volume this period vs the one before, plus the
  categories and groups driving the change.
- **`install/warm-semantic-index.js`** — one-shot job that pre-embeds your
  existing tickets so the very first question is already fast. **Run it in
  the Netra application scope** — a global-scope run silently fails to write
  to the scoped cache table.

### Also fixed in v5.0 — a systemic latent bug

The widget server is one big IIFE whose action router calls `_chat()` while
the script is still executing top-to-bottom. Every module-level `var` declared
*below* that router was therefore hoisted-but-unassigned — i.e. `undefined`
on every real request. That silently broke more than it looks:

| Constant | What was actually broken |
|---|---|
| `EMBED_MODEL` / `EMBED_CACHE_TABLE` | embed URL became `models/undefined:…` → 404 → semantic KB search quietly fell back to LIKE, and **nothing was ever cached** |
| `SENTIMENT_CUES` | `cannot read length from undefined` on **every single turn** |
| `MEM_CAP` | conversation memory never hit its cap |
| `REQUIRED_FIELDS` / `FIELD_PROMPTS` | guided draft flow had no field list |
| `UPDATE_ALLOW` / `FIELD_SYNONYM` | `update_field` rejected everything |
| `MAND_SKIP` / `_mandCache` | mandatory-field discovery threw |

All of them now live in one block above the router. Keep new constants there.

### And a second one: the `-latest` alias moved under us

Every ordinary turn was returning **HTTP 400 `INVALID_ARGUMENT`** from Gemini.
Nothing in the code had changed — Google repointed the
`gemini-flash-lite-latest` alias at a model that **rejects
`thinkingConfig.thinkingBudget`**. Because a 400 is classified non-transient,
the model-fallback chain gave up instead of trying the next model, so simple
turns died outright while long/complex ones (routed to `gemini-2.5-flash`)
still worked — which is exactly why it looked intermittent.

Three-part fix:
1. `thinkingConfig` is only sent to models that accept it (`_modelTakesThinkingConfig`).
2. On any 400, the same model is retried **once** with the optional knobs
   stripped — so the next alias rotation self-heals instead of breaking chat.
3. 400s now log the request *shape* (turn roles, part kinds, sizes — never
   content), so the next one takes minutes to diagnose instead of hours.

> **If chat ever goes quiet, check `syslog` for `[NetraGemini] 400 shape:` first.**

---

## v4.0 — what's new (2026-07)

- **Deep memory** — the conversation window covers the last **50 user prompts**
  (counted in prompts, not raw turns), survives page refreshes in the same tab,
  and anything older gets folded into a one-line-per-prompt digest instead of
  falling off a cliff. Payload-too-large now trims the older half; it never
  wipes memory. A DEEP MEMORY card in Netra Lab shows it live.
- **Voice routines** — teach her macros: *"define my morning routine: daily
  briefing, then overdue tickets, then my approvals"* → *"run my morning
  routine"* executes every step and gives one combined summary.
- **Undo by voice** — *"undo that"* deletes a just-created record, restores a
  changed priority/assignment to its previous value, or reopens an accidental
  resolve. Confirm-first, always.
- **SLA radar** — *"what's about to breach?"* reads active SLAs ranked by
  percent consumed (aging fallback when no SLA engine runs).
- **Batch updates** — *"add that note to all five of those"*: up to 25 tickets
  in one confirmed sweep.
- **Automatic morning briefing** — first visit of the day, Netra reads the top
  items unprompted (toggle in the setup panel).
- **Out-of-box setup** — a left-edge "MAKE NETRA YOURS" panel (language, voice
  with preview, pace, mic meter + sensitivity, mic check) that opens itself on
  the very first visit, like a brand-new phone.
- **Real 3D stage** — an iridescent glass orb (three.js, embedded — no CDN)
  with a multi-hue gradient heart that diffuses from the centre (green while
  listening, gemini blues while speaking), smoke wisps off its edges, a
  top-right sun, pastel edge hues, bloom — all voice-reactive at 60fps.
- **Zoom-grade mic handling** — persistent DSP stream + instant recovery on
  track death/mute and headset plug/unplug; language/voice/pace changes apply
  immediately and reliably.

---

## R8.x — what's new (2026-07)

- **Prism UI** — a 60fps hue engine drives every colour: the orb/blob shifts
  through state palettes (emerald idle → cyan capture → magenta thinking →
  violet speaking) and, while Netra speaks, the hue is continuously modulated
  by the spectral shape and loudness of her own voice. The Live stage
  (`/sp?id=netra_live`) gained aurora ribbons, counter-rotating prism rings, a
  starfield, word-onset ripples, glass status chips and live captions.
  **Netra now lives ONLY on the Live page** (removed from /sp and everywhere else).
- **Full ticket control** — Netra can CREATE, EDIT and MODIFY every ticket
  type (incident, problem, change, catalog request/task): quick-create,
  guided drafts with mandatory-field discovery, resolve/comment/work-note/
  reassign/reprioritise/update-any-field. Confirm-before-write is enforced in
  the prompt; `<scope>.ticket_writes=false` is an emergency kill-switch.
- **Sentinel mic reliability** — self-healing recognition: stuck-floor
  release, zombie-session heal (interims promoted to synthetic finals),
  transient `not-allowed` recovery, permission-restore probe, preventive
  session recycling, semantic end-of-turn (waits after "…update it with",
  answers instantly after "yes"), and a low-confidence "once more?" nudge.
- **Netra Lab** — a draggable floating diagnostics window on the Live page:
  real-time mic spectrum scope, record/playback mic test, STT accuracy
  calibration (read-back sentence, word-accuracy score), Sentinel health
  telemetry, brain/TTS stats and the live hue readout. On the very first run
  Netra performs a UI + mic self-check with the calibration sentence.
- **SNOW form intelligence** — Netra understands the form: mandatory fields
  (dictionary + overrides + data policies + UI policies), available form
  buttons and *what happens when you click them* (reads the UI-action code),
  field-change effects ("if I change category, what new fields pop up?"),
  pre-submit checks, active flows, pending approvals, related records
  (attachments/SLAs/child tasks/CIs), and "did my action create a new ticket?".
- **Reminders** — "remind me in 2 hours" → announced by voice (to the minute
  while the page is open; ≤5 min otherwise via the scanner).
- **Analyst/developer lexicon** — a curated word vector of ITSM + ServiceNow
  developer language seeds the recognizer grammar and re-ranker.
- **Short-form numbers** — first mention is "incident ending 3-4-5"; the full
  number is spoken only on request.
- **Prosody sentiment** — speaking rate + loudness dynamics ride each turn as
  metadata; Netra adapts tone (LLM sentiment refinement enabled).
- **R9 additions** — mic calibration now runs on EVERY page load as an
  interactive on-stage card (live transcript, % score, Skip / Try again, or
  just say "skip"); the Lab gained a recognition-language selector, a voice
  selector, a mic-sensitivity slider, a typed-command box (no mic needed) and
  an NLP dry-run tester with muted TTS; a pastel mesh-gradient environment
  blooms around the blob while Netra talks; ticket creation now ALWAYS asks
  for a spoken yes before inserting; ships as a single batch update set
  (`update-set/Netra_v3.0_Batch.xml`, parent + 6 children).
- **R10 — real 3D** — the Live-page blob is now a true WebGL scene
  (three.js r147, embedded on-instance as a widget dependency, zero CDN):
  an iridescent glass orb with noise-displaced surface driven by the live
  voice bands, a glowing hue-linked core, PMREM studio lighting, bloom
  post-processing, a 3D parallax starfield + dust motes, a soft reflective
  floor, camera drift + mouse parallax — with automatic fallback to the 2D
  blob when WebGL isn't available, and an adaptive quality drop if the
  frame rate dips. The square focus box on blob click is gone.
- See `docs/AI-CAPABILITIES-ROADMAP.md` for the researched, ranked roadmap of
  what's next, and `docs/TEST-REPORT-R8.md` for verification details.

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

**~3 minutes, three paths:**

| Path | Files | Manual steps |
|---|---|---|
| **A. Update Set XML (Recommended)** | `update-set/Netra_v7.0_Batch.xml` | *Retrieved Update Sets → Import Update Set from XML*, then Preview & Commit the parent **"Netra - v7.0"** — the six children commit automatically |
| B. Studio app import | `app-source/` | Push this repo to your own git remote, then *Studio → Import From Source Control* — Netra installs as a real scoped application |
| C. Background Script | `install/setup-netra.js` | Create scope (1 click), paste + Run script (1 click), drop widget on page (1 click) |

After any path: set your Gemini API key in the `x_196061_netra_v1.gemini_api_key`
system property (it ships blank on purpose) and open `/sp?id=netra_live`.

See [`INSTALL.md`](INSTALL.md) for the click-by-click walkthrough.

## Repository layout

```
netra-snow/
├── README.md                                ← this file
├── INSTALL.md                               ← step-by-step setup
├── install/
│   └── setup-netra.js                       ← single Background Script: creates everything
├── update-set/
│   └── Netra_v3.0_Batch.xml                 ← batch update set: parent + 6 children, single import
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
