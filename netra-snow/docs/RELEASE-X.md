# Netra R6 — "Release X"

**Version:** 3.0.0 · **Widget:** R6 · **Date:** 2026-07-10
**Instance update set:** `Netra Release X` (scope `x_196061_netra_v1`)
**Deployed via:** `scripts/deploy-release.mjs` (REST push from source control)

Release X is the human-interaction release. Netra stops behaving like a
speak-then-listen kiosk and starts behaving like a colleague: you can talk
over her, she gives way, she acknowledges you while you talk, and she is
now — by policy and by code — a *read-only* expert on tickets.

---

## 1. Human turn-taking (client)

### Barge-in — interrupt her like a person
The old client went deaf for up to 15 seconds whenever Netra spoke
(`ignoreFinalsUntil = now + 15000`). Release X keeps the mic **hot** the
whole time she talks:

- Every final transcript that arrives during her speech is scored for
  **token overlap** against the sentence she is currently saying (and the
  active thinking-filler). High overlap (≥ 72%) = her own echo → dropped.
- **Reflex words** — *stop, wait, hold on, shut up, quiet, bas, ruko* —
  yield instantly, even as a single word.
- Any other utterance (≥ 2 words, ≥ 8 chars, conf ≥ 0.30) is a genuine
  **barge-in**: her audio stops in ~100 ms, a falling blip confirms the
  yield, the orb flashes violet, and your words are processed as the next
  command.
- **Interim ducking**: the moment the recognizer starts hearing non-echo
  speech, her volume ducks to 25% — she audibly gives way *before you
  finish your first phrase*. If it turns out to be echo, volume restores.

### Turn epochs — interrupted answers never talk over you
Every user turn (and every barge-in) bumps an epoch counter. A server
reply that lands with a stale epoch is folded into conversation history
but **never spoken**. Rapid-fire interruptions are serialized through a
single-slot queue (`_chatInFlight` + drain), so exactly one chat is on the
wire at a time and the newest request always wins the floor.

### Netra-side interjections — she interrupts too, politely
- **Backchannels**: hold the floor for 4+ seconds and she drops a soft
  "mm-hmm" / "right" at 38% volume (Edge-synthesized, throttled to one per
  15 s) — the audible nod of a human listener.
- **Question nudge**: if she asked a question and hears nothing for 9
  seconds, she gently re-prompts once ("Take your time... I am
  listening."). Cancelled the instant you start talking.
- **Notification etiquette**: a notification arriving mid-conversation is
  prefaced with "Sorry to cut in —" instead of barging cold. Notifications
  no longer interrupt her `thinking` state.

### Universal stop
`stopSpeaking()` silences **everything** — remote `<audio>`, browser
SpeechSynthesis, the filler chain, and the pipelined TTS queue. The
Escape key now uses it (previously Escape only cancelled browser TTS and
did nothing during Edge/Gemini/Stream playback).

## 2. Faster and more natural speech

- **Pipelined Edge TTS**: replies over 220 chars are split on sentence
  boundaries and synthesized as a rolling pipeline — segment 1 plays while
  segment 2 renders. First audio lands 2–4× sooner on long replies, and
  each segment is individually interruptible.
- **Adaptive command debounce**: short, complete-sounding commands flush
  at 650–850 ms instead of a flat 1300 ms — simple commands respond about
  half a second faster.
- **Automatic contractions** (`_humanizeReply`): "I will" → "I'll",
  "cannot" → "can't" etc. applied before *every* engine, with guards
  against clause-final contractions ("yes, it is." stays).
- **Varied breath breaks**: sentence pauses alternate 280/340/300 ms so
  back-to-back sentences never get the identical metronome gap.
- **Blink**: the orb now actually blinks (the legacy blink animated a lid
  whose opacity was 0 — invisible). Idle: every ~7.3 s; thinking: ~4.7 s.

## 3. Ticket safety policy — read-only, enforced in code

> Netra never opens tickets. She knows everything about them.

Three enforcement layers, not just prompt text:

| Layer | Mechanism |
|---|---|
| Model toolset | `create_ticket`, `create_problem`, `create_change`, the whole draft flow, and `send_message_to_user` (opened tracking incidents) are **stripped from the Gemini function declarations** — the model cannot plan around tools it cannot see. Mutation tools (`resolve_ticket`, `update_ticket`, `change_priority`, `escalate_ticket`, `assign_ticket_to_*`, `add_work_note`, `update_field`) are stripped unless `x_196061_netra_v1.ticket_writes` is `'true'`. |
| Dispatcher | `_runTool` hard-refuses the same tools even if a stale conversation history references them. Creation is refused **unconditionally** — no property re-enables it. |
| Script Includes | `NetraTools.createTicket` always refuses; `resolveTicket` / `updateTicket` check the property — covering the legacy scripted-REST `/command` path. `NetraResponder` answers create-intents with a graceful pivot: it *searches existing incidents for the described issue first* and briefs you on what it found. |

Reads are untouched and encouraged: status, summaries, search, briefings,
watchlist, overdue, team workload. Approvals and Vulnerability Response
actions (a deliberate analyst capability) remain available with verbal
confirmation.

New property: **`x_196061_netra_v1.ticket_writes`** (default `false`).

## 4. Expanded conversation limits

| Limit | Before | Release X |
|---|---|---|
| History window | 12 turns / 60 KB | **40 turns / 180 KB** |
| Tool-result retention in history | 1 500 chars | **4 000 chars** |
| Text-part retention in history | 2 000 chars | **6 000 chars** |
| Tool-use loop per turn | 5 | **8** |
| Reply budget (`maxOutputTokens`) | 1 024 | **2 048** |
| User message | 8 000 chars | **16 000 chars** |
| Merged transcript | 4 000 chars | **12 000 chars** |
| Long-term memory | 100 exchanges | **200 exchanges** |

## 5. Identity refresh

Brand assets (`branding/`) redrawn to the in-app identity introduced on
the instance: deep violet-black tile, case-hardened violet voice ring
(with the amber heat-treatment patina), lavender-lidded eye, luminous
green iris. Icon, logo, badge SVG + PNG all regenerated; `render.py` now
rasterises the SVGs directly. The dev console header carries the
`R6 · RELEASE X` badge and a `TICKETS: READ-ONLY` pill; the Monitor tab
gains barge-in / backchannel counters and the status bar a `BRG` segment.

## 6. Deployment

```bash
SN_INSTANCE=https://devXXXXXX.service-now.com SN_USER=admin SN_PASS=... \
node netra-snow/scripts/deploy-release.mjs --release "Netra Release X" \
     --export netra-snow/update-set/Netra_Release_X.xml
```

The script: resolves the scoped app → creates/reopens the update set →
makes it the session user's current set → PATCHes the widget, all 10
Script Includes, 3 REST operations, the scheduled job, the business rule,
creates `ticket_writes`, bumps the app to 3.0.0 → verifies every write
was captured (adopting any strays) → optionally completes + exports the
set. `--dry-run` previews without writing.
