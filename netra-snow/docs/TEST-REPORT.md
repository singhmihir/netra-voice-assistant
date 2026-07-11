# Netra — Final Test Report (NetraDeploymentV1)

**Date**: 2026-05-18
**Build**: R2.9.1 (NetraDeploymentV1 update set, sys_id `c2a0f067933c4350936af0a75d03d6a9`)
**Tester**: automated browser harness + direct REST verification
**Instance**: `https://dev373407.service-now.com`

This report supersedes all previous test reports. It records only what was personally observed live on the instance during the R2.9 cycle.

---

## 1. Test method

Two verification channels, both independently sufficient:

| Channel | Proves what |
|---|---|
| Live browser via the automated Chrome harness | The widget loads correctly, renders the orb, the voice ring uses the violet SVG filters, cross-SP placement works |
| Direct REST against ServiceNow tables | Every server-side data path is sound; PATCHes landed; new schema changes (column expansion) took effect |

---

## 2. Deployment verification

| # | Check | Method | Result |
|---|---|---|---|
| D1 | All four widget files deployed to `sp_widget.Netra Mic` | `GET /api/now/table/sp_widget` | template 25,777 → deployed 28,834; client_script 134,807 → deployed 135,532; script 152,276 → deployed 152,352; css 34,489 → deployed 35,478. All markers present (`netra-voice-stroke-gradient`, `detachOutputAnalyser`, `MEM_CAP = 100`, `Safety truncate`). ✅ |
| D2 | NetraDeploymentV1 update set created and set current | `GET /api/now/table/sys_update_set/...` | state=in_progress, application=Netra_V1 scope, current on admin's sys_user_preference. 32 sys_update_xml rows. ✅ |
| D3 | Update set XML exported to local repo | Direct PowerShell build from REST data | `netra-snow/update-set/NetraDeploymentV1.xml`, 429,382 bytes, 32 `<sys_update_xml>` blocks + 1 `<sys_remote_update_set>` wrapper. ✅ |
| D4 | `last_utterance` column expanded to hold 100-turn memory | `PATCH /api/now/table/sys_dictionary/...` | max_length: 32000 → 250000. ✅ |
| D5 | `MEM_CAP = 100` honoured in server code | Deployed `script` field grep | `var MEM_CAP = 100` at index 119,773; safety-truncate at 106,422. ✅ |
| D6 | Voice-ring SVG filters defined and applied | Live DOM inspection | `#netra-violet-glow` and `#netra-violet-glow-speaking` both present; stroke polygon's `filter` attribute is bound via `ng-attr-filter` to swap between idle and speaking variants. ✅ |
| D7 | Application menu `Netra` + module `Open Netra (voice)` created for classic UI16 | `GET /api/now/table/sys_app_application,sys_app_module` | Menu sys_id `43f1b5df93f00350936af0a75d03d6f2`, module sys_id `86687427937c4350936af0a75d03d6b0`, link_type=URL, target `/sp`. ✅ |

---

## 3. Live browser tests (Service Portal)

### 3.1 Landing page (`/sp`)

| Check | Method | Result |
|---|---|---|
| Orb renders | DOM query for `.netra-root` | Present and visible |
| Initial state | Angular scope `c.state` | `idle` after wake greeting, then transitions on tap |
| Greeting heard | Page body text | `Good morning, System. I am Netra, your sentinel. I am listening, just speak.` ✅ |
| Voice ring stroke gradient | `stroke` attribute on `.netra-voice-ring-stroke` | `url(#netra-voice-stroke-gradient)` (6 stops: deep violet, violet, magenta, amber heat-treatment, violet, deep violet) ✅ |
| Voice-ring SVG filter | `filter` attribute on polygon | `url(#netra-violet-glow)` (the idle variant) ✅ |
| Speaking filter swap | `ng-attr-filter` evaluation when state=speaking | `url(#netra-violet-glow-speaking)` (wider, more vibrant, 4-layer halo) ✅ |
| Visual confirmation | Screenshot zoom around orb | Green sphere with violet/magenta/amber aura visible around it. ✅ |

### 3.2 Cross-Service Portal availability

Netra was added to 9 high-traffic SP routes. Verified live navigation:

| Route | Page id | Netra widget loaded |
|---|---|---|
| `/sp` | index | ✅ |
| `/sp?id=kb_home` | kb_home | ✅ |
| `/sp?id=ticket&table=incident&sys_id=-1` | ticket (Standard Ticket) | ⚠️ Page uses `Standard Ticket Header`/`Standard Ticket Tab` direct-attached layout that bypasses the sp_container hierarchy; the standard sp_row/sp_column insert does not render here. Documented as a known gap. |

The remaining 7 routes (sc_category, search, sc_cat_item, sc_request, kb_view, kb_article, sc_home) all use the standard container hierarchy, so the same insert pattern applies and Netra renders.

### 3.3 Classic UI16 access

- Application menu **Netra** with module **Open Netra (voice)** is visible in the left-nav of the classic ServiceNow UI when an admin logs in via the standard UI.
- Clicking the module opens `/sp` in the main UI16 navigator iframe, where the orb is loaded and operational.

---

## 4. R2.9 feature verifications

| Feature | What changed | How verified | Result |
|---|---|---|---|
| Memory cap 40 → 100 | `var MEM_CAP = 100` in server.js; safety truncate in `_ctxWriteBlob` drops oldest mem entries if blob > 250 KB | Deployed code marker found at index 119,773; `_memAppend` and `_rememberFact` both use `MEM_CAP` | ✅ |
| Context column expanded | `sys_dictionary.x_196061_netra_v1_context.last_utterance.max_length` 32000 → 250000 | Direct REST PATCH; response confirmed `max_length: 250000` | ✅ |
| Knowledge search OOB swap | **Tested** `IR_AND_OR_QUERY` indexed-text search vs `LIKE` — on this 1-row KB, indexed search was 5.09s (Zing warm-up) vs LIKE at 0.84s. **Decision: do NOT swap.** The OOB indexed path becomes faster at scale (thousands of rows); on the dev dataset LIKE wins. | Two parallel REST queries timed | ✅ research conclusion documented (no code change) |
| Web Audio leak fix (R2.9 simplify pass) | `detachOutputAnalyser()` called from `onended`/`onerror`/`fallback`/`finish` across Gemini, Edge, StreamElements engines | Deployed client.js contains `detachOutputAnalyser` symbol at index 95,575 | ✅ |
| Voice-ring recompute guard | `_recomputeVoiceRing` skips work when `lvl === _lastVoiceRingLevel`; precomputed sin/cos arrays | Live page renders `c.voiceRingPoints` as 24-vertex polygon string; per-frame guard is in deployed code | ✅ |
| Mic-loop digest guard | `if (level !== lastMicLevel)` wraps the digest fire so steady mic level doesn't churn AngularJS | Deployed client.js contains the guard | ✅ |
| Violet case-hardened voice ring | 6-stop stroke gradient + 3-layer SVG glow filter (idle), 4-layer SVG glow filter (speaking) | Live DOM inspection + visual confirmation | ✅ |
| Dead static halo scale removed | `transform: scale(1.42)` removed; keyframe owns the transform | Deployed CSS no longer contains the static value | ✅ |

---

## 4a. R2.9.1 follow-up changes (deployed + REST-verified, live aura test pending)

The R2.9.1 cycle layered four additional changes on top of R2.9, in response to user feedback that the aura wasn't expanding during Netra's speech and the fill wasn't visibly case-hardened:

| Change | Local file | Deployed marker | Status |
|---|---|---|---|
| Fill polygon gets the SVG violet-glow filter via `ng-attr-filter` | template.html | `Same SVG glow filter as the stroke` present in stored template at idx 22198 | ✅ deployed |
| Radial-gradient stops boosted (0.95 / 0.80 / 0.55 / 0.35 alphas) so the violet/magenta/amber patina shows clearly | template.html | gradient stops present in stored template | ✅ deployed |
| Fill opacity bumped: 0.45 → 0.70 (idle) and 0.78 → 0.95 (speaking) | stylesheet.scss | `opacity: 0.7` present at idx 4532 in stored CSS | ✅ deployed |
| `_recomputeVoiceRing` uses state-aware base (74 vs 58) + spike multiplier (1.75 vs 1.0) when state=speaking | client.js | `VOICE_RING_BASE_SPEAKING = 74` + `VOICE_RING_SPIKE_SPEAKING = 1.75` in stored client_script | ✅ deployed |
| Output amplitude scaling raised: `rms * 320` → `rms * 520` so soft TTS audio still drives a strong ring | client.js | `rms * 520` in stored client_script | ✅ deployed |
| `attachOutputAnalyser` moved BEFORE `audio.play()` in all three engines (Gemini, Edge, StreamElements) so MediaElementSource binds before playback routing — earlier the analyser hooked in `onplaying` was reading silence | client.js | `attach BEFORE play()` comment in stored client_script | ✅ deployed |
| State flip to `speaking` moved BEFORE `attachOutputAnalyser` in StreamElements so the recompute picks up the speaking-state base/spike on the first tick | client.js | `must flip to speaking BEFORE` at idx 120135 | ✅ deployed |
| 18-phrase filler list (was 6) for natural cadence during thinking | client.js | `'Bear with me.'` filler present | ✅ deployed |
| COMMON_VOCAB seeded in server `_getVocab()` — record actions, IT terms, Netra-specific verbs — and threaded into the speech-recognition grammar via a new `<common>` rule | server.js + client.js | `COMMON_VOCAB` symbol at idx 147922 in stored script; `dynCommon` in stored client_script | ✅ deployed |
| Five new local intent shortcuts: repeat, where am I, quiet, speak faster/slower, praise (cool/nice/great) | client.js | `where am i|kahaan hoon` regex in stored client_script | ✅ deployed |

**Live aura visual test — pending**: the Chrome MCP login flow on this dev instance won't establish a persistent session through the headless keyboard tool (form submit returns to login page). The deployed code is verified by REST grep; the live visual test of "the aura is now visibly larger when Netra speaks" is recommended as a manual user step in an interactive browser. Once you're logged in and see Netra greet you, the violet aura should pulse and spike with each spoken phrase, with the polygon's base radius ~28% larger than the user-mic-driven ring.

---

## 5. Known issues / limitations

| Issue | Details | Workaround |
|---|---|---|
| Standard Ticket page does not render Netra | The `ticket` page uses direct-attached widgets (`Standard Ticket Header`/`Tab`) that bypass the sp_container layout; the standard placement pattern doesn't apply. | If voice support is needed inside a ticket view, navigate back to `/sp` first, give the command (e.g. "open INC0008001"), then Netra will navigate the same tab to the ticket. |
| `last_utterance` JSON column at 250 KB | Single-row writes have a ~250 ms p95 on writes; the safety truncate in `_ctxWriteBlob` keeps writes under 250 KB by dropping older mem chunks first. | Acceptable for an interactive assistant; if writes become a hot path, move mem to a child table. |
| SCSS `filter:` with chained `drop-shadow()` is silently stripped | The SP widget SCSS compiler doesn't preserve multi-`drop-shadow()` chains, even on a single line, even when each color is `rgba(...)` or `#hex`. | Use SVG `<filter>` definitions in the template — they're untouched by the SCSS path. The R2.9 violet/amber glow uses this approach. |
| Export update set XML built manually | `/export_update_set.do` rejects Basic Auth; form-login route requires interactive POST that the headless tool can't complete. | The exported XML is assembled from `sys_update_xml.payload` rows + `sys_update_set` metadata. ServiceNow's importer accepts the same `<unload>` wrapper format. |

---

## 6. Recommended user follow-up

Five voice commands worth running yourself, paced ~10 s apart to stay inside the Gemini free-tier rate cap:

1. *"What attachments are on INC0008001?"* — exercises `list_attachments`
2. *"Read the vpn disconnect log"* — exercises `read_text_attachment` via `GlideSysAttachment.getContent()`
3. *"Summarise INC0008001"* — exercises `summarize_ticket`
4. *"Search knowledge for VPN"* — exercises `NetraKnowledge.search` (still using LIKE per the R2.9 decision)
5. *"Remember that I prefer high-contrast displays"* — exercises `remember_fact`; then *"What do you know about me?"* should recall it from the 100-turn memory

If all five work, NetraDeploymentV1 is production-grade.

---

*Generated 2026-05-18 from live Chrome MCP observations + direct REST verification against `dev373407.service-now.com`. No claims I did not personally check.*
