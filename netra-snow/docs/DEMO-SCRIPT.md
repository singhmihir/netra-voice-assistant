# Netra R5 — 7-Minute Demo Script

A tight, rehearsable storyline for demoing Netra as a **vulnerability-analyst
copilot** for ServiceNow. Written to be spoken aloud into the mic, with the
expected response and recovery lines when speech mis-hears.

> Audience: Deloitte MD. Goal: show a polished, real-time voice experience that
> does genuine analyst work end-to-end on a live ServiceNow instance.

---

## Pre-demo checklist (do this 10 minutes before)

- [ ] **Browser**: Chrome (or Edge), on the Service Portal page hosting the Netra Mic widget, HTTPS, mic permission granted. Close other tabs using the mic.
- [ ] **API key**: `x_196061_netra_v1.gemini_api_key` set. Say *"debug"* in the dev panel → `api_key_status: configured`, version `v8.0 (R5)`.
- [ ] **Roles**: the demo account has `sn_vul.vulnerability_analyst` (+ `admin` for the instance-health cameo).
- [ ] **Data**: Vulnerability Response has vulnerable items with a spread of risk scores, at least one Log4Shell (CVE-2021-44228) cluster, and a couple assigned to you. If the instance is thin, run a VR scan or load sample VITs first.
- [ ] **Quiet room / headset**: reduces mis-hears. Netra ignores its own TTS, but background chatter can still trip recognition.
- [ ] **Fallback**: the dev panel's typed-command box mirrors voice exactly — if the room is loud, type the same commands. Nobody can tell from the responses.

**Universal recovery line:** if Netra mishears, just say *"Netra, stop"* then repeat the command. To re-arm after a pause, say *"Netra, are you there?"*

---

## The run

### 0. Wake (10s)
**Say:** *"Netra, are you there?"*
**Expect:** a brief spoken acknowledgement; the orb brightens to the listening state.
*Talking point:* "Everything from here is live voice against her ServiceNow instance — no scripted playback."

### 1. Exposure summary (45s)
**Say:** *"What's my vulnerability exposure right now?"*
**Expect:** open totals by risk band (critical/high/medium/low), the busiest assignment groups, and your own open count.
*Talking point:* "That's a `GlideAggregate` over the vulnerable-item table, shaped for the ear — she says 'twelve critical', not a table."

### 2. Walk the queue (60s)
**Say:** *"Walk me through my queue."*
**Expect:** the single highest-risk open item assigned to you (number, risk band, asset, CVE).
**Say:** *"Tell me more about that one."*
**Expect:** full detail — CVE summary and the recommended fix, read back in plain language.
**Say:** *"What else is affected by that CVE?"* (or *"Look up CVE-2021-44228"*)
**Expect:** advisory summary, how many active items reference it, and the worst risk score.
*Talking point:* "She's resolving 'that one' and 'that CVE' from context — this is a conversation, not a command line."

### 3. Take action, with an audit trail (75s)
**Say:** *"Assign this to the Security Operations team."*
**Expect:** confirmation. *(If two groups match, she asks which — pick one: "Security Operations.")*
**Say:** *"Actually, defer it — compensating control is in place — and set the review for ninety days out."*
**Expect:** she confirms the deferral with the reason captured.
*Show on screen:* open the vulnerable item; the **work notes** show `[Netra] Deferred (risk accepted) by <you>. Reason: … Review on <date>.`
*Talking point:* "Every voice action writes an audit note with who, what, and why. Deferrals require a reason — she refuses without one. That's the control story."

### 4. Bulk, safely (60s)
**Say:** *"Preview deferring everything for CVE-2021-44228."*
**Expect:** a count and a read-back of a few examples — *"That would affect N items…"*
**Say:** *"Go ahead — patch is scheduled for the weekend."*
**Expect:** she applies it (capped per pass, each item audited) and reports how many changed.
*Talking point:* "Bulk is always preview-first: she reads the blast radius, waits for an explicit yes, caps the batch, and audits every record. No fat-finger mass-updates."

### 5. Remediation change (45s)
**Say:** *"Raise a change to fix VIT-double-oh-oh-one" (or the number she surfaced in step 2).*
**Expect:** a new change request number, created and linked back to the vulnerable item.
*Talking point:* "Straight from the finding to a remediation change, with the CVE and recommended fix pre-filled into the change."

### 6. Reporting (45s)
**Say:** *"How are we trending this week?"*
**Expect:** opened vs closed over the last 7 days and a rough mean-time-to-remediate.
**Say:** *"What's overdue?"* (or *"Show me the aging report."*)
**Expect:** the overdue/aging breakdown.
*Talking point:* "Analyst standups in one breath."

### 7. Instance-health cameo (40s)
**Say:** *"Netra, instance health."*
**Expect:** active scheduled-job count, runs due next hour, busiest job, slow transactions, and any standing flags.
*Talking point:* "Same assistant also gives an admin a read-only performance read. And there's a companion one-shot that can safely pause non-essential jobs — with a protected list and a one-command restore — so a demo instance runs closer to fresh. That's in the runbook."

### Close (10s)
**Say:** *"Thanks, Netra."*
**Expect:** a warm acknowledgement.
*Talking point:* "Native ServiceNow, the user's own permissions, full audit trail, no paid services — and it took plain English the whole way."

---

## If something goes wrong

| Symptom | Do this |
|---|---|
| She mishears a number | *"Netra, stop."* Then say the number digit-by-digit: *"V-I-T zero zero zero one two three four."* |
| She talks over you | Press **Esc** to cut TTS, then continue. |
| "You need a Vulnerability Response role…" | The account lost its VR role — assign `sn_vul.vulnerability_analyst` and reload. |
| Long pause / "AI service is busy" | Free-tier rate limit; wait 3–4 seconds and retry. Have the typed-command fallback ready. |
| Room too loud | Switch to the dev panel typed-command box — identical behavior, invisible to the audience. |

## Timing cheat-sheet
Wake 0:10 · Exposure 0:55 · Queue walk 1:55 · Action+audit 3:10 · Bulk 4:10 · Change 4:55 · Reporting 5:40 · Instance health 6:20 · Close 6:30.
