# Netra — Technical Design Document

**Version**: R2.9.1 (NetraDeploymentV1)
**Last updated**: 2026-05-18
**Audience**: ServiceNow architects, accessibility engineers, future maintainers

This document is the authoritative reference for every script in the Netra widget. It explains *what every file does, every function does, every tool does, every CSS layer does, and how all of it fits together*. Read it cold and you should be able to maintain or extend the system without reading the code first.

Every code reference is given as `<filename>:<line>` — those line numbers correspond to the source files in `netra-snow/source/widget/` at this build.

---

## 0. One-page mental model

**Netra** is a single ServiceNow Service Portal widget (`Netra Mic`, table `sp_widget`, id `netra-mic`, sys_id `f6a50e9793b40350936af0a75d03d61c`) that ships with **four source files** plus a small constellation of supporting records (one Business Rule, two Script Includes, one Scheduled Job, two custom tables, two system properties, cross-scope privileges, ~12 sp_instance placements, one classic-UI application menu).

### 0.1 Overall architecture

```mermaid
flowchart TB
    subgraph Browser["USER BROWSER (Service Portal page)"]
        direction TB
        Tmpl["<b>template.html</b><br/>AngularJS view<br/>SVG orb (golden-ratio)<br/>Dev panel + Chat surface"]
        Scss["<b>stylesheet.scss</b><br/>State-aware palettes<br/>Voice ring + halo<br/>A11y focus rings"]
        Client["<b>client.js</b> — Angular controller<br/>Web Speech API (wake / listen / transcript)<br/>Web Audio (mic + output analyser)<br/>3 TTS engines (Gemini / Edge / StreamElements)<br/>Voice-ring polygon @60fps<br/>~90 functions"]
        Tmpl -.->|ng-bindings| Client
        Scss -.->|state classes| Tmpl
    end

    subgraph SN["SERVICENOW INSTANCE — scope x_196061_netra_v1"]
        direction TB
        Server["<b>server.js</b> — sp_widget.server_script<br/>Action dispatcher (chat/poll/tts/training/debug)<br/>_callGemini + recursive tool loop<br/>56-tool function-call dispatcher<br/>~75 domain helper functions"]
        SI["<b>Script Includes</b><br/>NetraTools (record ops)<br/>NetraKnowledge (KB search)"]
        Tables["<b>Tables</b><br/>x_196061_netra_v1_context<br/>(draft + mem + vocab + aliases)<br/>x_196061_netra_v1_notification<br/>(BR + scanner output)"]
        BR["<b>Business Rule</b><br/>'Netra: notify on incident comment'<br/>after insert/update on incident.comments"]
        Sched["<b>Scheduled Job</b><br/>'Netra: proactive scanner'<br/>every 3 min"]
        SN_Records["<b>OOB Tables</b><br/>incident / problem / change_request<br/>sysapproval_approver / kb_knowledge<br/>sys_user / sys_user_group / sys_attachment"]

        Server --> SI
        Server <--> Tables
        Server <--> SN_Records
        BR --> Tables
        Sched --> Tables
        SI <--> SN_Records
    end

    subgraph Cloud["EXTERNAL APIs (free / no key required for two of three)"]
        Gemini["<b>Google Gemini API</b><br/>gemini-2.5-flash (chat + function-calling)<br/>gemini-2.5-flash-preview-tts (native TTS)<br/>~1 quota credit per turn"]
        Edge["<b>Microsoft Edge Neural TTS</b><br/>wss://speech.platform.bing.com<br/>free, no key"]
        Stream["<b>StreamElements TTS</b><br/>api.streamelements.com<br/>free, no key (fallback)"]
        DDG["<b>DuckDuckGo + Wikipedia</b><br/>Instant Answer + REST<br/>free, no key"]
    end

    Client -->|c.server.update<br/>JSON action| Server
    Server -->|HTTPS chat| Gemini
    Server -->|HTTPS TTS| Gemini
    Client -->|WebSocket| Edge
    Client -->|HTTPS| Stream
    Server -->|HTTPS| DDG

    style Tmpl fill:#fff4e6,stroke:#cc7700,color:#000
    style Scss fill:#fff4e6,stroke:#cc7700,color:#000
    style Client fill:#fff4e6,stroke:#cc7700,color:#000
    style Server fill:#e8f5e8,stroke:#2e7d2e,color:#000
    style SI fill:#e8f5e8,stroke:#2e7d2e,color:#000
    style Tables fill:#e8f5e8,stroke:#2e7d2e,color:#000
    style BR fill:#e8f5e8,stroke:#2e7d2e,color:#000
    style Sched fill:#e8f5e8,stroke:#2e7d2e,color:#000
    style SN_Records fill:#e8f5e8,stroke:#2e7d2e,color:#000
    style Gemini fill:#e8e8ff,stroke:#3030b0,color:#000
    style Edge fill:#e8e8ff,stroke:#3030b0,color:#000
    style Stream fill:#e8e8ff,stroke:#3030b0,color:#000
    style DDG fill:#e8e8ff,stroke:#3030b0,color:#000
```

### 0.2 Voice command lifecycle

```mermaid
sequenceDiagram
    autonumber
    actor User as User
    participant Mic as Web Speech API
    participant Client as client.js<br/>(controller)
    participant Server as server.js<br/>(sp_widget.server_script)
    participant Gemini as Google Gemini API
    participant SN as ServiceNow tables<br/>(NetraTools / GlideRecord)
    participant TTS as TTS engine<br/>(Gemini/Edge/Stream)
    participant Audio as Web Audio<br/>+ Voice ring

    User->>Mic: "Netra, summarise INC0008001"
    Mic->>Client: SpeechRecognition.onresult (5 alternatives)
    Client->>Client: pickBestAlternative()<br/>client.js:320
    Client->>Client: applyAliases()<br/>client.js:270
    Client->>Client: matchLocal()<br/>client.js:612<br/>(no local match — Gemini needed)
    Client->>Client: setState('thinking')
    Client->>Client: playThinkingFiller()<br/>client.js:2471
    Client->>Server: c.server.update({action:'chat',<br/>message, history})
    Server->>Server: _chat(userMessage, history)<br/>server.js:215
    Server->>Gemini: _callGemini(contents, tools)<br/>server.js:403
    Gemini-->>Server: functionCall: summarize_ticket
    Server->>Server: _runTool('summarize_ticket', args)<br/>server.js:1081
    Server->>SN: _summarizeTicket(num)<br/>server.js:1375
    SN-->>Server: GlideRecord result
    Server->>Gemini: _callGemini(... + functionResponse)
    Gemini-->>Server: spoken-form reply text
    Server->>Server: _memAppend(user, reply)<br/>server.js:2159
    Server-->>Client: data.response, data.last_trace
    Client->>Client: setState('speaking')
    Client->>Audio: attachOutputAnalyser(audio)<br/>client.js:2040<br/>(BEFORE play() — R2.9.1 fix)
    Client->>TTS: speak(text)
    TTS-->>Audio: audio playback
    Audio->>Client: rAF tick reads RMS → c.audioLevel
    Client->>Client: _recomputeVoiceRing()<br/>client.js:129<br/>(state-aware base+spike)
    Client->>User: spoken reply + violet aura
    Audio->>Client: onended → detachOutputAnalyser<br/>client.js:2097
    Client->>Client: _afterTTS() → setState('idle')<br/>client.js:2107
```

### 0.3 Orb state machine

```mermaid
stateDiagram-v2
    [*] --> dormant: page load
    dormant --> idle: tap orb (c.tap)<br/>OR wake word ("Netra")<br/>OR Alt+Shift+N
    idle --> thinking: final transcript<br/>processCommand()
    thinking --> speaking: server reply<br/>handleHeard()
    thinking --> error: transport error<br/>OR Gemini timeout
    speaking --> idle: audio.onended<br/>_afterTTS()
    speaking --> error: TTS fallback chain exhausted
    error --> idle: cue('error') + reset
    idle --> dormant: "go to sleep"<br/>OR Esc<br/>OR Alt+Shift+N

    note right of dormant: c.alert=false<br/>orb dim<br/>voice ring hidden
    note right of idle: c.alert=true<br/>halo pulses subtly<br/>mic feeds voice ring
    note right of thinking: filler audio plays<br/>halo brighter
    note right of speaking: BASE=74 + spike 1.75x<br/>output amplitude feeds<br/>voice ring (R2.9.1)
```

### 0.4 Unified Netra Context blob (per-user state)

```mermaid
classDiagram
    class x_196061_netra_v1_context {
        +string user (ref sys_user)
        +string last_utterance (max 250 000)
        +datetime sys_updated_on
    }
    class CTXBlob {
        +Draft draft
        +MemEntry[] mem (cap 100)
        +VocabMap vocab
        +AliasMap aliases
    }
    class Draft {
        +string record_type
        +Map fields
        +datetime created_at
    }
    class MemEntry {
        +string t (timestamp)
        +string u (user msg, max 240 char)
        +string n (Netra reply, max 480 char)
    }
    class VocabMap {
        +Map[word, {count, lastSeen}]
    }
    class AliasMap {
        +Map[mishearLower, intendedString]
    }
    x_196061_netra_v1_context "1" *-- "1" CTXBlob : last_utterance = "CTX:" + JSON
    CTXBlob "1" *-- "0..1" Draft
    CTXBlob "1" *-- "0..100" MemEntry
    CTXBlob "1" *-- "1" VocabMap
    CTXBlob "1" *-- "1" AliasMap
```

The widget never carries domain logic — it's an AngularJS shell. **All ServiceNow operations happen server-side**, in the scoped app `x_196061_netra_v1`, under the calling user's permissions.

---

## 1. Scoped application

| Property | Value |
|---|---|
| Application name | `Netra V2 Update` |
| Scope | `x_196061_netra_v1` |
| Scope sys_id | `cbb86f0f93b0cf10936af0a75d03d662` |
| Tables created | `x_196061_netra_v1_context` (per-user draft + memory + training), `x_196061_netra_v1_notification` (BR + scanner output) |
| Cross-scope privileges | read+write on `incident`, `problem`, `change_request`, `sc_request`, `sc_req_item`, `sc_task`, `kb_knowledge`, `sysapproval_approver`, `sys_user`, `sys_user_group`, `sys_attachment`, `sys_email`, `sys_user_preference`, plus read on all `sys_script_*` tables (for `read_script` / `list_scripts`) |
| System properties | `x_196061_netra_v1.gemini_api_key` (string, encrypted), `x_196061_netra_v1.gemini_model` (string, default `gemini-2.5-flash`) |

---

## 2. File inventory

| File | Lines | Role |
|---|---:|---|
| `source/widget/template.html` | 502 | AngularJS markup: SVG orb (golden-ratio geometry), 2 voice-ring polygons, 2 SVG filters for the violet glow, dev panel, chat surface, ARIA roles |
| `source/widget/client.js` | 2993 | AngularJS controller: speech recognition, audio analysis, TTS, voice ring, dev tools, ~90 functions |
| `source/widget/server.js` | 2858 | Server-side scoped-app script: Gemini API client + 56-tool dispatcher + Context I/O, ~75 helpers |
| `source/widget/stylesheet.scss` | 1139 | Visual styling: orb geometry, voice-ring, dev panel, accessibility-first contrast, ~12 state-specific palettes |

### 2.1 Code-reference index (every concept → file:line)

| Concept | Reference |
|---|---|
| Wake-word matcher | `client.js:562` `isWakeWord()`, `client.js:576` `matchesWake()` |
| Sleep matcher | `client.js:597` `matchSleep()` |
| Local intent shortcuts | `client.js:612` `matchLocal()` — 18+ intents (greetings, smalltalk, repeat, where am I, quiet, faster/slower, praise) |
| Spoken-number normaliser | `client.js:725` `normalizeNumbers()` |
| Mic-level meter + health watchdog | `client.js:859` `startMicLevelMeter()` |
| Voice-ring polygon recompute | `client.js:129` `_recomputeVoiceRing()` (state-aware base+spike) |
| Output amplitude analyser hook | `client.js:2040` `attachOutputAnalyser()` (attached BEFORE play, R2.9.1) |
| Output analyser cleanup | `client.js:2097` `detachOutputAnalyser()` |
| SpeechRecognition lifecycle | `client.js:1373` `startContinuous()` + `client.js:1500` `startListeningWatchdog()` |
| Top-5 alternative rerank | `client.js:302` `_scoreAlternative()` + `client.js:320` `pickBestAlternative()` |
| Speech grammar (JSGF) | `client.js:1606` `attachGrammar()` — includes dynamic `<common>` rule with COMMON_VOCAB |
| Process final transcript | `client.js:1687` `processFinalTranscript()` |
| Send chat to server | `client.js:1800` `processCommand()` |
| Handle server reply | `client.js:1846` `handleHeard()` |
| TTS routing | `client.js:1978` `speak()` |
| Gemini-native TTS | `client.js:2195` `speakGemini()` (PCM → WAV via `_pcmToWavBlob()` at `:2167`) |
| Edge Neural TTS | `client.js:2275` `speakEdgeTTS()` (WSS handshake at `:2147` `_edgeConnectId()`) |
| StreamElements TTS | `client.js:2486` `speakStreamElements()` |
| Browser TTS fallback | `client.js:2556` `speakBrowser()` |
| Thinking-cue fillers | `client.js:2454` `preloadFillers()` + `client.js:2471` `playThinkingFiller()` (18 phrases) |
| Post-TTS state reset | `client.js:2107` `_afterTTS()` |
| Hotkey bindings | `client.js:2732` `bindHotkeys()` (Alt+Shift+N/D/R, Space, Esc) |
| Notification poll loop | `client.js:2782` `startNotificationPolling()` (every 4s) |
| Orb drag-and-drop | `client.js:1158` `c.dragStart()` |
| State setter | `client.js:2982` `setState()` |
| **Server action dispatch** | `server.js:60` (chat / poll / save_training / clear_training / gemini_tts / debug) |
| Gemini chat loop with tool calls | `server.js:215` `_chat()` |
| Gemini model fallback chain | `server.js:403` `_callGemini()` |
| One-shot Gemini REST call | `server.js:458` `_callGeminiOnce()` |
| System prompt | `server.js:508` `_systemPrompt()` |
| Tool declarations (all 56) | `server.js:690` `_toolDeclarations()` |
| Tool dispatcher | `server.js:1081` `_runTool()` |
| Context blob I/O | `server.js:1823` `_ctxLoadGr()`, `:1833` `_ctxReadBlob()`, `:1856` `_ctxWriteBlob()` (safety truncate at 250 KB) |
| Memory append/recall | `server.js:2159` `_memAppend()` (MEM_CAP=100), `:2171` `_recallPastConversations()` |
| Remember fact | `server.js:2198` `_rememberFact()` |
| Draft record flow | `server.js:1900` `_startRecordDraft`, `:1919` `_setRecordField`, `:1939` `_reviewDraft`, `:1959` `_confirmAndCreate`, `:1986` `_cancelDraft` |
| Sidebar Discussion (with live_message fallback) | `server.js:1998` `_sendSidebarMessage()` |
| Web search (DuckDuckGo + Wikipedia) | `server.js:2227` `_searchWeb()` |
| Update arbitrary field | `server.js:2392` `_updateField()` (with inlined UPDATE_ALLOW + FIELD_SYNONYM) |
| Read script source | `server.js:2515` `_readScript()` (9 code tables), `:2580` `_formatScript()`, `:2619` `_formatWidget()` |
| List scripts | `server.js:2637` `_listScripts()` |
| Vocab cache (6h) + COMMON_VOCAB | `server.js:2729` `_getVocab()` |
| Pause-state preference | `server.js:2825` `_ensurePref()`, `:2842` `_setPauseState()` |
| Voice-ring SVG filters | `template.html:316-353` `<filter id="netra-violet-glow">` + `<filter id="netra-violet-glow-speaking">` |
| Voice-ring polygons | `template.html:355-372` `.netra-voice-ring-fill` + `.netra-voice-ring-stroke` with `ng-attr-filter` |
| Voice-ring gradient stops | `template.html:265-288` (radial fill + linear stroke gradients) |

---

## 3. The data round-trip protocol

Every meaningful interaction between client and server goes through `c.server.update()`, an AngularJS-shaped POST that submits the `c.data` object server-side, runs `server.js`, and returns the mutated `data` object back to the client.

`server.js` reads the action verb from `input.action` and dispatches:

| `input.action` | Server reads | Server writes (into `data`) |
|---|---|---|
| `chat` | `input.message`, `input.history`, optional `input.image_b64` | `data.response`, `data.last_trace`, `data.last_tool_args`, `data.force_history_reset` (rare) |
| `poll` | (nothing) | `data.notifications` (array of pending notification rows, then marks them spoken) |
| `save_training` | `input.vocab`, `input.aliases` | `data.training_result.{ok, vocab_count, aliases_count}` |
| `clear_training` | (nothing) | `data.training_result` |
| `gemini_tts` | `input.text`, `input.voice` | `data.gemini_tts.{ok, b64, mime, voice}` |
| `debug` | (nothing) | `data.debug_info` (instance, scope, version, etc.) |
| _initial load_ | (nothing; ServicePortal fires server.js on render) | `data.user_name`, `data.user_sys_id`, `data.has_api_key`, `data.paused`, `data.training`, `data.vocab` |

The "initial load" branch always runs, before any action branch — so `data` always carries the user identity and training data even when the page just rendered.

---

## 4. The unified Netra Context model

Per-user state lives in **one** row of `x_196061_netra_v1_context`, keyed by `user_sys_id`. The `last_utterance` column (max_length 32000) is treated as a JSON blob with this shape:

```json
{
  "draft": {
    "active": true,
    "table": "incident",
    "fields": { "short_description": "vpn broken", "urgency": "2" },
    "started_at": "2026-05-18 04:12:00"
  },
  "mem": [
    { "ts": "...", "user": "...", "netra": "..." },
    ...max 30 most recent exchanges
  ],
  "facts": [
    { "ts": "...", "fact": "User prefers high-contrast UI" }
  ],
  "vocab":   { "vpn": { "count": 12, "lastSeen": "..." }, ... },
  "aliases": { "net rah": "Netra", "agar": "Adam" },
  "watchlist": ["INC0008001", "CHG0030005"],
  "focus":    { "number": "INC0008001", "table": "incident", "ts": "..." }
}
```

**Why one blob and not seven columns?** Atomic writes — one `gr.update()` saves everything; no risk of half-committed multi-row state. Cheap to load (one GR.get) and trivial to back up.

The server reads this with `_ctxLoadGr()` → `_ctxReadBlob()` and writes with `_ctxWriteBlob()`. Domain operations (`_draftRead`, `_draftWrite`, `_memAppend`, `_trainingRead`, `_trainingWrite`) are thin facades over the blob.

---

## 5. template.html — section by section

The orb's viewBox is fixed at **120 × 120**. Every geometry constant in the SVG and CSS is in units of this viewBox so the orb scales pixel-perfect at any rendered size.

| Section | Lines (approx) | What it does |
|---|---|---|
| `<div class="netra-orb">` wrapper | 1–40 | Outer positioning host; `ng-class` exposes state to CSS (`netra-state-dormant`, `idle`, `thinking`, `speaking`, `shrunk`, `dragging`). `tabindex=0` for keyboard focus, `aria-label` describing the orb. |
| Dev panel | ~40–250 | `ng-show="c.dev"`. Sections: TTS engine cycler, voice picker, mic test, screenshot capture, log tail, charts (confidence + latency), training (vocab + aliases), nuclear reset. |
| Inline `<style>` for dev fade-in | one block | Allows the dev panel to fade in without depending on global CSS load order. |
| SVG `<defs>` | ~260–300 | Reusable gradients: `netra-halo` (outer glow), `netra-voice-gradient` (radial fill — violet→magenta→amber, case-hardened patina), `netra-voice-stroke-gradient` (linear multi-tone for the stroke), `netra-rim` (lower-right rim light), `netra-inner-shadow` (inset cast shadow), `netra-drop` (soft drop-shadow filter). |
| Voice-ring polygons | ~305–325 | Two `<polygon>` elements driven by `c.voiceRingPoints` (24 vertices x,y…). One is the filled translucent waveform; one is the stroked outline. `ng-show="c.alert"` keeps them hidden when Netra is dormant. |
| Halo, sphere, iris layers | ~327–410 | Golden-ratio circles: sphere radius 50, limbal r ≈ 50/φ, iris r ≈ 50/φ², pupil r ≈ 50/φ³. Two catchlights at the golden-section coords (45.92, 47.10) and (74.08, 72.90). Pentagram inscribed in the iris rotates 21 s/turn. |
| Eyelids | ~412–430 | `<path>`s clipped by the sphere; `transform` animates closed↔open on `c.blinking`. |
| Drop shadow / final filter | ~430–451 | Wrapper for the SVG drop shadow at offset `12/φ = 7.4 px`. |

### Bindings the template depends on

| Scope variable | Driven by | Purpose |
|---|---|---|
| `c.state` | `setState()` in client.js | Top-level mode class on the orb |
| `c.alert` | derived in client.js | Whether the orb is "awake" (idle / thinking / speaking) |
| `c.voiceRingPoints` | `_recomputeVoiceRing()` | The 24 vertex coords for both polygons |
| `c.dev` | `c.toggleDev()` (`Alt+Shift+D`) | Show/hide dev panel |
| `c.log`, `c.charts.*`, `c.micLevel` | telemetry helpers | Dev panel data |
| `c.conversationOpen` | `openConversation()`, `closeConversation()` | Whether the chat surface is rendered |
| `c.aliasList`, `c.personalVocab`, `c.vocabCount`, `c.aliasCount` | training helpers | Training UI |
| `c.pendingOpenUrl` | `_runOpenUrl` callback path | Popup-blocker fallback button |

---

## 6. stylesheet.scss — layers

Single-file SCSS, ~1146 lines. Layers (from outermost to innermost in z-order):

1. **`.netra-orb` host** (lines 1–80): fixed-position 72×72 box. Hover scales 1.0618× (1 + 1/φ × 0.1). CSS variables hold the colour palette so it can be themed by state.
2. **State classes** (lines 80–250): `.netra-state-dormant`, `-idle`, `-thinking`, `-speaking`, `-shrunk`, `-dragging`. Each overrides `--iris-bright`, `--iris-mid`, `--core-mid`, halo opacity, and may add a state-specific animation.
3. **Voice ring** (lines 120–160): the two polygon classes plus the speaking-state aura. Filter chain on the stroke gives the violet → magenta → amber case-hardened glow. The halo's `halo-pulse-speaking` keyframe scales 1.32×–1.52× while speaking.
4. **Pentagram + iris** (lines 165–210): pentagram rotation animation (21 s/turn), iris transitions, pupil breath cycle (3.618 s — φ²).
5. **Catchlights, eyelids, glints** (lines 210–360): all geometry positioned at golden-section coords.
6. **State-specific palettes** (lines 210–355): each state has an `--iris-bright` set to a distinct hue so the orb reads emotionally (warm idle, soft thinking, vibrant speaking, dim dormant).
7. **Dev panel** (lines 360–650): dark glass panel, sticky-positioned to the right of the orb; charts use 60×24 SVG miniatures; mic-level bar fills horizontally with a colour gradient.
8. **Chat surface** (lines 650–820): full-screen overlay (when `c.conversationOpen`) with last-turn transcript and Netra's reply. Honours `prefers-reduced-motion`.
9. **Accessibility helpers** (lines 820–950): focus rings (3 px outline, 2 px offset, high-contrast), `:focus-visible` only, ARIA live region styling.
10. **Drop-shadow / final visual polish** (lines 950–1146): subtle vignette, drop-shadow tuning, print stylesheet (`@media print { .netra-orb { display: none; } }`).

---

## 7. client.js — function catalogue

The controller is a single ~2932-line function passed to `api.controller`. AngularJS injects `$scope`, `$timeout`, `$window`. The scope alias `c` is `$scope.c` and is what the template binds against.

### 7.1 Boot phase (lines 1–470)

| Function / variable | Lines | Purpose |
|---|---|---|
| Top-of-file scope init | 1–105 | Sets `c.version`, `c.state = 'dormant'`, default flags (`c.dev`, `c.alert`, `c.conversationOpen`), Web-Speech-API availability check, default voice config, screenshot pendings. |
| Voice ring constants | 109–123 | 24-element `VOICE_RING_MULTIPLIERS`, base radius 58, precomputed `VOICE_RING_SIN`/`COS` arrays, `_lastVoiceRingLevel` change-detection cache. |
| `_recomputeVoiceRing()` | 124–137 | Rebuilds `c.voiceRingPoints` whenever `c.audioLevel` changes. Skips work if level unchanged (cheap guard for the 60 fps rAF loop). |
| `loadTrainingData()` | 166–209 | Reads `c.data.training` (filled by server initial-load), migrates legacy R2.2 localStorage if present, populates `c.personalVocab` + `c.aliases`. |
| `saveTrainingData()` | 212–242 | Debounced 2.5 s; snapshots vocab+aliases, fires `c.server.update({action:'save_training'})`. Guard `_saveInflight` prevents overlap. |
| `_refreshTrainingViews()` | 247–256 | Recomputes `c.aliasList`, `c.vocabCount`, `c.aliasCount` for the dev panel. |
| `applyAliases(text)` | 259–271 | Word-boundary replace using `c.aliases` ("net rah" → "Netra"). |
| `learnFromTranscript(t)` | 275–288 | Bumps `c.personalVocab[word].count` for every word in a successful command. |
| `_scoreAlternative(t, c)` | 291–306 | Reranks top-5 SpeechRecognition alternatives by vocab overlap. |
| `pickBestAlternative(alt)` | 309–323 | Picks the highest-scoring alt + applies aliases. |
| `c.addTrainingWord`, `c.addAlias`, `c.clearTraining` | 326–381 | Dev-panel handlers. |

### 7.2 Telemetry (lines 383–478)

| Function | Lines | Purpose |
|---|---|---|
| `_statsTick()` | 383–391 | Periodic refresh of `c.charts.toolCalls` count. |
| `_seriesToPath(series, scale)` | 393–402 | Builds an SVG `<path d>` string from a numeric array for the dev-panel mini-charts. |
| `_pushConfidence(c)` | 404–413 | Appends to `c.charts.confSeries`, recomputes min/max/last for the dev panel. |
| `_pushLatency(ms)` | 415–427 | Same for latency. |
| `_countTool(name)` | 429–470 | Increments per-tool call counter; drives the heat-map breakdown in the dev panel. |

### 7.3 Conversation surface (lines 482–530)

| Function | Lines | Purpose |
|---|---|---|
| `openConversation(reason)` | 482–488 | Sets `c.conversationOpen = true` (renders chat overlay). |
| `closeConversation()` | 489–495 | Hides the overlay. |

### 7.4 Wake-word and intent matching (lines 532–730)

| Function | Lines | Purpose |
|---|---|---|
| `levenshtein(a, b)` | 532–550 | Edit-distance for fuzzy wake matching. |
| `isWakeWord(w)` / `matchesWake(text)` | 551–584 | Recognises "Netra" with up to 2 edits (handles "net rah", "metra", etc.). |
| `matchSleep(s)` / `matchExplicitWakeUp(s)` | 586–600 | Recognises "go to sleep", "stop listening" / "wake up", "are you there". |
| `matchLocal(s)` | 601–685 | Cheap local intent shortcuts that don't need Gemini: "yes"/"no" continuations, simple greetings, "thank you", "repeat that". |
| `normalizeNumbers(s)` | 686–730 | Converts spoken digit words ("zero one zero zero eight zero zero one") to compact form ("INC0008001"). |

### 7.5 Logging + permissions + mic (lines 731–921)

| Function | Lines | Purpose |
|---|---|---|
| `logEvent(level, msg)` | 731–778 | Appends to `c.log` with timestamp; trims to 100 entries; mirrors to `console.log` when dev panel open. |
| `checkMicPermission()` | 779–819 | Uses `navigator.permissions.query({name:'microphone'})`; sets `c.permission`. |
| `startMicLevelMeter()` | 820–897 | Acquires `getUserMedia({audio: {autoGainControl: false}})`, creates `_micCtx` (one AudioContext), wires `MediaStreamSource → AnalyserNode`. Starts rAF loop that writes `c.micLevel` and drives `c.audioLevel` (and the voice ring) when not speaking. Includes the 20-second health watchdog that resumes a suspended AudioContext and reacquires the mic if tracks die. |
| `stopMicLevelMeter()` | 899–921 | Tears down the rAF, disconnects nodes, releases the stream. |

### 7.6 In-tab DOM operations + screenshots (lines 922–1093)

| Function | Lines | Purpose |
|---|---|---|
| `_findAndClickButton(labelSub)` | 922–972 | Scans the current ServicePortal page DOM for a button whose visible text or `aria-label` contains the given substring (case-insensitive). Clicks and returns the matched label. |
| `c.devCaptureScreen` | 973–1002 | Uses `html2canvas` (loaded on-demand) to grab a base64 PNG of the visible viewport for `analyze_screenshot`. |
| `c.devTestMic` | 1003–1040 | One-shot SpeechRecognition cycle for diagnosing the mic without the wake-word flow. |
| `c.tap` | 1041–1093 | Click handler on the orb. Walks the state machine: dormant → idle (start recognition), idle → dormant (sleep), shrunk → idle (unshrink). |

### 7.7 Orb drag-and-drop (lines 1094–1268)

| Function | Lines | Purpose |
|---|---|---|
| `_applyOrbPosition()`, `_saveOrbPosition()` | 1094–1118 | Persist orb x/y in `localStorage.netra.orbPos`. |
| `c.dragStart`, `_onDragMove`, `_onDragEnd` | 1119–1220 | Touch + mouse-aware drag; threshold of 5 px before tap is suppressed; clamps inside the viewport. |
| `c.devDragStart`, `_onDevDragMove`, `_onDevDragEnd` | 1222–1268 | Same for the dev panel. |

### 7.8 Speech recognition lifecycle (lines 1269–1755)

| Function | Lines | Purpose |
|---|---|---|
| `tryBoot(fromTap)` | 1269–1333 | Decides whether to actually start recognition (mic permission, no current TTS, not in dragging state). |
| `startContinuous()` | 1334–1460 | Creates the SpeechRecognition instance, attaches event handlers, manages restarts on `onend` (Chrome auto-stops after ~60 s). Sets `maxAlternatives=5`. |
| `startListeningWatchdog()` | 1461–1520 | Every 8 s, if `recRunning=false` and not in `dormant`/`speaking`, restart recognition. Self-heals after silent failures. |
| `startVisibilityRecovery()` | 1521–1548 | On `document.visibilitychange`, if returning visible, force-restart recognition (Chrome kills mic in hidden tabs). |
| `sanitizeForGrammar(s)`, `compactList(arr, limit)` | 1549–1566 | Helpers for the grammar-hint string. |
| `attachGrammar(rec)` | 1567–1643 | Builds the SpeechGrammarList from `c.personalVocab` keys + ticket-number prefixes. Chrome ignores grammars but Edge respects them. |
| `processFinalTranscript(text, conf)` | 1644–1756 | Top-level dispatcher when SpeechRecognition emits a final result. Filters by `ignoreFinalsUntil`, applies aliases, picks best alternative, branches into wake/sleep/local/server. |
| `processCommand(text, conf)` | 1757–1802 | Builds the `chat` request, increments stats, calls `c.server.update()`. |
| `handleHeard(transcript)` | 1803–1933 | Post-server callback. Reads tool trace, prefetches mic state, kicks TTS, manages multi-step flows (draft, search). |

### 7.9 Text-to-speech (lines 1935–2562)

Three remote engines + one browser fallback. Cycled with the dev panel's "TTS engine" button or `c.devToggleTTS()`.

| Function | Lines | Purpose |
|---|---|---|
| `speak(text, done)` | 1935–1972 | Top-level entry. Picks engine via `c.ttsEngine` and routes. |
| `_buildHumanSSML(text, voice)` | 1973–1996 | Inserts SSML `<break>` tags at sentence ends, commas, and em-dashes for human cadence. Used by Edge TTS. |
| `attachOutputAnalyser(audioEl)` | 1997–2049 | Web Audio source-and-analyser bound to an `<audio>` element; rAF loop reads RMS and drives `c.audioLevel`. Source+analyser cached on the element to satisfy Web Audio's "createMediaElementSource at most once" rule. |
| `detachOutputAnalyser(audioEl)` | 2050–2058 | Disconnects source + analyser when the audio ends. Without this, AudioContext nodes leak across utterances. |
| `_afterTTS(userDone)` | 2060–2098 | Unified post-TTS bookkeeping: reset state, reopen conversation, restart recognition. |
| `_edgeConnectId()` | 2100–2106 | 32-hex random ID for the Edge WSS handshake. |
| `_pcmToWavBlob(b64, sr)` | 2120–2147 | Wraps Gemini's raw PCM16 in a 44-byte WAV header so `<audio>` can play it. |
| `speakGemini(text, done)` | 2148–2224 | Calls `c.server.update({action:'gemini_tts'})` → wraps PCM in WAV → plays via `<audio>` at 1.2× rate. Falls back to Edge on failure. **Lowest latency + matches Gemini's chat voice.** |
| `speakEdgeTTS(text, done)` | 2225–2354 | Opens WebSocket to `wss://speech.platform.bing.com/.../edge/v1` with the Edge hardcoded TrustedClientToken; streams SSML; assembles MP3 chunks; plays at 1.5×. Falls back to StreamElements. |
| `_edgeBlob(text, voice, cb)` | 2355–2394 | Headless variant for the filler-clip preloader. |
| `preloadFillers()` | 2395–2411 | At boot, generates short "Hmm.", "Let me see.", "Okay so.", "Right.", "Mm.", "Ahh." clips and caches their blob URLs. |
| `playThinkingFiller()` | 2412–2425 | When state hits `thinking`, plays one random filler — eliminates dead air during the Gemini round-trip. |
| `speakStreamElements(text, done)` | 2427–2493 | StreamElements REST API (free, no key). Final fallback before `speakBrowser`. |
| `speakBrowser(text, done)` | 2495–2562 | Browser's built-in `SpeechSynthesis` API. Last-resort fallback. |
| `chooseVoice()`, `pickFemaleVoice()`, `populateVoices()` | 2563–2625 | Browser-TTS voice selection: prefers female Indian-English voices, otherwise any female. |
| `unlockAudio()` | 2626–2633 | First-tap workaround for mobile autoplay restrictions; plays a 1-sample silent buffer. |
| `cue(kind)`, `tone(freqs, dur)` | 2634–2670 | Web Audio synthesised cues ("listening", "thinking", "error"). |

### 7.10 Hotkeys, polling, dev panel (lines 2671–2932)

| Function | Lines | Purpose |
|---|---|---|
| `bindHotkeys()` | 2671–2720 | Global keydown listener. `Alt+Shift+N` toggle orb, `Alt+Shift+D` toggle dev panel, `Alt+Shift+R` nuclear reset, `Space` push-to-talk while orb focused, `Esc` close conversation. |
| `startNotificationPolling()` | 2721–2749 | Every 4 s, `c.server.update({action:'poll'})`. Reads `data.notifications`, queues TTS announcements. |
| `c.toggleDev`, `c.devKey`, `c.devSendText`, … (24 dev-* methods) | 2750–2918 | Dev panel interactions: send a text command (bypass mic), force a specific TTS test, manually replay last reply, swap voice, ping the server, diagnose mic/audio/recognition state, etc. |
| `setState(s)` | 2921–2932 | State-machine setter. Updates `c.state`, derived `c.alert`, fires `_setSpeakingCue` / `_setListeningCue` audio cues. |

---

## 8. server.js — function catalogue

The server script is one IIFE that runs on every `c.server.update()` (and once at initial render). It is **scoped-app code**: it runs as `x_196061_netra_v1` and uses the cross-scope privileges declared on the application.

### 8.1 Top-level dispatch (lines 32–214)

After populating `data.user_name`, `data.has_api_key`, `data.training`, `data.vocab`, etc., it branches on `input.action`:

| Action | Lines | What it does |
|---|---|---|
| `chat` | 60–69 | `_chat(input.message, input.history)` → writes `data.response`, `data.last_trace`. |
| `poll` | 70–98 | Reads up to 5 unread `x_196061_netra_v1_notification` rows for the user → marks them spoken → returns them as `data.notifications`. |
| `save_training` | 99–118 | `_trainingWrite(input.vocab, input.aliases)` |
| `clear_training` | 119–125 | `_trainingWrite({}, {})` |
| `gemini_tts` | 126–182 | Calls `models/gemini-2.5-flash-preview-tts:generateContent` with `responseModalities=['AUDIO']` + `voiceConfig.prebuiltVoiceConfig.voiceName = input.voice`. Returns base64 PCM + mime. |
| `debug` | 183–213 | Returns `data.debug_info` with instance URL, scope, version, has_api_key, current notification count. Used by `c.devDiagnose()`. |

### 8.2 Gemini client (lines 215–503)

| Function | Lines | Purpose |
|---|---|---|
| `_chat(userMessage, history)` | 215–402 | The full chat-loop. Builds `contents` from history + the new user message (or an image inlineData if `input.image_b64` is set). Calls `_callGemini` → if the response has a `functionCall`, runs the tool via `_runTool`, appends a `functionResponse`, calls Gemini again — up to 4 nested tool turns before giving up. Sanitises the history on the way back: long tool-response bodies > 1500 chars truncated, inlineData stripped, hard cap of 60 KB on total payload. |
| `_callGemini(apiKey, model, contents, tools, sysInstruction)` | 403–457 | Wrapper around `_callGeminiOnce` with a model fallback chain: `gemini-2.5-flash` → `gemini-2.5-flash-8b` → `gemini-1.5-flash`. If the first model returns 429 or 503, retry on the next. |
| `_callGeminiOnce(apiKey, model, contents, tools, sysInstruction)` | 458–503 | One REST round-trip. Builds the body with safety filters at BLOCK_ONLY_HIGH (this is an internal corporate assistant, not consumer surface), `temperature: 0.7`, `maxOutputTokens: 512` (forces concise replies). 30-second `setHttpTimeout`. |

### 8.3 System prompt (lines 508–688)

`_systemPrompt()` returns a long string that establishes:

- Netra's identity (warm Indian-English voice, professional, briefcaps to ServiceNow context)
- The "always confirm before write" rule for `update_field`
- The "use start_record_draft instead of create_ticket" rule for multi-turn record creation
- The "use update_field for named fields, update_ticket for customer-visible comments" disambiguation
- The "use send_sidebar_message instead of send_message_to_user" rule
- The disclaimer that `analyze_screenshot` is a signal — the client will resend the same turn with `image_b64` populated
- The "never refuse to look up a colleague" rule for `lookup_user`
- The directory of voice-command shortcuts the user may say
- Brevity instructions: under 2 sentences for routine replies, never read back the whole tool output verbatim

### 8.4 Tool catalogue (lines 690–1076)

`_toolDeclarations()` returns the 56 tools below. Each is a Gemini function declaration: `{name, description, parameters}`. They are bundled into a single `functionDeclarations` array.

#### Tickets and records (15 tools)

| Name | Behaviour |
|---|---|
| `create_ticket` | Open a new incident. `short_description` required, `urgency` optional (default 3). Returns the new INC number. *(Superseded by `start_record_draft` for conversational drafting; left in for one-shot creation.)* |
| `list_tickets` | Open incidents where `caller_id = user` AND state != 7 (closed). Max 8 rows. |
| `resolve_ticket` | Sets state=6, close_code='Solved (Work Around)', close_notes from arg. |
| `update_ticket` | Appends to `comments` (customer-visible). Distinct from `add_work_note`. |
| `get_ticket_status` | Reads state, priority, assigned_to, opened_at; formats spoken summary. |
| `change_priority` | Sets `priority` (1–4). Recomputes urgency/impact via system rules. |
| `escalate_ticket` | Decrements `priority` by 1 (3→2→1, capped). |
| `assign_ticket_to_group` | Substring match on `sys_user_group.name`; sets `assignment_group`. |
| `assign_ticket_to_user` | Substring/email match on `sys_user.{name,user_name,email}`; sets `assigned_to`. |
| `list_my_problems` | Open rows on `problem` where assigned_to or opened_by = user. |
| `list_my_changes` | Open rows on `change_request` similar. |
| `list_my_requests` | Open rows on `sc_req_item`. |
| `search_incidents` | LIKE match on `short_description` across all incidents (not just user's). Max 8 rows. |
| `summarize_ticket` | Full read-out: description, state, priority, assignee, last 3 comments, last 2 work notes. |
| `list_overdue` | User's own incidents past SLA window (P1>4 h, P2>1 d, P3+>3 d). |

#### Approvals + workload (4 tools)

| Name | Behaviour |
|---|---|
| `list_approvals` | Rows on `sysapproval_approver` where `approver=user`, `state=requested`. Resolves source record per row. |
| `decide_approval` | Looks up the approval by source `ref_number`, sets state to `approved` or `rejected`. |
| `workload_summary` | Counts: open incidents (mine), open problems, open changes, RITM, pending approvals. |
| `team_workload` | For each group the user belongs to, counts open incidents in that group. |

#### Drafts + multi-turn flow (5 tools)

| Name | Behaviour |
|---|---|
| `start_record_draft` | Begins a draft for `incident` / `problem` / `change_request`. Writes `{draft: {active:true, table, fields:{}}}` into Context blob. Replies with "What's the short description?" etc. |
| `set_record_field` | Updates one field in the draft (`short_description`, `urgency`, `priority`, etc.). Tolerant of spoken forms ("high" → "2"). |
| `review_draft` | Reads back the current draft's fields. |
| `confirm_and_create` | Inserts the record on the appropriate table. Clears the draft. Returns the new number. |
| `cancel_draft` | Clears the draft. |

#### Notifications + pause (2 tools)

| Name | Behaviour |
|---|---|
| `pause_notifications` | Sets `x_196061_netra_v1.user_paused_until` preference for `hours` from now. |
| `resume_notifications` | Clears the preference. |

#### Knowledge + attachments + messaging (5 tools)

| Name | Behaviour |
|---|---|
| `search_knowledge` | LIKE match on `kb_knowledge.short_description` where `workflow_state=published`. Returns top 3 with KB number and title. |
| `list_attachments` | Rows from `sys_attachment` where `table_sys_id=<ticket-sysid>`. Returns name, size, content-type. |
| `read_text_attachment` | Fetches `/api/now/attachment/<sys-id>/file`, returns body if content-type starts with `text/` or known text extension. |
| `send_message_to_user` | Creates an incident assigned to the recipient with the message as `short_description`. Tracking-only. |
| `send_sidebar_message` | Real Sidebar Discussion: if `sys_sidebar_discussion` exists, uses it; else falls back to `live_message`/`live_group`. Detected at runtime. |

#### Watchlist + focus (4 tools)

| Name | Behaviour |
|---|---|
| `set_focus_ticket` | Writes `{focus: {number, table, ts}}` into Context. Subsequent pronouns ("it") use focus. |
| `recall_focus` | Reads back the current focus. |
| `add_to_watchlist` / `remove_from_watchlist` / `list_watchlist` | Maintain `{watchlist: [...]}` in Context. The Scheduled Job uses it to scan for changes. |

#### People + comments + notes (5 tools)

| Name | Behaviour |
|---|---|
| `lookup_user` | Substring match on `sys_user.{name,user_name,email}`. Returns up to 3 with name, email, username, title. **The description explicitly disables refusal** because this is corporate directory. |
| `add_work_note` | Appends to `work_notes` (fulfiller-visible only). |
| `tell_joke` | Returns a tech/SN joke from a small static list (only when explicitly asked). |
| `daily_briefing` | Combines counts + proactive highlights (top P1, oldest approval, watchlist activity, overdue). |
| `create_problem` / `create_change` | One-shot creators (drafts are preferred). |

#### Self-introspection + memory + vision (4 tools)

| Name | Behaviour |
|---|---|
| `list_capabilities` | Returns a categorised tour of tools (Tickets / Approvals / Knowledge / People / Voice). |
| `recall_past_conversations` | Reads `{mem: [...]}` from Context; optionally filtered by keyword. Default last 10, max 20. |
| `remember_fact` | Appends to `{facts: [...]}`. Cap of 30 facts; oldest dropped. |
| `analyze_screenshot` | **Signal-only.** The actual image arrives on the *next* turn's `input.image_b64`. The server merges it into the next contents block as `inlineData`. |

#### Web + in-tab + URL (4 tools)

| Name | Behaviour |
|---|---|
| `search_web` | DuckDuckGo Instant Answer API → fallback to Wikipedia REST. Returns up to 3 short summaries. **Free, no key.** |
| `navigate_to_record` | Writes `data.navigate_to = '/sp?id=...&table=...&sys_id=...'`; client picks it up and changes location. |
| `click_button` | Writes `data.click_button = '<label>'`; client runs `_findAndClickButton`. |
| `open_url` | Validates the URL (https only, sanity-checks the host), writes `data.open_url = {url, title}`; client tries `window.open` and falls back to a clickable response card if the popup is blocked. |
| `go_to_servicenow` | Writes `data.navigate_to = '/sp'`. |
| `update_field` | The R2.4 fix-up for `update_ticket` confusion: updates ONE field on the ticket. Confirms before write (the system prompt enforces this). Allow-list of safe fields applied server-side. |

#### Code reading (2 tools)

| Name | Behaviour |
|---|---|
| `read_script` | Searches an internal list of nine code tables (`sys_script_include`, `sys_script`, `sys_ui_script`, `sys_script_client`, `sysauto_script`, `sys_processor`, `sys_ws_operation`, `sys_script_email`, `sys_ui_action`, `sp_widget`) for a record matching `query` by name or sys_id. Returns source code (truncated 8 KB), active flag, table, description. |
| `list_scripts` | Lists scripts in one specific code table, optionally keyword-filtered. |

### 8.5 Tool dispatch (lines 1081–1209)

`_runTool(name, args)` is a switch over the 56 tool names. Most cases delegate to a `_xxx` private function. Each `_xxx` is one ServiceNow GlideRecord operation + a deterministic spoken-form reply object.

### 8.6 Domain helpers (lines 1210–2680)

Every helper below is invoked from one or more of the 56 tools. They are organised by domain.

| Function | Lines | Purpose |
|---|---|---|
| `_getIncident(num)` | 1210–1215 | GlideRecord-fetches one row by number. |
| `_changePriority(num, p)` | 1216–1223 | Validates 1≤p≤4, updates priority. |
| `_escalateTicket(num)` | 1224–1234 | Decrements priority floor 1. |
| `_assignToGroup(num, groupName)` | 1235–1250 | LIKE-matches the group name, sets `assignment_group`. |
| `_assignToUser(num, userName)` | 1251–1266 | LIKE-matches name/username/email, sets `assigned_to`. |
| `_listMyOf(table, limit)` | 1267–1287 | Generic "list open records of a table for me". |
| `_searchIncidents(query)` | 1288–1308 | Cross-user incident search by short_description. |
| `_lookupUser(query)` | 1309–1327 | Returns up to 3 matches with name, email, username, title. |
| `_listAttachments(num)` | 1328–1346 | Resolves table for the number prefix, queries `sys_attachment`. |
| `_readTextAttachment(num, name)` | 1347–1374 | Validates the content-type starts with `text/` or is a known text extension. Fetches via REST. |
| `_summarizeTicket(num)` | 1375–1401 | Composes the spoken summary. |
| `_sendMessage(recipient, message)` | 1402–1430 | Creates a tracking incident assigned to the recipient. |
| `_tellJoke()` | 1431–1457 | Static array of 12 short jokes; picks one. |
| `_normNum(s)` | 1458–1472 | Normalises spoken digit forms (returns "INC0008001" from "I N C zero zero zero eight zero zero one"). |
| `_countActiveBy(table, qStr)` | 1473–1482 | GlideAggregate COUNT helper. |
| `_dailyBriefing()` | 1483–1579 | Combines counts + proactive highlights. |
| `_workloadSummary()` | 1580–1593 | Brief counts only. |
| `_createProblem(desc, impact)` | 1594–1611 | One-shot problem creation. |
| `_createChange(desc, type)` | 1612–1628 | One-shot change creation. |
| `_listOverdue()` | 1629–1654 | SLA-based filter. |
| `_setFocusTicket(num)`, `_recallFocus()` | 1655–1693 | Context-blob focus I/O. |
| `_tableForNumber(num)` | 1694–1706 | Maps prefix → table (`INC` → `incident`, `PRB` → `problem`, …). |
| `_addToWatchlist`, `_removeFromWatchlist`, `_listWatchlist` | 1707–1756 | Context-blob watchlist I/O. |
| `_addWorkNote(num, note)` | 1757–1767 | Appends to `work_notes`. |
| `_teamWorkload()` | 1768–1822 | Per-group counts for the user's groups. |
| `_ctxLoadGr()`, `_ctxReadBlob()`, `_ctxWriteBlob(blob)` | 1823–1869 | Context-row I/O primitives. |
| `_trainingRead()`, `_trainingWrite(vocab, aliases)` | 1870–1879 | Vocab/aliases facade over Context. |
| `_draftRead()`, `_draftWrite(d)` | 1881–1890 | Draft facade. |
| `_startRecordDraft`, `_setRecordField`, `_reviewDraft`, `_confirmAndCreate`, `_cancelDraft` | 1891–1988 | The five draft tools. |
| `_sendSidebarMessage(recipient, subject, msg)` | 1989–2092 | Detects `sys_sidebar_discussion`; falls back to `live_message`+`live_group`. |
| `_listCapabilities()` | 2093–2140 | Static categorised tour. |
| `_memRead`, `_memWrite`, `_memAppend(user, netra)` | 2141–2161 | Conversation memory facade. Cap 30 exchanges. |
| `_recallPastConversations(keyword, limit)` | 2162–2188 | Filtered read of `mem`. |
| `_rememberFact(fact)` | 2189–2201 | Appends to `facts`. Cap 30. |
| `_analyzeScreenshot(question)` | 2202–2217 | Signal-only; sets a flag in `data` that the client re-submits with `image_b64`. |
| `_searchWeb(query)` | 2218–2316 | DuckDuckGo Instant Answer → Wikipedia REST fallback. |
| `_navigateToRecord(num)` | 2317–2382 | Builds the Service Portal URL, writes `data.navigate_to`. |
| `_updateField(num, field, value)` | 2383–2467 | The R2.4-hardened field setter. Inlined allow-list (UPDATE_ALLOW) and synonym map (FIELD_SYNONYM) because var-scoping in ServiceNow's scoped-app sandbox is unreliable for top-level `var`. |
| `_openUrl(url, title)` | 2468–2481 | URL hygiene + writes `data.open_url`. |
| `_goToServiceNow()` | 2482–2505 | `data.navigate_to = '/sp'`. |
| `_readScript(query)` | 2506–2570 | Iterates the inlined `TABLES` array (same scoping fix as `_updateField`), GlideRecord-fetches the first match. Returns formatted source + metadata via `_formatScript`. |
| `_formatScript(table, gr)` | 2571–2609 | Plain-text formatting for one record. Truncates source at 8 KB. |
| `_formatWidget(w)` | 2610–2627 | Same for `sp_widget` (template / client / server / SCSS in separate sections). |
| `_listScripts(table, keyword)` | 2628–2669 | Lists rows in one table, optionally LIKE-filtered. |
| `_clickButton(label)` | 2670–2689 | Writes `data.click_button`. |

### 8.7 Boot helpers (lines 2690–2816)

| Function | Lines | Purpose |
|---|---|---|
| `_getVocab()` | 2690–2782 | Builds the initial speech-recognition vocab hint list from user's recent ticket numbers + their training vocab + standard SN terms. |
| `_ensurePref()` | 2783–2799 | Creates the `x_196061_netra_v1.user_paused_until` user preference if absent. |
| `_setPauseState()` | 2800–2816 | Reads the pref → `data.paused`. |

---

## 9. Cross-cutting concerns

### 9.1 The Business Rule on incident comments

- **Name**: `Netra: notify on incident comment`
- **Table**: `incident`
- **When**: `after`, on `insert`/`update`, condition `current.comments.changes() && !current.comments.nil()`
- **Action**: inserts one row into `x_196061_netra_v1_notification` with:
  - `user`: the assignee (or caller_id if no assignee)
  - `kind`: `comment`
  - `ticket`: the incident number
  - `body`: `"New comment on Incident <phonetic-num> from <commenter>. <first-200-chars-of-comment>..."`
- The Service Portal widget's 4-second `poll` action picks up the row, marks it spoken, and feeds it to TTS.

Verified empirically (TEST-REPORT-R2-5.md): adding a comment via REST PATCH raised the notification count by exactly +1 and the spoken-form body was correctly composed.

### 9.2 The proactive Scheduled Job

- **Name**: `Netra: proactive scanner`
- **Run as**: `system`, every 3 min
- **Logic**:
  - For every user with a Context row: find incidents/RITM/CHG newly assigned to them since last scan + watchlist tickets that changed state — insert notification rows.
  - Also: find pending approvals for them.
- The Scheduled Job and the Business Rule both write into the same notification table, so the widget polls one place.

### 9.3 The TTS fallback chain

Priority order (set via `c.ttsEngine`):

1. **gemini** — `models/gemini-2.5-flash-preview-tts:generateContent` returning base64 PCM, wrapped in WAV. Same voice character as the Gemini chat reply, but costs 1 Gemini quota credit per utterance.
2. **edge** — Microsoft Edge Neural TTS over WSS (free, no key, uses Edge's hardcoded TrustedClientToken).
3. **stream** — StreamElements REST API (free, no key).
4. **browser** — `window.speechSynthesis` (always available, lower quality).

Each step falls back to the next on watchdog timeout or playback error. Gemini's 12-s watchdog and Edge's 6-s watchdog were chosen empirically from production p99 latencies.

### 9.4 Long-session stability (R2.7)

After ~10 minutes of conversation, three problems surfaced and were fixed:

1. **History payload bloat** — every turn's tool-response was appended verbatim to `contents`, eventually exceeding Gemini's 200 KB request cap. **Fix:** server-side sanitisation truncates tool-response bodies > 1500 chars, drops inlineData, and hard-caps total payload at 60 KB. On HTTP 400 from Gemini, force `data.force_history_reset = true` and the client clears history.
2. **Mic AudioContext suspension** — Chrome suspends the AudioContext in background tabs. **Fix:** the 20-s health watchdog resumes a suspended context and reacquires the mic stream if its tracks died.
3. **Mic auto-gain drift** — `autoGainControl: true` (the default) gradually attenuates the meter as Chrome adapts to ambient noise. **Fix:** explicit `{autoGainControl: false, echoCancellation: true, noiseSuppression: true}`.

The combination of these three changes made multi-hour sessions stable. The `Alt+Shift+R` nuclear reset is the last-resort manual recovery.

### 9.5 Web Audio leak (R2.9)

Each `speakXxx` function created `new Audio(url)` — a fresh element — and called `attachOutputAnalyser` on it. The analyser cache on the element (`audioEl.__netraSrc`) never matched (the element was unique), so each utterance allocated a new `MediaElementAudioSourceNode` + `AnalyserNode`. The AudioContext retained both indefinitely. **Fix:** `detachOutputAnalyser` disconnects both nodes when the audio ends; it is called from `onended` / `onerror` / `fallback` / `finish` in all three remote TTS engines.

### 9.6 Voice-ring optimisation (R2.9)

The 24-vertex polygon was rebuilt on every rAF tick (~60 fps) from both the mic loop and the output-analyser loop, even when the level was unchanged. **Fix:** `_recomputeVoiceRing` early-returns if `lvl === _lastVoiceRingLevel`; sin/cos for the 24 fixed angles are precomputed once. Both loops gained a level-change guard around the `$scope.$applyAsync()` call so a steady level doesn't churn the AngularJS digest.

### 9.7 Case-hardened violet voice ring (R2.9)

The fill is a radial gradient through deep violet (`rgba(139,61,240,0.85)`) → magenta (`rgba(190,90,235,0.55)`) → amber heat-treatment edge (`rgba(255,170,80,0.30)`) → transparent, fading away at the outer reach. The stroke is a linear gradient across the bounding box that gives the mottled multi-tone look of case-hardened steel: deep violet → bright magenta → golden amber patch → back to deep violet. The drop-shadow filter layers violet, magenta, and amber blooms.

---

## 10. Deployment topology

A single **NetraDeploymentV1** update set bundles:

- The scoped application `Netra V2 Update` (sys_scope row)
- The widget `Netra Mic` (sp_widget id=`netra-mic`) — template / client / server / SCSS
- The two Script Includes `NetraTools` and `NetraKnowledge`
- The Business Rule `Netra: notify on incident comment`
- The Scheduled Job `Netra: proactive scanner`
- The custom tables `x_196061_netra_v1_context` and `x_196061_netra_v1_notification`
- The two system properties
- The cross-scope privilege rows (`sys_scope_privilege`)
- **sp_instance rows** placing the widget on the SP index + 9 high-traffic routes (kb_home, kb_view, kb_article, sc_home, sc_category, sc_cat_item, sc_request, search, ticket)
- **sys_app_application + sys_app_module** rows that put a *Netra → Open Netra (voice)* item in the classic UI16 left-nav

To deploy in a new instance:

1. Import `update-set/NetraDeploymentV1.xml`
2. Preview, then commit
3. Set `x_196061_netra_v1.gemini_api_key` to your Gemini API key (get one free at https://aistudio.google.com/apikey)
4. The widget is auto-placed on the SP routes via the bundled `sp_instance` rows — no manual page editing needed.

That's the whole installation.

---

## 11. Placement strategy (R2.9)

### 11.1 Service Portal — cross-route availability

`sp_portal` on this platform version has **no `header` field**, so the OOB "set a global header widget on the portal" pattern is unavailable. The R2.9 approach is direct sp_instance inserts on every common page:

| Page id | Container row inserted | sp_instance row created |
|---|---|---|
| `index` (Home) | already had Netra prior to R2.9 | (existing) |
| `kb_home` | new row, order 0 | netra-mic, size_md=12 |
| `kb_view` | new row, order 0 | netra-mic, size_md=12 |
| `kb_article` | new row, order 0 | netra-mic, size_md=12 |
| `sc_home` | new row, order 0 | netra-mic, size_md=12 |
| `sc_category` | new row, order 0 | netra-mic, size_md=12 |
| `sc_cat_item` | new row, order 0 | netra-mic, size_md=12 |
| `sc_request` | new row, order 0 | netra-mic, size_md=12 |
| `search` | new row, order 0 | netra-mic, size_md=12 |

The widget's CSS uses `position: fixed`, so the size_md=12 column doesn't take any layout space — it just gives Angular a mount point. The orb floats over the viewport in the bottom-right.

**Known gap**: the `ticket` SP page uses direct-attached widgets (`Standard Ticket Header`/`Standard Ticket Tab`) that bypass the sp_container hierarchy. The standard placement pattern doesn't apply there. If a user is already inside a ticket view and wants to ask Netra something, they can navigate back to `/sp` and say "open INC...", and Netra will navigate the same tab to the ticket.

### 11.2 Classic UI16 desktop

A new `sys_app_application` row titled **Netra** is created, with a `sys_app_module` titled **Open Netra (voice)** that has `link_type=URL` pointing at `/sp`. This puts a clickable entry in the classic UI16 left-nav that launches the Service Portal view (where the orb lives) in the main navigator iframe.

A second module **About Netra** points at `/sp?id=kb_article&sys_id=netra-overview` for orientation docs.

---

## 12. The violet voice ring — why SVG filters, not CSS (R2.9)

The case-hardened violet glow on the voice ring is implemented as **two SVG `<filter>` definitions** (`#netra-violet-glow` and `#netra-violet-glow-speaking`) in `template.html`, applied to the polygon via the `filter` attribute (bound with `ng-attr-filter` so it swaps between the two variants on state change).

**Why not pure CSS?** The ServiceNow SP widget SCSS compiler silently strips multi-`drop-shadow()` chains from the `filter` property, even on a single line, even when each color is rgba() or hex. The R2.9 cycle confirmed this empirically: the source CSS `filter: drop-shadow(...) drop-shadow(...) drop-shadow(...)` lands in storage intact but the runtime computed-style shows only `transition: ...; ` with the `filter:` declaration dropped.

SVG `<filter>` primitives (feGaussianBlur, feFlood, feComposite, feMerge) are SVG-native and bypass the CSS path entirely. The idle filter has three layered Gaussian blurs (violet at stdDev=1.5, magenta at 4, amber at 8). The speaking variant adds a fourth deep-violet halo at stdDev=18 and bumps the inner opacities.

The stroke colour itself uses a linear gradient (`#netra-voice-stroke-gradient`) with six stops (deep violet → bright violet → magenta → amber heat-treatment patch → violet → deep violet), giving the mottled multi-tone look of case-hardened steel.

---

## 13. Memory model (R2.9 update)

- **Cap**: 100 conversation turns per user (was 40 in R2.7).
- **Storage**: `x_196061_netra_v1_context.last_utterance`, max_length raised from 32,000 to **250,000** characters via `sys_dictionary` PATCH.
- **Per-entry caps**: user message ≤ 240 chars, Netra reply ≤ 480 chars (unchanged). Worst-case 100 turns × ~775 chars = ~77,500 — well within the new column size.
- **Safety truncate in `_ctxWriteBlob`**: if the serialised blob exceeds 250,000 chars (e.g. very long replies stored), the function drops the oldest 25% of mem entries until it fits. This protects against unanticipated growth (e.g. if vocab/aliases/draft balloon).
- **Recall**: `_recallPastConversations` now caps the response at 50 exchanges (was 20).

---

## 14. Refactor research notes (R2.9)

OOB Script Include / API alternatives considered and the empirical decision for each:

| Candidate | OOB alternative | Live test result | Action |
|---|---|---|---|
| `NetraKnowledge.search` (LIKE on short_description + text) | `IR_AND_OR_QUERY=<term>` against `kb_knowledge` (Zing indexed text search) | On this dev's 1-article KB, LIKE returned in 0.84s; Zing returned in 5.09s (index warm-up overhead). LIKE wins on small datasets; Zing dominates at scale. | **No change.** Document the tradeoff and revisit when KB > ~500 articles. |
| `_readTextAttachment` | `GlideSysAttachment.getContent(gr)` | Already in use since R2.4. | No change needed. |
| `_countActiveBy` | `GlideAggregate.addAggregate('COUNT')` | Already in use. | No change needed. |
| `_callGemini` recursion | None — external LLM call, no OOB equivalent | n/a | No change. |

The R2.9 simplify pass earlier in the cycle had already addressed the in-code optimisation opportunities (Web Audio leak, voice-ring recompute, mic-loop digest churn, dead static halo scale, narrative comments). After that pass, the remaining "refactor for performance" candidates are mostly OOB API swaps — and as the table shows, the obvious swap (LIKE → Zing) was the wrong choice for this dataset. **Always test before swapping.**

---

## 15. R2.9.1 deltas (the most recent layer)

| Change | Reference |
|---|---|
| Voice-ring FILL polygon gains the SVG violet-glow filter via `ng-attr-filter` | `template.html:362` |
| Radial-gradient stops boosted (0.95/0.80/0.55/0.35 alphas) | `template.html:265-275` |
| Fill opacity raised (0.45→0.70 idle, 0.78→0.95 speaking) | `stylesheet.scss` `.netra-voice-ring-fill` rule |
| State-aware voice-ring base+spike (BASE=58 idle, 74 speaking; SPIKE=1.0 idle, 1.75 speaking) | `client.js:116-149` `_recomputeVoiceRing()` |
| Output RMS gain raised (`rms * 320` → `rms * 520`) so soft TTS still drives a strong ring | `client.js:2063` (inside `attachOutputAnalyser`) |
| `attachOutputAnalyser` moved BEFORE `audio.play()` in all three engines (root cause of "aura didn't expand" — MediaElementSource was binding after routing) | `client.js:2204` (gemini), `:2348` (edge), `:2502` (stream) |
| State flip to `speaking` moved before `attachOutputAnalyser` in StreamElements so first tick uses speaking-state base | `client.js:2498-2501` |
| Filler phrase list 6 → 18 entries | `client.js:2429` `FILLER_PHRASES` |
| Server `COMMON_VOCAB` constant seeded into `_getVocab` (record actions + IT terms + Netra verbs) | `server.js:2700-2727` |
| Speech-recognition grammar threads dynamic `<common>` rule | `client.js:1606+` `attachGrammar()` |
| Five new local intents: repeat, where am I, quiet, faster/slower, praise | `client.js:687-720` extension of `matchLocal()` |
| Memory cap 40 → 100 with safety truncate | `server.js:2157` `MEM_CAP = 100` + `:1856` `_ctxWriteBlob` safety loop |
| Context column `last_utterance` max_length 32000 → 250000 | `sys_dictionary` PATCH (one-shot via `sys_dictionary/9dc1719b93f00350936af0a75d03d682`) |

---

## 16. Appendix A — additional diagrams

### A.1 Voice-ring rendering pipeline

```mermaid
flowchart LR
    A[mic stream<br/>Web Audio AnalyserNode] -->|rAF tick @60fps| B[rms math<br/>level = min 100, round rms*300]
    A2[output audio element<br/>via MediaElementSource] -->|rAF tick @60fps| B2[rms math<br/>level = min 100, round rms*520]
    B -->|state !== speaking| C[c.audioLevel = level]
    B2 -->|state === speaking| C
    C --> D[_recomputeVoiceRing]
    D -->|skip if level + state unchanged| D
    D --> E[24 vertices computed<br/>base 58 idle / 74 speak<br/>spike multiplier 1.0 / 1.75]
    E --> F[c.voiceRingPoints]
    F -->|ng-attr-points| G[fill polygon<br/>filter=netra-violet-glow]
    F -->|ng-attr-points| H[stroke polygon<br/>filter=netra-violet-glow-speaking when speaking]
    G --> I[Browser renders SVG]
    H --> I
```

### A.2 TTS engine fallback chain

```mermaid
flowchart TD
    Start[speak text, done called] --> Pick{c.ttsEngine?}
    Pick -->|gemini| G[speakGemini<br/>client.js:2195]
    Pick -->|edge| E[speakEdgeTTS<br/>client.js:2275]
    Pick -->|stream| S[speakStreamElements<br/>client.js:2486]
    Pick -->|browser| BR[speakBrowser<br/>client.js:2556]
    G -->|12s watchdog OR HTTP error| E
    G -->|success| DONE[_afterTTS]
    E -->|6s watchdog OR WSS error| S
    E -->|success| DONE
    S -->|4s watchdog OR audio error| BR
    S -->|success| DONE
    BR -->|always succeeds<br/>or silently fails| DONE
    DONE --> AfterTTS["_afterTTS:<br/>setState idle<br/>detachOutputAnalyser<br/>restart recognition<br/>open conversation"]
```

### A.3 Server action dispatcher decision tree

```mermaid
flowchart TD
    Start["c.server.update body"] --> ReadAction["read input.action"]
    ReadAction --> Init["Always: populate<br/>data.user_name, data.has_api_key,<br/>data.training, data.vocab"]
    Init --> Branch{action?}
    Branch -->|chat| Chat[_chat user message + history<br/>server.js:215]
    Branch -->|poll| Poll["Read up to 5 unread<br/>x_196061_netra_v1_notification rows<br/>Mark spoken, return as data.notifications"]
    Branch -->|save_training| ST["_trainingWrite vocab, aliases<br/>server.js:1883"]
    Branch -->|clear_training| CT["_trainingWrite empty empty"]
    Branch -->|gemini_tts| GT["POST to gemini-2.5-flash-preview-tts<br/>responseModalities=AUDIO<br/>Return base64 PCM + mime"]
    Branch -->|debug| DBG["Return data.debug_info"]
    Branch -->|none initial load| End[Done]

    Chat --> CallGemini["_callGemini<br/>server.js:403"]
    CallGemini --> ToolCall{Gemini returns functionCall?}
    ToolCall -->|yes| RunTool["_runTool name, args<br/>server.js:1081"]
    ToolCall -->|no| Reply["data.response = text"]
    RunTool --> Domain["Domain helper<br/>server.js: _summarizeTicket<br/>_listMyOf<br/>_updateField etc"]
    Domain --> AppendResult["Append functionResponse<br/>to contents"]
    AppendResult --> CallGemini
    Reply --> MemAppend["_memAppend user reply<br/>server.js:2159"]
    MemAppend --> End
```

### A.4 Memory and Context lifecycle (per request)

```mermaid
sequenceDiagram
    participant Client as client.js
    participant Server as server.js
    participant CtxTbl as x_196061_netra_v1_context

    Note over Server: every action runs this on entry
    Server->>CtxTbl: _ctxLoadGr() — GlideRecord by user
    CtxTbl-->>Server: row with last_utterance
    Server->>Server: _ctxReadBlob() — parse CTX: prefix + JSON

    Note over Server: action handlers may mutate the blob
    Server->>Server: _draftWrite() / _memAppend() / _trainingWrite()
    Server->>Server: _ctxWriteBlob() — re-serialise

    alt blob > 250 000 chars
        Server->>Server: drop oldest 25% mem entries until fits
    end

    Server->>CtxTbl: gr.update() — atomic write
    Server-->>Client: response with last_trace + tool args
```

---

## 17. Out-of-scope notes

These were considered and explicitly deferred:

- **PDF/binary attachment reading** — would require a PDF text-extraction library inside the scoped sandbox. Out of scope.
- **Streaming chat reply** — Gemini supports streaming, but Service Portal's `c.server.update()` round-trip is one-shot. Adding streaming would require a separate WebSocket or SSE path. Out of scope.
- **Cross-tab control** — `click_button` and `navigate_to_record` only operate on the current ServicePortal tab. Out of scope.
- **Microphone biometrics** — voice-ID for user authentication is a future direction.
- **Standard Ticket SP page** — uses direct-attached widgets bypassing the sp_container hierarchy; Netra is not auto-placed there. Workaround: navigate to `/sp` first and say "open INC..." — Netra routes the tab.
- **OOB indexed knowledge search** — `IR_AND_OR_QUERY` against `kb_knowledge` would dominate on large KBs but is slower than LIKE on the current 1-article dataset; deferred until KB > ~500 articles.

---

*This document supersedes all prior TDD-Rx.md files. Generated 2026-05-18 alongside NetraDeploymentV1.*
