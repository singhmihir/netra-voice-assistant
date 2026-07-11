# Netra R8.x Test Report — "Prism / Sentinel / Form Intelligence"

Date: 2026-07-11 · Instance: (personal developer instance — identifier withheld) · Tester: automated (headless Chromium via CDP + REST) + manual user verification pending

## Scope under test

| Release | Contents |
|---|---|
| R8.1 "Prism" | 60fps hue engine (state + voice-spectral colour modulation), Live-stage redesign (aurora, prism rings, starfield, ripples, glass chips, live captions), dev-console glass + FULL CONTROL badge, prism branding/icon/favicon |
| R8.1 "Sentinel" | Mic reliability layer: stuck-floor release, zombie-session heal (interim→synthetic final), transient `not-allowed` recovery, permission-restore probe, preventive 4-min session recycle, low-confidence nudge, semantic end-of-turn |
| R8 ticket writes | Full create/edit/modify on every ticket type; kill-switch property retained |
| R8.2 | Netra Lab floating console + STT calibration + first-run check; SNOW form intelligence (9 tools); reminders; live-page nav lock; prosody sentiment; short-form ticket numbers; analyst lexicon |

## Automated results

### Visual verification (headless Chromium, real instance)

| Check | Result |
|---|---|
| Live stage renders at /sp?id=netra_live (boot) | ✅ screenshot 01 |
| Idle state: emerald blob, teal room, rings + floor sheen | ✅ screenshot 02 |
| Awaiting state: cyan capture palette | ✅ screenshot 03 |
| Thinking state: magenta-violet churn | ✅ screenshot 04 |
| Speaking A vs B frames show DIFFERENT hues under synthetic 24-band audio (spectral modulation live) | ✅ screenshots 05/06 |
| Live caption of Netra's sentence while speaking | ✅ screenshot 05 |
| Dev console: R8.1 · PRISM + TICKETS: FULL CONTROL badges | ✅ screenshot 07 |
| Netra Lab: floating window (`position: fixed` computed), spectrum canvas painting, calibration card, Sentinel health grid | ✅ screenshot 08 + computed-style probe |
| Widget removed from /sp index and legacy netra page; only netra_live placement remains | ✅ sp_instance query |

### SCSS compiler regression (root-caused)

ServiceNow's SCSS fork silently drops rule blocks containing certain modern
constructs (observed: the `.netra-dev`/`.netra-lab` glass blocks,
`calc()*var()` inside `drop-shadow`, `grayscale(0.5)`), then resyncs at a
later `}` — the page then serves the rest of the file, which looks like
"CSS randomly missing". Fix shipped: those exact rules are delivered from a
literal `<style>` tag in the widget template (browser-parsed only), with
compiler-safe fallbacks left in the SCSS. Verified by computed-style probe
(`.netra-lab` → `position: fixed`) after redeploy + `cache.do` flush
(flush is now part of every deploy — a stale SP page cache also masked
one good deploy during diagnosis).

### Platform state (REST-verified)

| Item | Result |
|---|---|
| `x_196061_netra_v1.ticket_writes` = true (default-on, kill-switch honoured) | ✅ |
| `x_196061_netra_v1.sentiment_llm` = true | ✅ |
| Application menu "Netra Voice Assistant" + 6 modules in navigator | ✅ |
| Netra Watch scheduled job: 3 min → 5 min | ✅ |
| Widget + NetraTools + NetraResponder + NetraScanner deployed | ✅ |

### Mic reliability (Sentinel) — code-level verification

The two reported field symptoms map to defects fixed and unit-verified by
code inspection + state-machine probes (full live-mic soak requires a real
microphone session, which this environment cannot produce):

1. **"Stops responding after a while"**
   - Transient `not-allowed` recognition errors permanently bricked SR until
     refresh → now triaged against the Permissions API with 3-strike restart,
     plus a 30s permission-restore probe when genuinely denied.
   - Long-session degradation → preventive quiet-moment session recycle at
     4 min (Chrome's recognizer degrades on long continuous sessions).
2. **"Hears but does not register"**
   - Stuck speaking-floor (lost TTS completion) made every later short
     command get echo-scored and eaten → floor-sanity watchdog releases the
     floor after ~20s of claimed-speaking-with-no-audio; the stuck-speaking
     watchdog now does a FULL floor release (was: state flip only).
   - Zombie recognizer sessions (interims forever, no finals) → watchdog
     promotes the last interim to a synthetic final after 8s and rebuilds
     the mic stack, so the command still registers.
   - Low-confidence utterances were silently ignored → spoken "once more?"
     nudge (30s throttle).
   - Fixed silence timeout after complete answers / premature cutoff
     mid-thought → semantic end-of-turn (trailing-word heuristics: 280ms
     for "yes", 2.6s after "...update it with").
   - All Sentinel events are now visible live in Netra Lab → Recognition
     Health (restarts, recycles, zombie heals, floor clears, recoveries).

### E2E voice-pipeline (real widget server + Gemini + DB, 8 turns)

Driven through the actual client controller in headless Chromium
(TTS stubbed), against live instance data:

| Turn | Ask | Tools fired | Outcome |
|---|---|---|---|
| T1 | "what do I need to take care of before submitting INC0000059?" | check_before_submit, describe_form, form_buttons, summarize_ticket | ✅ pre-flight readout, short-form number ("incident ending 0 5 9") |
| T2 | "what buttons are there / what happens after I click resolve?" | explain_button | ✅ Delete/Update/Submit/Resolve/Save listed + Resolve behaviour explained from its UI-action code |
| T3 | "if I change state, do new fields pop up?" | field_change_effects | ✅ "On Hold → **On Hold Reason** pops up and becomes mandatory; Resolved → resolution fields" |
| T4 | "create a ticket, my email crashes…" | create_ticket | ✅ INC0010005 created (contact_type=virtual_agent, DB-verified) |
| T5 | "yes go ahead" | – | ✅ graceful "already created" follow-up |
| T6 | "related records on it?" | related_records | ✅ SLA "Priority 4 resolution, in progress" reported |
| T7 | "remind me in 2 minutes to stretch" | set_reminder | ✅ row created; **scanner promotion verified** (earlier reminder already flipped to kind=reminder) |
| T8 | "did my actions create anything new?" | my_recent_records | ✅ enumerated the fresh records incl. the new incident |

Also verified: chat → Gemini function-calling → tool dispatch → GlideRecord
write → spoken confirmation with `tools_called` traces; legacy scripted-REST
/command creation path (`NetraResponder._create` really creates now).

Notes: flash-lite occasionally invents a near-miss tool name
(`list_mandatory_fields` in T1) — the dispatcher's unknown-tool default
handles it gracefully and the turn still succeeds. In T4 the model created
immediately instead of asking to confirm first; prompt tuning of
confirm-before-write strictness is a follow-up.

## Known limitations / manual follow-ups for the user

1. **First-run calibration** speaks and listens — needs a real mic+speakers
   session to validate the accuracy score end-to-end (localStorage flag
   `netra_firstrun_done` gates it; clear it to re-run, or use Netra Lab →
   "Run calibration test").
2. **Reminders**: to-the-minute while the tab is open; ~5-minute
   granularity via the scanner if the tab was closed.
3. **PDI performance**: the widget no longer loads on any page except
   Netra Live (biggest per-page win); scanner runs at 5 min; heavy
   remaining log sources are platform jobs (DataCollector/PA — normal for
   PDIs). PDIs also hibernate after inactivity — the first hit after a
   quiet period is always slow; that part is Now-Cloud behaviour, not the
   app.
