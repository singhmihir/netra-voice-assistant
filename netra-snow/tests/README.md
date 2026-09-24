# Netra tests

```
node netra-snow/tests/run.js            # everything, ~2 seconds
node netra-snow/tests/run.js confirm    # just the files whose name contains "confirm"
```

No ServiceNow instance, no Gemini key, no npm install. The suite runs the
**real** widget server script, client controller and script includes under
node:

- `lib/glide.js` is a small in-memory ServiceNow: GlideRecord (with table
  inheritance, so `task` returns incidents), GlideAggregate, GlideDateTime
  (with a 12-hour user display format, the one that used to break clock
  times), `gs`, `Class`, `sn_ws`. Anything a query uses that it does not
  understand is recorded in `P.UNSUPPORTED` instead of silently matching.
- `lib/netra.js` loads the code. The widget server script is one IIFE whose
  router runs first; the loader injects a hook just before the router that
  exports every function, so tests see the same hoisting behaviour a live
  chat turn does. `request(input)` runs a whole widget request through the
  real router.
- `lib/gemini.js` is a scripted model: a test queues exactly what the model
  replies, and every generate call is counted - so "this costs zero calls"
  is an assertion, not a hope.
- `lib/session.js` is a conversation the way the page has it: each turn is a
  fresh request carrying the client-side history, on a small seeded instance
  (users, groups, incidents, a platform rule that derives priority from
  impact x urgency).

| File | What it protects |
|---|---|
| `confirm-gate.test.js` | a "yes" only runs what was just read back, in the next turn; stale, auto-turn, multi-draft, partial-answer and plan cases; plan undo |
| `routing.test.js` | which utterances the zero-call fast lane answers and which go to the model; basic mode without a key |
| `investigation.test.js` | evidence first, one model call, invented facts dropped, thin-evidence honesty, CI-vs-ticket guards |
| `audit-si-investigator.test.js` | a change being worked when the trouble began is a suspect, a later fix is not; no "first ticket" when there is none; grading reads the blamed change and negations; the watch reports only new resolutions and real rollbacks; true neighbour counts; no clock in broadcasts; the user's ACLs on tickets, notes and audit |
| `permissions.test.js` | Netra acts with exactly the user's permissions (ACLs via GlideRecordSecure, VR tools only for VR roles); approvals need a heard read-back even when a subject tries to instruct the model; resolve never re-resolves and undo restores notes |
| `records.test.js` | who a message really reached, true attachment/SLA/CI/approval counts, current KB versions, reminder cancels, real field names, change journals |
| `selfcheck.test.js` | the self-check finds and explains a stopped scanner, a rejected key, overdue orders, thin memory, switched-off writes |
| `speech.test.js` | spoken ticket numbers, sys_id tails, dates and clock times |
| `client.test.js` | the page's local replies never swallow an awaited answer; "repeat" replays the real reply |
| `static.test.js` | everything parses, no secrets ship, the hoisting trap stays closed, every declared tool has a handler, installer/packager know every script include |
| `away.test.js` | standing orders armed on a yes, fired by the real background runner, debriefed and undone by number; human edits and the kill switch stop them |
| `missions.test.js` | a queue mission launched on a yes, reviewed with embeddings only, applied with re-reads, human-routed tickets left alone, undone |
| `engines.test.js` | quota governor, missions and semantic-search harnesses |

CI runs the suite on every push and pull request that touches `netra-snow/`
(`.github/workflows/netra-tests.yml`).
