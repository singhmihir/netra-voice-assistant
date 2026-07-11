# Netra AI Capabilities Roadmap

> Generated 2026-07-11 from a five-domain web research sweep (realtime speech, voice UX,
> agentic capabilities, enterprise assistant features, conversation quality), synthesized
> and ranked by impact/effort for the Netra stack (Service Portal widget + Gemini API).
> Quick win #2 (semantic end-of-turn detection) shipped in R8.1 alongside this document.

# Netra Capability Roadmap — Ranked by Impact/Effort

**Ranking method:** score = impact (1–5) ÷ effort (S=1, M=2, L=3). Duplicated capabilities across research domains have been merged (semantic end-of-turn, affective TTS, multilingual, memory, plan-execute appeared 2–3× each). Dependencies noted where one build unlocks another.

**🏆 Top 3 quick wins** (each buildable in <~200 lines in the existing widget): **#1 Tool-latency conversational cover**, **#2 Semantic end-of-turn heuristics**, **#3 WebRTC-loopback echo cancellation**.

---

## Tier 1 — Small effort, maximum impact (ratio 5.0)

### 1. 🏆 Conversational cover for tool latency (fillers + async acknowledgements) — Effort: S, Impact: 5
**What:** The moment a Gemini `functionCall` part arrives, immediately speak a pre-cached, contextual acknowledgement ("Pulling up your open incidents…", "Hmm, one sec…") keyed by tool category, with an escalation clip ("still checking…") past 3s, while the GlideRecord/scripted-REST work runs. Merges the "non-blocking tool calls" and "latency-masking fillers" findings.
**Why for blind users:** Dead air is Netra's worst latency case with ~70 tools, and a blind user has no spinner to watch — silence reads as failure. This converts every slow tool call into perceived responsiveness.
**Sketch:** Pre-render 3–4 filler clips per category (query/action/analysis) via Edge-TTS/Gemini-TTS at setup, cache as base64 data URIs; in the function-calling loop, play the clip before dispatching the server call; suppress STT self-capture during playback. Pure client-side sequencing — no new APIs.

### 2. 🏆 Semantic end-of-turn detection (dynamic silence timeout) — Effort: S, Impact: 5
**What:** Judge whether the user is actually done speaking from *what* they said, not just silence length: wait longer after "I need to update the…" and respond instantly after "yes."
**Why for blind users:** Blind users compose queries verbally with hesitations; premature cutoffs mid-dictation are the single worst turn-taking failure, and the fixed 700–1000ms dead pause after every clean utterance is the second.
**Sketch:** Zero-cost regex prefilter on webkitSpeechRecognition interim transcripts (trailing "and/but/to/um/the", unclosed question stems → stretch timeout to 2–3s; complete-looking short answers → shrink to ~300ms). Optional phase 2: gemini-flash-lite "is this utterance complete? yes/no" call only for ambiguous pauses, cached, via the existing proxy. Add per-state eagerness (dictating a work note = patient; yes/no confirmation = eager). The heuristic layer alone captures most of the win in <200 lines.

### 3. 🏆 True full-duplex via WebRTC-loopback echo cancellation — Effort: S, Impact: 5
**What:** Route TTS playback through a local pc1↔pc2 RTCPeerConnection loopback so Chrome's AEC3 subtracts the assistant's own voice from the mic. The mic stays hot while she speaks; delete `TTS_GUARD_MS=350` / `BARGE_GUARD_MS=450` and the echo-word filtering in client.js.
**Why for blind users:** Those guard timers create windows where a blind user's speech is *silently ignored* — invisible failure with no visual cue. Barge-in becomes instant and reliable instead of heuristic.
**Sketch:** `captureStream()` on the TTS `<audio>` element → pc1; play pc2's remote track; keep `getUserMedia({echoCancellation:true})`. Pure Web APIs, ~60–100 lines plus deletions; ~20–40ms added audio latency; Chrome-only (Netra's target). Also a prerequisite that makes dual-path ASR (#15) and backchannel filtering (#14) clean.

### 4. Data sonification / audio graphs — Effort: S, Impact: 5
**What:** Play incident-volume or vulnerability trends as a 2-second pitch sweep (pitch = value, stereo pan = time), preceded by a spoken overview and followed by per-point step-through, per Apple Audio Graphs' interaction pattern.
**Why for blind users:** Blind users consistently rate sonification as transformative for trend comprehension — 30 numbers read aloud is unusable; a sweep is instant. Replaces entirely inaccessible dashboards.
**Sketch:** Server already has GlideAggregate series; client maps values to one OscillatorNode frequency ramp (220–880Hz log scale) + StereoPannerNode sweep, with spoken min/max/trend first and a data-table fallback (per W4A 2025). No charting libs, no blockers — output is audio, not pixels.

### 5. Screen-reader coexistence mode (JAWS/NVDA etiquette) — Effort: S, Impact: 5
**What:** An explicit "I use JAWS" toggle that mutes Netra's own TTS and routes every response through a primed `aria-live=polite role=status` region so the user's screen reader speaks it in their own configured voice, rate, and verbosity.
**Why for blind users:** Expert blind users strongly prefer their screen reader; today Netra double-speaks and fights it. This is table stakes for the exact audience Netra serves — and detection is impossible by design, so it must be an offered choice at onboarding.
**Sketch:** Persisted toggle (voice command settable); prime-then-populate the live region (or JAWS misses it); duck earcons during updates; ensure mic controls are real focusable buttons with accessible names. Plain DOM/ARIA in the widget.

### 6. Pre-action self-verification judge — Effort: S, Impact: 5
**What:** Before any write-class tool executes (update_incident, approve_change, VR remediation), a cheap second Gemini call validates the proposed tool call against the transcribed request — flagging mismatched record numbers, implausible field values, destructive scope — and reads discrepancies aloud for confirmation.
**Why for blind users:** STT errors ("INC0012345" misheard) can silently corrupt records, and a blind user can't glance at the form to catch it. This is what makes voice-driven writes safe enough to trust — and it's the safety substrate every agentic feature below builds on.
**Sketch:** One flash-model judge prompt inserted in the tool-dispatch path, gated to writes only (reads skip it, so no latency tax on queries). Add a post-plan reflection pass later when multi-step plans (#12) ship.

---

## Tier 2 — Small effort, high impact (ratio 4.0)

### 7. Earcon design system + spearcons — Effort: S, Impact: 4
**What:** A small, consistent family of synthesized non-speech sounds (listening-start, thinking, success, error, mic-open, per-priority notification pitches) built from one shared timbre, plus spearcons — list-item titles played at 2.5× rate for rapid "next/next/next" skimming.
**Why for blind users:** Earcons replace the entire visual state layer; spearcons make long list navigation several times faster than full TTS. Research says small + consistent = instantly learnable.
**Sketch:** Pure Web Audio — OscillatorNode + GainNode ADSR envelopes, one base timbre; spearcons via `playbackRate` on AudioBufferSourceNode over TTS audio Netra already receives. Zero assets, zero deps; document the vocabulary in onboarding. (Near-miss for the quick-win badge — also <200 lines.)

### 8. Context-styled expressive TTS (director's-notes prompting) — Effort: S, Impact: 4
**What:** Same words, different delivery by context: brisk and urgent for P1 alerts, warm morning-radio pacing for briefings, brief and apologetic for errors, soft after-hours.
**Why for blind users:** Long listening sessions are the whole interface; expressive variation dramatically reduces fatigue and lets urgency be *heard* rather than announced.
**Sketch:** A style map keyed on message class prepended to the Gemini-TTS request ({p1_alert: "urgent, clipped", briefing: "warm", error: "brief, apologetic", after_hours: "soft and low"}), plus inline emphasis tags on ticket numbers and deadlines. Prompt engineering plus routing; Edge-TTS falls back to coarse SSML rate/pitch.

### 9. Ticket auto-triage at filing time — Effort: S, Impact: 4
**What:** Predict {category, priority, assignment_group} from the spoken description before insert, speak the proposed routing for verbal confirmation, and file the ticket pre-routed.
**Why for blind users:** Misrouted tickets are the #1 resolution-delay source, and correcting routing later through forms is painful by voice. One confirmation utterance replaces a multi-field form walk.
**Sketch:** Widget server script builds the label taxonomy from sys_user_group/sys_choice (filtered to itil groups), optionally 20–30 resolved few-shot examples, Gemini classifies to JSON before the existing create-incident tool runs. Pure prompt classification, no ML infra.

---

## Tier 3 — Small effort, solid impact (ratio 3.0)

### 10. Whisper mode (whisper in, whisper out) — Effort: S, Impact: 3
**What:** Detect whispered input (low RMS + no voicing via the existing 24-band AnalyserNode) and reply in a whispered Gemini-TTS style at ~40% reduced gain; persist a "quiet until told otherwise" flag in per-user memory.
**Why for blind users:** Privacy in shared workspaces — a blind user can't check who's within earshot before asking about an HR ticket. It's manners as a feature.
**Sketch:** RMS + autocorrelation pitch-presence check client-side (or let the emotion-classification call return `is_whispered`); route replies via Gemini-TTS "[whispers]" style (Edge-TTS has no whisper) and drop the output GainNode.

### 11. Adaptive volume / noise-aware delivery — Effort: S, Impact: 3
**What:** Sample mic RMS for ~500ms before speaking to estimate the noise floor, then scale output gain (clamped +0–8dB) and slightly raise speaking rate in loud rooms.
**Why for blind users:** No glancing at a volume slider mid-response; the assistant just matches the room. Small feature, disproportionate delight.
**Sketch:** Existing AnalyserNode → GainNode scaling; persist per-user base volume; compose with whisper mode (quiet floor + whispered input = minimum tier). No blockers.

### 12. Agent-side backchanneling during long user turns — Effort: S, Impact: 3
**What:** Brief "mm-hmm" / "got it" acknowledgements at clause boundaries while the user dictates a long description, signaling active listening without taking the turn.
**Why for blind users:** Replaces the visual listening indicator they can't see — assurance the mic is still live mid-dictation.
**Sketch:** 5–10 pre-cached clips; trigger when interim transcript >~15 words + clause boundary + 400–600ms micro-pause scored "incomplete" by #2; cap at one per ~10s, randomize, suppress STT self-capture for the clip. Zero round trips.

### 13. Resolution-notes and KB-article generation — Effort: S, Impact: 3
**What:** One voice command turns a ticket's journal history into polished close notes, or a resolved ticket into a draft kb_knowledge article, approved by voice.
**Why for blind users:** Writing prose in a ServiceNow form field is the most tedious task by voice; this makes the highest-friction write a one-liner.
**Sketch:** Server reads sys_journal_field + incident fields, Gemini drafts, GlideRecord writes on verbal approval — fits the existing tool pattern exactly; chunk-summarize long journals.

### 14. Change risk summarization + schedule-conflict detection — Effort: S, Impact: 3
**What:** During approvals triage, narrate a risk brief: overlapping change windows on the same CI (one hop via cmdb_rel_ci), the CI's open incidents, SLA-bound services affected.
**Why for blind users:** The "should I approve this?" evidence lives across several forms and related lists a voice user can't skim; this compresses it into one spoken brief.
**Sketch:** Read-only GlideRecord queries + Gemini narration, depth-limited CI traversal, plugged into the existing approvals flow. No blockers.

### 15. Requester sentiment/frustration alerts — Effort: S, Impact: 3
**What:** Score new comments on watched tickets for anger/urgency language; speak "the requester on INC0033 sounds frustrated — two follow-ups in an hour" and suggest (never auto-apply) escalation.
**Sketch:** One cheap Gemini call added to the existing watchlist poller; advisory only.
**Why for blind users:** Sighted agents skim tone from an inbox at a glance; this restores that ambient awareness.

### 16. Word-level TTS timestamps → synchronized live captions — Effort: S, Impact: 3
**What:** Parse the WordBoundary metadata the Edge-TTS WebSocket already emits and drive karaoke-style large-print captions plus braille-trackable text synchronized to playback.
**Why for blind users:** Serves the *low-vision* and refreshable-braille segments of the audience — text that tracks audio instead of dumping all at once.
**Sketch:** Retain (not discard) `audio.metadata` frames in the current MediaSource pipeline; schedule DOM highlights against `audio.currentTime`; `aria-live=off` (audio is primary). Edge-TTS-only — Gemini-TTS returns no timestamps.

---

## Tier 4 — Medium effort, maximum impact (ratio 2.5)

### 17. Natural-language analytics Q&A — Effort: M, Impact: 5
**What:** "How many P1s breached SLA this month, and is that trending up?" answered conversationally with spoken numbers and week-over-week trends, optionally paired with sonification (#4) and an accessible HTML table.
**Why for blind users:** Performance Analytics dashboards are entirely inaccessible; this *is* the dashboard for Netra's audience — disproportionately valuable in exactly this niche.
**Sketch:** One server tool wrapping GlideAggregate with a constrained schema — Gemini maps questions to {table, aggregate, group_by, encoded_query, trend_field} against a whitelist; server executes; Gemini narrates. The whitelist validation (never execute raw LLM query strings) is the real work.

### 18. Similar-incident recommendation with resolution mining — Effort: M, Impact: 5
**What:** For any open incident, surface top-k similar resolved incidents and synthesize how they were actually fixed from close_notes ("3 similar in 90 days; 2 fixed by resetting the VPN profile").
**Why for blind users:** Turns tribal knowledge into an instant spoken answer — no skimming related-records lists, which is brutal by voice.
**Sketch:** Extend the existing KB embedding pipeline to incidents: scheduled job embeds short_description+close_notes into u_incident_embedding via the proven server-side Gemini REST path; cosine-rank in the server script; Gemini narrates with incident-number citations. Also the foundation for #24 (duplicate clustering).

### 19. Hierarchical audio navigation of structured data — Effort: M, Impact: 5
**What:** Navigate record sets as an audio tree — overview → drill by priority → by assignment group → into one incident — with voice commands (next/previous/drill in/back up/where am I), depth-pitched earcons, and templated per-level utterances.
**Why for blind users:** Research (Chart Reader CHI 2023, ChartA11y 2024) shows drill-down beats linear read-outs for anything over ~10 items. This converts Netra's flat "read me the list" into the validated pattern.
**Sketch:** A navigation-cursor state object client-side (level, index, path); GlideAggregate group-bys server-side; compose with earcons (#7) and spearcons for skimming. No new APIs.

### 20. Plan–execute–replan agentic playbooks (narrated, interruptible) — Effort: M, Impact: 5
**What:** For complex requests, Gemini first emits a structured JSON plan (steps, tool per step, success criteria); the client executes step-by-step, announces progress ("Step 2 of 5: querying open changes"), re-plans on failure, pauses at checkpoints for verbal approval of write-class steps, and persists plan state so reloads/sessions resume mid-plan.
**Why for blind users:** Spoken plan narration is *the* transparency mechanism that makes 10-step autonomy trustworthy when you can't watch a progress UI; barge-in already exists to map "skip that"/"stop"/"why?" to plan control.
**Sketch:** Planning phase + orchestrator loop over the existing 70 tools; strict whitelist of auto-runnable tools; plan persisted to a custom table; every write gated by the judge (#6). Highest-leverage medium build — all infrastructure (tools, barge-in, TTS) exists.

---

## Tier 5 — Medium effort, high impact (ratio 2.0)

### 21. Backchannel-aware barge-in filtering + resume-after-false-interruption — Effort: M, Impact: 4
**What:** Classify incoming speech during TTS as acknowledgment ("uh-huh", "right") vs. true interruption: duck volume ~40% and buffer 500–800ms on speech onset; continue through backchannels; on real interruptions pause, and if no command materializes in ~2s, resume from `audio.currentTime` with "as I was saying."
**Why for blind users:** Natural listeners backchannel constantly; killing a long briefing because the user said "okay" is infuriating, and going silent after a false alarm is worse. Depends on #3 (AEC) to avoid self-transcription.
**Sketch:** Client-side lexicon + length check on interim transcripts; HTMLAudioElement pause/seek; fuzzy-match interims against the currently-spoken sentence to discard echo residue.

### 22. Dual-path ASR: Gemini re-transcription of raw audio — Effort: M, Impact: 4
**What:** Record each utterance (MediaRecorder webm/opus) in parallel with webkit SR; when stakes are high (write about to fire, low SR confidence, user says "that's not what I said"), send the clip to Gemini with a hotword-biased transcription prompt (ticket prefixes, colleague names from memory) as a correction pass.
**Why for blind users:** webkitSpeechRecognition reliably butchers "INC0012345", "CMDB", and Indian names — and a voice-only user can't see the mis-transcription. Pairs with the judge (#6) as the accuracy backbone for writes.
**Sketch:** Base64 clips <30s (~90KB) through the widget server to generateContent with inline audio. Correction pass only — never on the primary latency path. Needs #3 for echo-free clips.

### 23. Predictive SLA breach scoring with proactive voice escalation — Effort: M, Impact: 4
**What:** Score watched/assigned tickets for breach probability ("INC0042: ~80% risk — 2 hours left, reassigned 3 times, unassigned") and surface top risks in briefings and alerts before breach.
**Why for blind users:** Converts the assistant from reactive to anticipatory; sighted users get this from red dashboard cells.
**Sketch:** task_sla `business_percentage` + cheap features (reassignment_count, has_assignee, age vs. category median via GlideAggregate), graded by rule or one Gemini call. Continuous offline monitoring needs a scheduled job writing to the notification queue.

### 24. Duplicate clustering / major-incident detection with deflection — Effort: M, Impact: 4
**What:** Cluster open incidents by embedding similarity in a 24–48h window; on new filing, check against open clusters and deflect: "five others reported this; a major incident is open — add you as affected?"
**Why for blind users:** Gives blind users the outage awareness sighted users get from status dashboards.
**Sketch:** Reuses #18's embedding table; greedy cosine clustering in server JS is fine at hundreds of tickets; voice alerts ride the existing watchlist channel.

### 25. Cross-session layered memory (episodic + semantic consolidation) — Effort: M, Impact: 4
**What:** Two-layer memory: an episodic table (per-session Gemini summaries + embeddings, cosine-retrieved at answer time so "that ticket we discussed yesterday" works) plus a nightly Mem0-style ADD/UPDATE/DELETE reconciliation of semantic facts, keeping the fact list small and conflict-free. Include a "temporary chat" voice command that skips episode writing.
**Why for blind users:** Continuity removes re-explaining — the highest-friction activity in a voice-only interface. OpenAI measured recall jumping ~41.5%→~67.9% with chat-history reference.
**Sketch:** u_netra_episodes + u_netra_facts tables; reuse the existing embedding/cosine code; nightly Scheduled Script consolidation; needs a transcript retention/PII policy.

### 26. Voice-created scheduled and recurring agent tasks — Effort: M, Impact: 4
**What:** "Every Monday at 8, summarize weekend P1s" — scheduling is itself a Gemini tool that inserts rows into u_netra_tasks; a 5-minute polling Scheduled Script runs the full tool loop server-side and writes results to the notification tables the widget already announces. List/cancel/edit tools included.
**Why for blind users:** Standing work without ritual re-asking — the assistant becomes a workforce, not a Q&A surface.
**Sketch:** Server-side tool loop runs identically (GlideRecord layer); mark browser-only tools (screenshot, TTS) client-only so the planner avoids them in scheduled context.

### 27. Overnight proactive briefings (Pulse-style curated cards) — Effort: M, Impact: 4
**What:** A nightly job synthesizes memory, watchlist deltas, assignments, approvals, and yesterday's conversation summaries into ranked briefing cards Gemini *chose* to surface; read aloud in priority order at login, with spoken feedback ("skip these", "more like this") steering tomorrow's curation.
**Why for blind users:** The morning "what matters today" scan of lists and dashboards is expensive by voice; this replaces it with 90 curated seconds.
**Sketch:** sysauto_script + sn_ws.RESTMessageV2 (already proven by the KB-embedding pipeline) → u_netra_pulse table → widget reads on wake. Needs per-user run context or a service account with row-level context.

### 28. Event-driven proactive interventions with proposed actions — Effort: M, Impact: 4
**What:** Business Rules on watched tables fire events; a Script Action asks Gemini whether/when/how to interrupt, returning {interrupt, urgency, spoken_message, proposed_action_toolcall} — "the P1 you follow breached SLA; want me to escalate and page on-call?" with the fix pre-staged for one-word approval.
**Why for blind users:** The judgment layer between event and interruption is what separates useful proactivity from notification noise you can't visually triage.
**Sketch:** gs.eventQueue → Script Action → notification row → record-watcher pickup; existing turn-taking waits for a conversational gap. Gate the LLM call behind cheap rule prefilters and per-user rate limits.

### 29. Procedural memory: user-taught routines ("morning triage") — Effort: M, Impact: 4
**What:** Named, reusable multi-step routines taught by dictation ("when I say morning triage, do X then Y") or self-proposed by the nightly job when it detects repeated tool sequences ("you've asked for open-P1s-then-approvals three days running — save that?").
**Why for blind users:** Voice-first users can't make typing shortcuts; one-phrase routines are their macro system. Confirms resolved parameter slots aloud on first invocation.
**Sketch:** u_netra_procedures (trigger phrase, steps, parameter slots) injected into the system prompt; save_procedure tool; expands into the plan-execute loop (#20).

### 30. Background/async task execution with completion callbacks — Effort: M, Impact: 4
**What:** Long jobs detach from the conversation: a u_netra_jobs row is processed by an async Business Rule with step-wise progress notes; the client subscribes via spUtil.recordWatch (no polling) and interjects at a conversational gap: "Your P1 summary is ready — want to hear it?"
**Why for blind users:** Removes the "one conversational breath" ceiling; the user keeps working while research runs.
**Sketch:** Classic ServiceNow job pattern; chunk long jobs into resumable steps to respect script time limits; composes with #20's plans and #31's approvals inbox.

### 31. Generative UI: hybrid voice+visual response cards — Effort: M, Impact: 4
**What:** Gemini emits a typed card payload ({card_type: incident|approval|kb_answer|chart|list, data, actions, spoken_summary}); the widget renders interactive ARIA-regioned cards with real focusable action buttons feeding back into the tool loop, while voice speaks a shorter summary.
**Why for blind users:** Cards are a *navigable, re-readable artifact* of each answer for screen-reader users (vs. ephemeral speech), and low-vision colleagues get the visual. Separating "what to show" from "what to say" is the 2025 insight.
**Sketch:** Discriminated-union responseSchema; ng-switch templates; inline SVG charts; voice-only "read the card" fallback preserved.

### 32. Grounded RAG with verifiable citations — Effort: M, Impact: 4
**What:** Every KB/incident-grounded answer carries checked citations — spoken ("per KB0010042, section 3") and tappable chips. Path (b) from research: force {answer, citations:[{source_sys_id, quoted_snippet}]} responseSchema and verify each snippet actually appears in the cited record server-side before speaking, rejecting hallucinated cites; ACL checks stay in GlideRecord. (Path (a), Gemini File Search stores, adds page-level cites but complicates ACLs.)
**Why for blind users:** A wrong remediation step read aloud with confidence has real cost; verified attribution is the trust mechanism.

### 33. Multilingual auto-detection and Hinglish code-switching — Effort: M, Impact: 4
**What:** Understand and reply in whichever language the user speaks, including mid-sentence Hindi/English mixing, no settings menu.
**Why for blind users:** Netra's Indian-English base code-switches as the norm; forcing English is a daily tax.
**Sketch:** Keep Web Speech as fast path with per-transcript language-ID (a lang field in the existing Gemini response — zero extra calls) hot-swapping `recognition.lang` (~100ms restart) and the TTS voice (Edge has hi-IN/ta-IN/te-IN); optionally run parallel en-IN + hi-IN recognizers and pick the higher-confidence result; MediaRecorder→Gemini transcription for heavy code-switching. Free with the Live API migration (#36).

### 34. Speaker diarization + second-voice privacy guard — Effort: M, Impact: 4
**What:** Batch diarization ("summarize what Speaker 2 asked for") via Gemini structured output on recorded segments; plus an accessibility-first privacy guard — during sensitive read-outs, chunk ambient audio into 3–5s slices and ask Gemini "more than one distinct speaker?", pausing reading when a second voice approaches.
**Why for blind users:** A blind user cannot see someone walk up to their desk while HR ticket details are being read aloud. No mainstream assistant ships this; it's Netra-differentiating.
**Sketch:** MediaRecorder + inline-audio generateContent; few-hundred-ms latency is fine for a pause trigger. Real-time streaming diarization stays out of scope (needs external infra).

### 35. Emotion/prosody detection from user audio — Effort: M, Impact: 4
**What:** A parallel per-utterance Gemini audio-classification call returns {emotion, arousal, is_whispered, urgency}; the label steers the *next* turn's wording ("user sounds frustrated — be concise, offer escalation") and the TTS style (#8).
**Why for blind users:** Voice is the whole interface; being "heard" emotionally is what builds trust in it. Runs async so it adds zero turn latency.
**Sketch:** MediaRecorder webm inline to gemini-2.5-flash with a JSON schema; inject into system prompt and style map. Also supplies whisper detection (#10) for free.

### 36. Gemini Live API migration (native speech-to-speech) — Effort: L, Impact: 5
**What:** Replace the STT→LLM→TTS cascade with one bidirectional WebSocket: raw PCM up, expressive audio down, server VAD, built-in barge-in, ~500ms turns — the single biggest architectural gap. Unlocks native proactive audio, affective dialog, 97-language auto-switching, and NON_BLOCKING tool scheduling.
**Why for blind users:** Sub-second, prosody-rich, interruption-tolerant conversation is the ceiling on everything else; for someone whose entire interface is this loop, halving turn latency is transformative.
**Sketch:** Zero npm deps: widget server mints a v1alpha ephemeral token (auth_tokens.create via RESTMessageV2); browser opens wss://…/BidiGenerateContent with it; AudioWorklets for 16kHz PCM up / 24kHz ring-buffer down (drives the existing orb via AnalyserNode); the ~70 function declarations port unchanged. Blockers: 15-min session cap (sessionResumption + slidingWindow compression), v1alpha preview status, ServiceNow CSP must allow the wss: origin. Recommended as a parallel-track spike while Tiers 1–3 ship on the cascade — most cascade work (fillers, judge, memory, tools, cards) carries over.

### 37. Ambient etiquette: follow-up window + device-directed speech detection — Effort: M, Impact: 4
**What:** After each exchange, keep the mic open 8–10s with a soft "mic still open" earcon; classify each utterance as addressed-to-assistant vs. background via a fast flash-lite call, answering only when addressed. (Full wake-word-free proactive audio needs #36: `proactivity.proactiveAudio=true`, 2.5-native-audio only — plus a consent setting.)
**Why for blind users:** Removes the wake-word ritual on follow-ups without transcribing hallway conversations — ambient instead of walkie-talkie.
**Sketch:** Reuse existing wake-word auto-restart logic; close on silence or "thanks, that's all."

---

## Tier 6 — Medium/large effort, moderate ratio

### 38. Computer-use automation of the ServiceNow UI — Effort: L, Impact: 5
**What:** Screenshot (or better, serialized DOM/accessibility tree) → Gemini 2.5 Computer Use → click_at/type_text via `document.elementFromPoint` and synthetic events → re-observe, looping until "fill out this change request form" completes on *any* form, including ones no tool wraps.
**Why for blind users:** Covers the long tail of inaccessible forms and catalogs — transformative reach beyond the 70 tools. Every submit routes through the judge (#6).
**Sketch:** Widget already captures screenshots; same-tab only (no cross-origin iframes/native dialogs); DOM-tree variant is cheaper and drift-immune; Next Experience React surfaces need native-like event init. High reward, real engineering + safety work.

### 39. Live-agent handoff with AI conversation summary — Effort: M, Impact: 3
**What:** When escalating, Gemini summarizes the voice session (transcript already held for memory) into the ticket description/work notes, names the owner, and adds the ticket to the watchlist — the user never repeats themselves. Full in-widget live chat (Agent Chat/AWA Interaction integration) deferred as a larger phase 2.

### 40. Post-incident review generation — Effort: M, Impact: 3
**What:** After a major incident closes, assemble parent + child incidents + task_sla + journal timeline and generate a structured PIR (summary, timeline, impact, root cause, action items), read section-by-section with barge-in navigation ("skip to action items"). Long-context assembly is the only real work.

### 41. Speculative response generation on interim transcripts — Effort: M, Impact: 3
**What:** Fire the Gemini call early when an interim transcript is stable ~300ms; commit on transcript match, abort-and-refire on mismatch; pair with sentence-pipelined Edge-TTS so speech starts on the first sentence. Saves 200–500ms/turn but doubles calls on mismatch and must never execute tools from unconfirmed turns. Largely obsoleted by #36 — build only if the Live migration stalls.

### 42. Neural VAD in the browser (Silero via ONNX Runtime Web) — Effort: M, Impact: 3
**What:** Self-hosted silero_vad_v5.onnx + ort-wasm in an AudioWorklet for millisecond-accurate, noise-robust speech gating (arms barge-in on real speech, not keyboard clatter). Needs ~3MB of assets vendored into the update set, sane MIME/CORS from ServiceNow, and `wasm-unsafe-eval` CSP. Worthwhile mainly as a companion to #3/#21 or if webkit endpointing proves limiting.

### 43. Human-in-the-loop agent inbox (pause/resume approvals) — Effort: M, Impact: 3
**What:** Serialize conversation + plan + pending tool call to u_netra_paused_runs when a step needs approval; spoken inbox on login ("Two tasks await approval…"); voice edits pass as the tool result; resume by replaying (truncated/summarized) state. Becomes necessary once #26/#30 ship — sequence it with them.

### 44. Deep-research agent with citations — Effort: L, Impact: 3
**What:** Web-grounded questions via Gemini's Interactions API (background=true, poll, read aloud with "skip to recommendations" navigation); instance-internal research via an in-house 10–20-round plan-query-synthesize loop over GlideRecord/KB tools with record-number citations. Costly runs (up to 60 min) need quota gating; markdown parsing (no structured output).

---

## Not recommended

### 45. Voice biometrics authentication — Effort: L (and blocked), Impact: 1 as scoped
Picovoice's web SDK needs npm + SharedArrayBuffer (COOP/COEP headers Service Portal doesn't set), Gemini can't reliably verify speakers, and the market signal is negative (Azure Speaker Recognition retired Sept 2025; Amazon Connect Voice ID retiring May 2026, partly over deepfake risk). What *is* worth building: voice-keyed personalization on ServiceNow session auth (already covered by per-user memory) and, at most, a low-assurance spoken-confirmation-phrase check before destructive actions — framed as friction, never authentication. Record this blocker explicitly in the roadmap.

---

## Suggested sequencing

1. **Week 1–2 (quick wins):** #1 fillers, #2 end-of-turn heuristics, #3 loopback AEC — then #7 earcons, #8 TTS styles, #6 judge.
2. **Month 1–2:** #4 sonification, #5 screen-reader mode, #9 auto-triage, #17 analytics Q&A, #18 similar-incidents (embedding reuse → #24 clustering nearly free).
3. **Month 2–4:** #20 playbooks + #25 memory + #26/#27/#28 proactive stack (+#30/#43 as they demand it); #21/#22 conversation-quality follow-ons.
4. **Parallel track:** #36 Live API spike behind a feature flag — it upgrades, rather than invalidates, everything above.
