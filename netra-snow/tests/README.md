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
| `audit-server-G-semantic-orders-plans.test.js` | standing orders arm only the resolved ticket, state and priority that were read back, on a fresh yes; the debrief speaks every report and the true count; a plan is never silently replaced and its undo never overwrites a later change; "nothing similar" only after every ticket was compared |
| `audit-si-automation.test.js` | standing orders never lower a priority, put a missed priority lever back, end on closed tickets, chase the owner's own approvals past quiet hours, obey the kill switch on undo; work notes reach fulfillers only; true outage-radar and assignment alerts; installer keeps admin-set properties |
| `missions.test.js` | a queue mission launched on a yes, reviewed with embeddings only, applied with re-reads, human-routed tickets left alone, undone |
| `audit-si-semantic-missions.test.js` | missions only for users who may work the queue; priority only raised and read back first; votes by group sys_id; failed, partial and mid-apply changes spoken; a cold ticket memory said to be cold |
| `engines.test.js` | quota governor, missions and semantic-search harnesses |
| `audit-client-A.test.js` | a "no, I said X" while a read-back waits reaches the server, and "I said X" runs X; the Lab NLP test says it is live and never leaves speech muted; ticket numbers keep their spacing through the real router; "speak slower/faster" and "quiet" do what they say; no key boots into basic mode; the boot mic check lets skips and commands through and never sticks; o'clock and real ordinals |
| `audit-client-C.test.js` | notifications and reminders never talk over the user, the mic check, a turn in flight or a read-back waiting for its yes, and a reminder counts as said only once heard; a stop before the audio starts is never followed by the stale reply through a fallback voice (StreamElements, Edge without MediaSource, Gemini), and Edge's closing socket is not a failure; a long reply that is still playing is not cut off by the watchdog; TTS never rides the mic's audio context; a destroyed page stops listening, polling, speaking and hotkeys, and a new one retires the old |
| `audit-server-A-core.test.js` | a yes said before a reply was heard confirms nothing; model replies end on the draft's own read-back; writes asked for after reading other people's text wait for a heard yes; notifications are delivered only once spoken; history cuts keep tool calls with their responses; partial answers name every write; the digest keeps the oldest prompts; the voice tag does not pick the model |
| `audit-server-H-learning-misc.test.js` | update_field writes the group, person or CI the user meant, on the right urgency/priority scale, and leaves an undo; a button is pressed only when it can be told apart; script narration reads the real code, admins only; approval triage names real records with true totals; build_query accepts the helpers it teaches, on ticket tables only; a stopped plan needs a fresh yes |
| `audit-server-B-fastlane.test.js` | undo reaches only the latest write, says its age and never clobbers a later edit; the debrief speaks every report; spoken numbers parse exactly; investigations respect ACLs; partial answers name every write; board, "pardon" and "read the rest" keep a yes answerable; true timing facts |

CI runs the suite on every push and pull request that touches `netra-snow/`
(`.github/workflows/netra-tests.yml`).
